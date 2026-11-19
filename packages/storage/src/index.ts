import { closeSync, mkdirSync, openSync } from 'node:fs';
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
  agent_scope?: string;
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
  agent_scope?: string;
  current_question_id?: string | null;
  updated_at?: number;
  timeout_observed?: 0 | 1;
}

export interface ExplanationRequestRecord {
  id: string;
  session_id: string;
  question_id: string;
  agent_scope: string;
  type: 'hint' | 'detailed' | 'why_wrong';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  attempt_count: number;
  claim_owner: string | null;
  claim_hash: string | null;
  claim_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ExplanationRecord {
  id: string;
  request_id: string;
  session_id: string;
  question_id: string;
  content: {
    summary: string;
    explanation: string;
    learning_tip?: string;
    agent_metadata?: Record<string, unknown>;
  };
  completed_at: number;
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

type ExamFilter = { status?: ExamStatus; subject?: string; agent_scope?: string };
type ExamDefinitionFields = Omit<ExamDefinition, 'questions'>;
export type StoredExamRecord = Required<ExamRecord>;
export type StoredSessionRecord = Required<SessionRecord>;
export type SessionSummary = Pick<StoredSessionRecord, 'exam_id' | 'status' | 'started_at' | 'deadline_at' | 'submitted_at' | 'updated_at'> & {
  session_id: string;
};
export type SessionListFilter = { exam_id?: string; status?: SessionStatus; limit?: number };
type ExamRow = Omit<StoredExamRecord, 'definition'> & { definition_json: string; questions_json: string };
type ExamWrite = Omit<ExamRow, 'questions_json' | 'agent_scope'> & { subject: string; agent_scope: string | null };
type SessionRow = Omit<StoredSessionRecord, 'snapshot'> & { snapshot_json: string };
type SessionWrite = Omit<SessionRow, 'agent_scope' | 'updated_at' | 'timeout_observed'> & {
  timeout_observed: 0 | 1 | null;
  auto_submit_on_timeout: number;
  agent_scope: string | null;
  updated_at: number | null;
  has_current_question_id: number;
};
type ResponseRow = Omit<StoredResponse, 'value'> & { value_json: string };
type GradeRow = Omit<StoredGrade, 'feedback'> & { feedback: string | null };
type ExplanationRow = Omit<ExplanationRecord, 'content'> & { content_json: string };

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
    // Create new files with private permissions before SQLite creates the WAL sidecars.
    // The creation mode does not change the permissions of an existing database.
    closeSync(openSync(path, 'a', 0o600));
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
  return {
    id, status, created_at, updated_at, agent_scope: record.agent_scope ?? null,
    subject: definition.exam.subject, definition_json: encodeJson(definition),
  };
}

function sessionWrite({ snapshot, agent_scope, current_question_id, updated_at, timeout_observed, ...row }: SessionRecord): SessionWrite {
  return {
    ...row,
    agent_scope: agent_scope ?? null,
    current_question_id: current_question_id ?? null,
    has_current_question_id: current_question_id === undefined ? 0 : 1,
    updated_at: updated_at ?? null,
    timeout_observed: timeout_observed ?? null,
    snapshot_json: encodeJson(snapshot),
    auto_submit_on_timeout: snapshot.exam.auto_submit_on_timeout ? 1 : 0,
  };
}

function decodeExplanation({ content_json, ...row }: ExplanationRow): ExplanationRecord {
  return { ...row, content: decodeJson<ExplanationRecord['content']>(content_json) };
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

  readTransaction<T>(fn: () => T): T {
    return this.#db.transaction(fn).deferred();
  }

  insertAgent(id: string, tokenHash: string, now: number): void {
    this.#db.prepare<[string, string, number]>(`
      INSERT INTO agent_credentials (id, token_hash, created_at) VALUES (?, ?, ?)
    `).run(id, tokenHash, now);
  }

  getAgentTokenHash(id: string): string | undefined {
    return this.#db.prepare<[string], { token_hash: string }>(`
      SELECT token_hash FROM agent_credentials WHERE id = ?
    `).get(id)?.token_hash;
  }

  bumpChange(key: string): void {
    this.#db.prepare<[string]>(`
      INSERT INTO change_versions (key, version) VALUES (?, 1)
      ON CONFLICT (key) DO UPDATE SET version = version + 1
    `).run(key);
  }

  getChangeVersions(keys: readonly string[]): Map<string, number> {
    if (keys.length === 0) return new Map();
    const rows = this.#db.prepare<[string], { key: string; version: number }>(`
      SELECT key, version FROM change_versions WHERE key IN (SELECT value FROM json_each(?))
    `).all(encodeJson(keys));
    return new Map(rows.map(({ key, version }) => [key, version]));
  }

  insertExam(record: ExamRecord): void {
    this.transaction(() => {
      const { questions, ...definition } = record.definition;
      this.#db.prepare<ExamWrite>(`
        INSERT INTO exams (id, status, subject, definition_json, created_at, updated_at, agent_scope)
        VALUES (@id, @status, @subject, @definition_json, @created_at, @updated_at, coalesce(@agent_scope, 'local'))
      `).run(examWrite(record, definition));
      this.#insertExamQuestions(record.id, questions);
    });
  }

  updateExam(record: ExamRecord): void {
    this.transaction(() => {
      const { questions, ...definition } = record.definition;
      const { changes } = this.#db.prepare<ExamWrite>(`
        UPDATE exams SET status = @status, subject = @subject, definition_json = @definition_json,
          created_at = @created_at, updated_at = @updated_at, agent_scope = coalesce(@agent_scope, agent_scope)
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

  getExam(id: string): StoredExamRecord | undefined {
    return this.#readExams('WHERE e.id = ?', [id])[0];
  }

  listExams({ status, subject, agent_scope }: ExamFilter = {}): StoredExamRecord[] {
    const predicates: string[] = [];
    const values: string[] = [];
    if (agent_scope !== undefined) {
      predicates.push('e.agent_scope = ?');
      values.push(agent_scope);
    }
    if (status !== undefined) {
      predicates.push('e.status = ?');
      values.push(status);
    }
    if (subject !== undefined) {
      predicates.push('e.subject = ?');
      values.push(subject);
    }
    return this.#readExams(predicates.length ? `WHERE ${predicates.join(' AND ')}` : '', values);
  }

  #readExams(where: string, values: string[]): StoredExamRecord[] {
    // One statement reads both the exam fields and the ordered questions from the same snapshot.
    const sql = `
      SELECT e.id, e.status, e.definition_json, e.created_at, e.updated_at, e.agent_scope,
        (SELECT json_group_array(json(q.question_json) ORDER BY q.position)
           FROM exam_questions AS q WHERE q.exam_id = e.id) AS questions_json
      FROM exams AS e
      ${where}
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
        started_at, deadline_at, submitted_at, submission_reason, revision, agent_scope, current_question_id, updated_at, timeout_observed)
      VALUES (@id, @exam_id, @status, @snapshot_json, @auto_submit_on_timeout,
        @started_at, @deadline_at, @submitted_at, @submission_reason, @revision,
        coalesce(@agent_scope, 'local'), @current_question_id,
        coalesce(@updated_at, max(@started_at, coalesce(@submitted_at, @started_at))), coalesce(@timeout_observed, 0))
    `).run(sessionWrite(record));
  }

  updateSession(record: SessionRecord): void {
    this.#db.prepare<SessionWrite>(`
      UPDATE exam_sessions SET exam_id = @exam_id, status = @status, snapshot_json = @snapshot_json,
        auto_submit_on_timeout = @auto_submit_on_timeout, started_at = @started_at,
        deadline_at = @deadline_at, submitted_at = @submitted_at, submission_reason = @submission_reason,
        revision = @revision, agent_scope = coalesce(@agent_scope, agent_scope),
        current_question_id = CASE WHEN @has_current_question_id THEN @current_question_id ELSE current_question_id END,
        updated_at = coalesce(@updated_at, max(updated_at, @started_at, coalesce(@submitted_at, @started_at))),
        timeout_observed = coalesce(@timeout_observed, timeout_observed)
      WHERE id = @id
    `).run(sessionWrite(record));
  }

  getSession(id: string): StoredSessionRecord | undefined {
    const result = this.#db.prepare<[string], SessionRow>(`
      SELECT id, exam_id, status, snapshot_json, started_at, deadline_at, submitted_at,
        submission_reason, revision, agent_scope, current_question_id, updated_at, timeout_observed
      FROM exam_sessions WHERE id = ?
    `).get(id);
    if (!result) return undefined;
    const { snapshot_json, ...row } = result;
    return { ...row, snapshot: decodeJson<ExamDefinition>(snapshot_json) };
  }

  listSessions(scope: string, { exam_id, status, limit }: SessionListFilter & { limit: number }): SessionSummary[] {
    const predicates = ['agent_scope = ?'];
    const values: (string | number)[] = [scope];
    if (exam_id !== undefined) {
      predicates.push('exam_id = ?');
      values.push(exam_id);
    }
    if (status !== undefined) {
      predicates.push('status = ?');
      values.push(status);
    }
    // Only fixed SQL clauses contribute to the query text. All values are bound.
    const sql = `
      SELECT id AS session_id, exam_id, status, started_at, deadline_at, submitted_at, updated_at
      FROM exam_sessions WHERE ${predicates.join(' AND ')}
      ORDER BY started_at DESC, id DESC LIMIT ?
    `;
    return this.#db.prepare<(string | number)[], SessionSummary>(sql).all(...values, limit);
  }

  listExpiredSessionIds(now: number, limit: number): string[] {
    return this.#db.prepare<[number, number], { id: string }>(`
      SELECT id FROM exam_sessions
      WHERE status = 'in_progress' AND auto_submit_on_timeout = 1 AND deadline_at <= ?
      ORDER BY deadline_at, id LIMIT ?
    `).all(now, limit).map(({ id }) => id);
  }

  listUnobservedManualTimeoutIds(now: number, limit: number): string[] {
    return this.#db.prepare<[number, number], { id: string }>(`
      SELECT id FROM exam_sessions
      WHERE status = 'in_progress' AND auto_submit_on_timeout = 0 AND timeout_observed = 0 AND deadline_at <= ?
      ORDER BY deadline_at, id LIMIT ?
    `).all(now, limit).map(({ id }) => id);
  }

  insertExplanationRequest(record: ExplanationRequestRecord): void {
    this.#db.prepare<ExplanationRequestRecord>(`
      INSERT INTO explanation_requests (id, session_id, question_id, agent_scope, type, status,
        attempt_count, claim_owner, claim_hash, claim_expires_at, created_at, updated_at)
      VALUES (@id, @session_id, @question_id, @agent_scope, @type, @status,
        @attempt_count, @claim_owner, @claim_hash, @claim_expires_at, @created_at, @updated_at)
    `).run(record);
  }

  updateExplanationRequest(record: ExplanationRequestRecord): void {
    this.#db.prepare<ExplanationRequestRecord>(`
      UPDATE explanation_requests SET status = @status, attempt_count = @attempt_count,
        claim_owner = @claim_owner, claim_hash = @claim_hash, claim_expires_at = @claim_expires_at,
        updated_at = @updated_at
      WHERE id = @id
    `).run(record);
  }

  getExplanationRequest(id: string): ExplanationRequestRecord | undefined {
    return this.#db.prepare<[string], ExplanationRequestRecord>(`
      SELECT * FROM explanation_requests WHERE id = ?
    `).get(id);
  }

  findEquivalentExplanation(
    sessionId: string, questionId: string, type: ExplanationRequestRecord['type'],
  ): ExplanationRequestRecord | undefined {
    return this.#db.prepare<[string, string, ExplanationRequestRecord['type']], ExplanationRequestRecord>(`
      SELECT * FROM explanation_requests WHERE session_id = ? AND question_id = ? AND type = ?
        AND status IN ('pending', 'processing', 'completed')
    `).get(sessionId, questionId, type);
  }

  listScopeExplanationRequests(
    scope: string, status: ExplanationRequestRecord['status'] | undefined, limit: number,
  ): ExplanationRequestRecord[] {
    if (status === undefined) {
      return this.#db.prepare<[string, number], ExplanationRequestRecord>(`
        SELECT * FROM explanation_requests WHERE agent_scope = ? ORDER BY created_at, id LIMIT ?
      `).all(scope, limit);
    }
    return this.#db.prepare<[string, ExplanationRequestRecord['status'], number], ExplanationRequestRecord>(`
      SELECT * FROM explanation_requests WHERE agent_scope = ? AND status = ? ORDER BY created_at, id LIMIT ?
    `).all(scope, status, limit);
  }

  countPendingExplanations(scope: string): number {
    const row = this.#db.prepare<[string], { count: number }>(`
      SELECT count(*) AS count FROM explanation_requests WHERE agent_scope = ? AND status = 'pending'
    `).get(scope);
    return row?.count ?? 0;
  }

  listSessionExplanationRequests(sessionId: string): ExplanationRequestRecord[] {
    return this.#db.prepare<[string], ExplanationRequestRecord>(`
      SELECT * FROM explanation_requests WHERE session_id = ? ORDER BY created_at DESC, id
    `).all(sessionId);
  }

  listExpiredExplanationClaims(now: number, limit: number): ExplanationRequestRecord[] {
    return this.#db.prepare<[number, number], ExplanationRequestRecord>(`
      SELECT * FROM explanation_requests WHERE status = 'processing' AND claim_expires_at <= ?
      ORDER BY claim_expires_at, id LIMIT ?
    `).all(now, limit);
  }

  getExplanation(requestId: string): ExplanationRecord | undefined {
    const row = this.#db.prepare<[string], ExplanationRow>(`
      SELECT id, request_id, session_id, question_id, content_json, completed_at
      FROM explanations WHERE request_id = ?
    `).get(requestId);
    return row === undefined ? undefined : decodeExplanation(row);
  }

  listSessionExplanations(sessionId: string): ExplanationRecord[] {
    return this.#db.prepare<[string], ExplanationRow>(`
      SELECT id, request_id, session_id, question_id, content_json, completed_at
      FROM explanations WHERE session_id = ? ORDER BY completed_at DESC, id
    `).all(sessionId).map(decodeExplanation);
  }

  insertExplanation({ content, ...row }: ExplanationRecord): void {
    this.#db.prepare<ExplanationRow>(`
      INSERT INTO explanations (id, request_id, session_id, question_id, content_json, completed_at)
      VALUES (@id, @request_id, @session_id, @question_id, @content_json, @completed_at)
    `).run({ ...row, content_json: encodeJson(content) });
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
