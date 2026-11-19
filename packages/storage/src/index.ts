import { closeSync, fchmodSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  ExamDefinition,
  ExamStatus,
  ResponseValue,
  SessionStatus,
  SubmissionReason,
} from '@exam-runtime/schemas';
import Database from 'better-sqlite3';
import { migrate } from './migrations.js';

export interface ExamRecord {
  id: string;
  status: ExamStatus;
  definition: ExamDefinition;
  created_at: number;
  updated_at: number;
}

export interface SessionRecord {
  id: string;
  exam_id: string;
  status: SessionStatus;
  snapshot: ExamDefinition;
  started_at: number;
  deadline_at: number;
  submitted_at: number | null;
  submission_reason: SubmissionReason | null;
  revision: number;
}

export interface StoredResponse {
  question_id: string;
  value: ResponseValue;
  updated_at: number;
}

export interface StoredGrade {
  question_id: string;
  score: number;
  feedback?: string;
}

type ExamFilter = { status?: ExamStatus; subject?: string };
type ExamDefinitionFields = Omit<ExamDefinition, 'questions'>;
type ExamRow = Omit<ExamRecord, 'definition'> & { definition_json: string; questions_json: string };
type ExamWrite = Omit<ExamRow, 'questions_json'> & { subject: string };
type SessionRow = Omit<SessionRecord, 'snapshot'> & { snapshot_json: string };
type SessionWrite = SessionRow & { auto_submit_on_timeout: number };
type ResponseRow = Omit<StoredResponse, 'value'> & { value_json: string };
type GradeRow = Omit<StoredGrade, 'feedback'> & { feedback: string | null };

const examPredicates = {
  all: '',
  byId: 'WHERE e.id = ?',
  byStatus: 'WHERE e.status = ?',
  bySubject: 'WHERE e.subject = ?',
  byStatusAndSubject: 'WHERE e.status = ? AND e.subject = ?',
} as const;

function defaultDataHome(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && isAbsolute(xdg)) return xdg;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return join(homedir(), '.local', 'share');
}

export function databasePath(): string {
  return process.env.EXAM_RUNTIME_DB_PATH || join(
    process.env.EXAM_RUNTIME_DATA_DIR || join(defaultDataHome(), 'exam-runtime'),
    'exam-runtime.sqlite3',
  );
}

export function openStorage(filename = databasePath()): Storage {
  return new Storage(filename);
}

function openDatabase(filename: string): Database.Database {
  let path = filename.trim();
  if (path !== ':memory:' && path !== '') {
    path = resolve(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Start with private permissions before SQLite creates the WAL sidecars.
    const fd = openSync(path, 'a', 0o600);
    try {
      if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  }
  const db = new Database(path, { timeout: 5_000 });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function encodeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Storage value is not JSON serializable');
  return json;
}

function decodeJson<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (cause) {
    throw new Error('Invalid JSON in the Exam Runtime database', { cause });
  }
}

function examWrite(record: ExamRecord, definition: ExamDefinitionFields): ExamWrite {
  const { id, status, created_at, updated_at } = record;
  return { id, status, created_at, updated_at, subject: definition.exam.subject, definition_json: encodeJson(definition) };
}

function sessionWrite({ snapshot, ...row }: SessionRecord): SessionWrite {
  return {
    ...row,
    snapshot_json: encodeJson(snapshot),
    auto_submit_on_timeout: snapshot.exam.auto_submit_on_timeout ? 1 : 0,
  };
}

export class Storage {
  readonly #db: Database.Database;

  constructor(filename: string) {
    this.#db = openDatabase(filename);
  }

  close(): void {
    this.#db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn).immediate();
  }

  insertExam(record: ExamRecord): void {
    this.transaction(() => {
      const { questions, ...definition } = record.definition;
      this.#db.prepare<ExamWrite>(`
        INSERT INTO exams (id, status, subject, definition_json, created_at, updated_at)
        VALUES (@id, @status, @subject, @definition_json, @created_at, @updated_at)
      `).run(examWrite(record, definition));
      this.#insertExamQuestions(record.id, questions);
    });
  }

  updateExam(record: ExamRecord): void {
    this.transaction(() => {
      const { questions, ...definition } = record.definition;
      const { changes } = this.#db.prepare<ExamWrite>(`
        UPDATE exams SET status = @status, subject = @subject, definition_json = @definition_json,
          created_at = @created_at, updated_at = @updated_at
        WHERE id = @id
      `).run(examWrite(record, definition));
      if (changes === 0) return;
      this.#db.prepare<[string]>('DELETE FROM exam_questions WHERE exam_id = ?').run(record.id);
      this.#insertExamQuestions(record.id, questions);
    });
  }

  #insertExamQuestions(id: string, questions: ExamDefinition['questions']): void {
    const insert = this.#db.prepare<[string, string, number, string]>(`
      INSERT INTO exam_questions (exam_id, question_id, position, question_json) VALUES (?, ?, ?, ?)
    `);
    for (const [position, question] of questions.entries()) {
      insert.run(id, question.id, position, encodeJson(question));
    }
  }

  getExam(id: string): ExamRecord | undefined {
    return this.#readExams('byId', id)[0];
  }

  listExams({ status, subject }: ExamFilter = {}): ExamRecord[] {
    if (status !== undefined && subject !== undefined) return this.#readExams('byStatusAndSubject', status, subject);
    if (status !== undefined) return this.#readExams('byStatus', status);
    if (subject !== undefined) return this.#readExams('bySubject', subject);
    return this.#readExams('all');
  }

  #readExams(predicate: keyof typeof examPredicates, ...values: string[]): ExamRecord[] {
    // One statement reads both the exam fields and the ordered questions from the same snapshot.
    const sql = `
      SELECT e.id, e.status, e.definition_json, e.created_at, e.updated_at,
        (SELECT json_group_array(json(q.question_json) ORDER BY q.position)
           FROM exam_questions AS q WHERE q.exam_id = e.id) AS questions_json
      FROM exams AS e
      ${examPredicates[predicate]}
      ORDER BY e.created_at DESC, e.id
    `;
    return this.#db.prepare<string[], ExamRow>(sql).all(...values).map(({ definition_json, questions_json, ...row }) => ({
      ...row,
      definition: {
        ...decodeJson<ExamDefinitionFields>(definition_json),
        questions: decodeJson<ExamDefinition['questions']>(questions_json),
      },
    }));
  }

  insertSession(record: SessionRecord): void {
    this.#db.prepare<SessionWrite>(`
      INSERT INTO exam_sessions (id, exam_id, status, snapshot_json, auto_submit_on_timeout,
        started_at, deadline_at, submitted_at, submission_reason, revision)
      VALUES (@id, @exam_id, @status, @snapshot_json, @auto_submit_on_timeout,
        @started_at, @deadline_at, @submitted_at, @submission_reason, @revision)
    `).run(sessionWrite(record));
  }

  updateSession(record: SessionRecord): void {
    this.#db.prepare<SessionWrite>(`
      UPDATE exam_sessions SET exam_id = @exam_id, status = @status, snapshot_json = @snapshot_json,
        auto_submit_on_timeout = @auto_submit_on_timeout, started_at = @started_at,
        deadline_at = @deadline_at, submitted_at = @submitted_at, submission_reason = @submission_reason,
        revision = @revision
      WHERE id = @id
    `).run(sessionWrite(record));
  }

  getSession(id: string): SessionRecord | undefined {
    const result = this.#db.prepare<[string], SessionRow>(`
      SELECT id, exam_id, status, snapshot_json, started_at, deadline_at, submitted_at,
        submission_reason, revision
      FROM exam_sessions WHERE id = ?
    `).get(id);
    if (!result) return undefined;
    const { snapshot_json, ...row } = result;
    return { ...row, snapshot: decodeJson<ExamDefinition>(snapshot_json) };
  }

  listExpiredSessionIds(now: number, limit: number): string[] {
    return this.#db.prepare<[number, number], { id: string }>(`
      SELECT id FROM exam_sessions
      WHERE status = 'in_progress' AND auto_submit_on_timeout = 1 AND deadline_at <= ?
      ORDER BY deadline_at, id LIMIT ?
    `).all(now, limit).map(({ id }) => id);
  }

  listResponses(sessionId: string): StoredResponse[] {
    return this.#db.prepare<[string], ResponseRow>(`
      SELECT question_id, value_json, updated_at
      FROM session_responses WHERE session_id = ? ORDER BY question_id
    `).all(sessionId).map(({ value_json, ...row }) => ({ ...row, value: decodeJson<ResponseValue>(value_json) }));
  }

  putResponse(sessionId: string, response: StoredResponse): void {
    this.#db.prepare<[string, string, string, number]>(`
      INSERT INTO session_responses (session_id, question_id, value_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (session_id, question_id) DO UPDATE SET
        value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(sessionId, response.question_id, encodeJson(response.value), response.updated_at);
  }

  listFlags(sessionId: string): string[] {
    return this.#db.prepare<[string], { question_id: string }>(`
      SELECT question_id FROM session_flags WHERE session_id = ? ORDER BY question_id
    `).all(sessionId).map(({ question_id }) => question_id);
  }

  putFlag(sessionId: string, questionId: string, flagged: boolean): void {
    if (flagged) {
      this.#db.prepare<[string, string]>(`
        INSERT INTO session_flags (session_id, question_id) VALUES (?, ?)
        ON CONFLICT (session_id, question_id) DO NOTHING
      `).run(sessionId, questionId);
    } else {
      this.#db.prepare<[string, string]>(`
        DELETE FROM session_flags WHERE session_id = ? AND question_id = ?
      `).run(sessionId, questionId);
    }
  }

  getResult<T>(sessionId: string): T | undefined {
    const row = this.#db.prepare<[string], { result_json: string }>(`
      SELECT result_json FROM exam_results WHERE session_id = ?
    `).get(sessionId);
    return row === undefined ? undefined : decodeJson<T>(row.result_json);
  }

  insertResult(sessionId: string, result: unknown, createdAt: number): void {
    this.#db.prepare<[string, string, number]>(`
      INSERT INTO exam_results (session_id, result_json, created_at) VALUES (?, ?, ?)
    `).run(sessionId, encodeJson(result), createdAt);
  }

  putGrades(sessionId: string, grades: StoredGrade[]): void {
    this.transaction(() => {
      const put = this.#db.prepare<[string, string, number, string | null]>(`
        INSERT INTO question_grades (session_id, question_id, score, feedback) VALUES (?, ?, ?, ?)
        ON CONFLICT (session_id, question_id) DO UPDATE SET
          score = excluded.score, feedback = excluded.feedback
      `);
      for (const grade of grades) put.run(sessionId, grade.question_id, grade.score, grade.feedback ?? null);
    });
  }

  listGrades(sessionId: string): StoredGrade[] {
    return this.#db.prepare<[string], GradeRow>(`
      SELECT question_id, score, feedback FROM question_grades WHERE session_id = ? ORDER BY question_id
    `).all(sessionId).map(({ feedback, ...grade }) => feedback === null ? grade : { ...grade, feedback });
  }
}
