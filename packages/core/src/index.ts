import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { agentGradesSchema, agentIdSchema, examDefinitionSchema, responseSchema, revisionSchema, sessionListFilterSchema } from '@exam-runtime/schemas';
import type { ExamFilter, Question, ResponseValue, SubmissionReason } from '@exam-runtime/schemas';
import { databasePath, openStorage } from '@exam-runtime/storage';
import type { ExamRecord, SessionRecord, Storage } from '@exam-runtime/storage';
import type { AgentPrincipal, ExamResult, ExamState, ExamSummary, ResultView, SessionView } from './contracts.js';
import { RuntimeError, validated } from './errors.js';
import { ExplanationService } from './explanations.js';
import { candidateQuestion, computeResult, gradeLimit, maximumPoints } from './grading.js';

export * from './contracts.js';
export * from './errors.js';
export * from './explanations.js';
export * from './local-ui.js';
export * from './revisions.js';
export { databasePath };

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();

function assertScope(recordScope: string | undefined, principal: AgentPrincipal, strict: boolean) {
  if ((!principal.operator || strict) && (recordScope ?? 'local') !== principal.scope) {
    throw new RuntimeError('NOT_FOUND', 'Resource not found in this agent scope.');
  }
}

function invalid(path: (string | number)[], message: string): never {
  throw new RuntimeError('VALIDATION', message, [{ path, message }]);
}

function summary(record: ExamRecord): ExamSummary {
  const { definition } = record;
  const exam = definition.exam;
  return {
    id: record.id, status: record.status, title: exam.title, subject: exam.subject,
    difficulty: exam.difficulty, description: exam.description, instructions: exam.instructions,
    question_count: definition.questions.length, duration_minutes: exam.duration_minutes,
    grading_mode: definition.grading.mode, passing_percent: definition.grading.passing_percent,
    maximum_points: maximumPoints(definition), allow_review: exam.allow_review,
    auto_submit_on_timeout: exam.auto_submit_on_timeout,
    created_at: record.created_at, updated_at: record.updated_at,
  };
}

function normalizeAnswer(question: Question, value: ResponseValue): ResponseValue {
  const path = ['value'];
  if (value === null) return null;
  if (question.type === 'free_text') {
    if (typeof value !== 'string') invalid(path, 'Expected a text response.');
    return value.trim() ? value : null;
  }
  if (question.type === 'true_false') {
    if (typeof value !== 'boolean') invalid(path, 'Expected true or false.');
    return value;
  }
  const options = question.options ?? [];
  if (question.type === 'single_select') {
    if (typeof value !== 'string' || !options.some((option) => option.id === value)) invalid(path, 'Expected a valid option ID.');
    return value;
  }
  if (!Array.isArray(value)) invalid(path, 'Expected a list of option IDs.');
  const selected = new Set(value);
  const ordered = options.filter((option) => selected.has(option.id)).map((option) => option.id);
  if (selected.size !== value.length || ordered.length !== value.length) invalid(path, 'Expected unique, valid option IDs.');
  return ordered.length ? ordered : null;
}

export class ExamRuntime {
  readonly explanations: ExplanationService;

  constructor(private readonly storage: Storage, private readonly clock: () => number = Date.now) {
    this.explanations = new ExplanationService(storage, clock);
  }

  close() { this.storage.close(); }

  createAgent(id: string) {
    const scope = validated(agentIdSchema.safeParse(id));
    if (scope === 'local') invalid(['agent_id'], 'The local agent scope is reserved.');
    const token = randomBytes(32).toString('base64url');
    return this.storage.transaction(() => {
      if (this.storage.getAgentTokenHash(scope)) throw new RuntimeError('CONFLICT', 'This agent scope already exists.');
      this.storage.insertAgent(scope, hashToken(token), this.clock());
      return { agent_id: scope, token };
    });
  }

  authenticateAgent(id?: string, token?: string): AgentPrincipal {
    if (id === undefined && token === undefined) return { scope: 'local', operator: true };
    if (id && token && token.length === 43 && agentIdSchema.safeParse(id).success) {
      const expected = this.storage.getAgentTokenHash(id);
      if (expected && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hashToken(token), 'hex'))) {
        return { scope: id, operator: false };
      }
    }
    throw new RuntimeError('FORBIDDEN', 'Invalid agent credentials. Set both EXAM_RUNTIME_AGENT_ID and EXAM_RUNTIME_AGENT_TOKEN.');
  }

  assertExamAccess(id: string, principal: AgentPrincipal) {
    assertScope(this.getExam(id).agent_scope, principal, false);
  }

  assertSessionAccess(id: string, principal: AgentPrincipal, strict = false) {
    assertScope(this.getSessionRecord(id).agent_scope, principal, strict);
  }

  createExam(input: unknown, agent_scope = 'local'): ExamSummary {
    const definition = validated(examDefinitionSchema.safeParse(input));
    return this.storage.transaction(() => {
      const now = this.clock();
      if (agent_scope !== 'local' && !this.storage.getAgentTokenHash(agent_scope)) {
        throw new RuntimeError('NOT_FOUND', 'Agent scope not found. Create it before assigning an exam.');
      }
      const record: ExamRecord = { id: randomUUID(), status: 'draft', definition, agent_scope, created_at: now, updated_at: now };
      this.storage.insertExam(record);
      return summary(record);
    });
  }

  updateExam(id: string, input: unknown): ExamSummary {
    const definition = validated(examDefinitionSchema.safeParse(input));
    return this.storage.transaction(() => {
      const record = this.getExam(id);
      if (record.status !== 'draft') throw new RuntimeError('CONFLICT', 'Published exams cannot be changed. Create a new draft instead.');
      const updated = { ...record, definition, updated_at: this.clock() };
      this.storage.updateExam(updated);
      return summary(updated);
    });
  }

  publishExam(id: string): ExamSummary {
    return this.storage.transaction(() => {
      const record = this.getExam(id);
      if (record.status === 'published') return summary(record);
      const updated: ExamRecord = { ...record, status: 'published', updated_at: this.clock() };
      this.storage.updateExam(updated);
      return summary(updated);
    });
  }

  listExams(filter?: ExamFilter, agent_scope?: string) {
    return this.storage.listExams({ ...filter, agent_scope }).map(summary);
  }

  getExam(id: string): ExamRecord {
    const record = this.storage.getExam(id);
    if (!record) throw new RuntimeError('NOT_FOUND', 'Exam not found.');
    return record;
  }

  getPublishedExam(id: string): ExamSummary {
    const record = this.getExam(id);
    if (record.status !== 'published') throw new RuntimeError('NOT_FOUND', 'Published exam not found.');
    return summary(record);
  }

  startSession(examId: string): SessionView {
    return this.storage.transaction(() => {
      const exam = this.getExam(examId);
      if (exam.status !== 'published') throw new RuntimeError('CONFLICT', 'Publish the exam before starting a session.');
      const now = this.clock();
      const snapshot = exam.definition;
      if (snapshot.exam.shuffle_questions) {
        const questions = snapshot.questions;
        for (let i = questions.length - 1; i > 0; i--) {
          const j = randomInt(i + 1);
          [questions[i], questions[j]] = [questions[j]!, questions[i]!];
        }
      }
      const session: SessionRecord = {
        id: randomUUID(), exam_id: examId, snapshot, status: 'in_progress', started_at: now,
        deadline_at: now + snapshot.exam.duration_minutes * 60_000,
        submitted_at: null, submission_reason: null, revision: 0,
        agent_scope: exam.agent_scope ?? 'local', current_question_id: snapshot.questions[0]!.id, updated_at: now,
      };
      this.storage.insertSession(session);
      return this.sessionView(session, now);
    });
  }

  listSessions(principal: AgentPrincipal, filter: unknown = {}) {
    return this.storage.listSessions(principal.scope, validated(sessionListFilterSchema.safeParse(filter)));
  }

  getSession(id: string): SessionView {
    return this.withSession(id, (session, now) => this.sessionView(session, now));
  }

  getAnswers(id: string) {
    return this.withSession(id, (session) => this.storage.listResponses(session.id));
  }

  getState(id: string, principal: AgentPrincipal, includeResponses = false): ExamState {
    // Read-only: the maintenance sweep finalizes timeouts independently of this projection.
    return this.storage.readTransaction(() => {
      const session = this.getSessionRecord(id);
      assertScope(session.agent_scope, principal, true);
      const now = this.clock();
      const end = Math.min(session.submitted_at ?? now, session.deadline_at);
      const { snapshot } = session;
      const responses = this.storage.listResponses(id);
      const flags = this.storage.listFlags(id);
      const flagged = new Set(flags);
      const answered = responses.filter((entry) => entry.value !== null).length;
      const total = snapshot.questions.length;
      return {
        session_id: id, exam_id: session.exam_id, title: snapshot.exam.title, subject: snapshot.exam.subject,
        mode: snapshot.exam.mode, status: session.status, revision: session.revision,
        updated_at: iso(session.updated_at ?? session.started_at), server_now: iso(now), deadline_at: iso(session.deadline_at),
        timer: {
          duration_seconds: Math.floor((session.deadline_at - session.started_at) / 1000),
          elapsed_seconds: Math.floor(Math.max(0, end - session.started_at) / 1000),
          remaining_seconds: session.status === 'in_progress' ? Math.ceil(Math.max(0, session.deadline_at - now) / 1000) : 0,
          is_expired: (session.submitted_at ?? now) >= session.deadline_at,
        },
        progress: { total_questions: total, answered, unanswered: total - answered, flagged: flagged.size, current_question_id: this.currentQuestion(session) },
        flagged_question_ids: flags,
        ...(includeResponses ? { responses: responses.map((response) => {
          const question = snapshot.questions.find((entry) => entry.id === response.question_id);
          const value = response.value;
          const selected = value === null || question?.type === 'free_text' ? undefined
            : Array.isArray(value) ? value : [String(value)];
          return { ...response, is_flagged: flagged.has(response.question_id), ...(selected ? { selected_answers: selected } : {}) };
        }) } : {}),
        grading: {
          status: session.status === 'in_progress' ? 'not_started' : session.status,
          result_available: session.status === 'graded',
        },
      };
    });
  }

  setCurrentQuestion(id: string, questionId: string, revision: number): SessionView {
    return this.changeSession(id, revision, (session) => {
      this.question(session, questionId);
      return {
        changed: this.currentQuestion(session) !== questionId,
        apply: () => { session.current_question_id = questionId; },
      };
    });
  }

  getChangeVersions(keys: readonly string[]) { return this.storage.getChangeVersions(keys); }

  maintain() {
    this.finalizeExpired();
    this.explanations.recoverExpiredClaims();
  }

  recordAnswer(id: string, questionId: string, input: unknown, revision: number): SessionView {
    const value = validated(responseSchema.safeParse(input));
    return this.changeSession(id, revision, (session) => {
      const answer = normalizeAnswer(this.question(session, questionId), value);
      const previous = this.storage.listResponses(id).find((response) => response.question_id === questionId);
      return {
        changed: JSON.stringify(previous?.value ?? null) !== JSON.stringify(answer),
        apply: (now: number) => this.storage.putResponse(id, { question_id: questionId, value: answer, updated_at: now }),
      };
    });
  }

  setFlag(id: string, questionId: string, flagged: boolean, revision: number): SessionView {
    return this.changeSession(id, revision, (session) => {
      this.question(session, questionId);
      if (!session.snapshot.exam.allow_review) throw new RuntimeError('CONFLICT', 'Review is disabled for this exam.');
      return {
        changed: this.storage.listFlags(id).includes(questionId) !== flagged,
        apply: () => this.storage.putFlag(id, questionId, flagged),
      };
    });
  }

  submitSession(id: string, includeReview = true): ResultView {
    return this.withSession(id, (session, now) => {
      if (session.status === 'in_progress') this.finalize(session, now >= session.deadline_at ? 'timeout' : 'manual', now);
      return this.resultView(session, includeReview);
    });
  }

  getResults(id: string, includeReview = true): ResultView {
    return this.withSession(id, (session) => this.resultView(session, includeReview));
  }

  submitGrades(id: string, input: unknown): ResultView {
    const grades = validated(agentGradesSchema.safeParse(input));
    const resultView = this.withSession(id, (session, now) => {
      if (session.status !== 'pending_grading') return null;
      const questions = new Map(session.snapshot.questions.map((question) => [question.id, question]));
      const seen = new Set<string>();
      for (const [index, grade] of grades.entries()) {
        const question = questions.get(grade.question_id);
        if (!question) invalid(['grades', index, 'question_id'], 'Question not found in this attempt.');
        if (seen.has(grade.question_id)) invalid(['grades', index, 'question_id'], 'Duplicate question grade.');
        seen.add(grade.question_id);
        const max = gradeLimit(session.snapshot, question);
        if (grade.score > max) invalid(['grades', index, 'score'], `Score must be between 0 and ${max}.`);
      }
      const missing = [...questions.keys()].filter((questionId) => !seen.has(questionId));
      if (missing.length) invalid(['grades'], `Submit one score per question. Missing: ${missing.join(', ')}.`);
      const result = computeResult(session.snapshot, this.storage.listResponses(id), grades);
      this.storage.putGrades(id, grades);
      this.storage.insertResult(id, result, now);
      session.status = 'graded';
      this.persistStateChange(session, now);
      return this.resultView(session, true);
    });
    if (!resultView) throw new RuntimeError('CONFLICT', 'This attempt is not pending agent grading.');
    return resultView;
  }

  finalizeExpired(limit = 100): number {
    return this.storage.transaction(() => {
      const now = this.clock();
      const ids = this.storage.listExpiredSessionIds(now, limit);
      for (const id of ids) this.expire(this.getSessionRecord(id), now);
      // Invalidate state once at a manual timeout too, without submitting the attempt.
      for (const id of this.storage.listUnobservedManualTimeoutIds(now, limit)) {
        const session = this.getSessionRecord(id);
        session.timeout_observed = 1;
        this.persistStateChange(session, now);
      }
      return ids.length;
    });
  }

  private getSessionRecord(id: string) {
    const session = this.storage.getSession(id);
    if (!session) throw new RuntimeError('NOT_FOUND', 'Session not found.');
    return session;
  }

  private currentQuestion(session: SessionRecord) {
    return session.current_question_id ?? session.snapshot.questions[0]!.id;
  }

  private persistStateChange(session: SessionRecord, now: number) {
    session.revision++;
    session.updated_at = Math.max(session.updated_at ?? session.started_at, now);
    this.storage.updateSession(session);
    this.storage.bumpChange(`state:${session.id}`);
  }

  private question(session: SessionRecord, questionId: string) {
    const question = session.snapshot.questions.find((entry) => entry.id === questionId);
    if (!question) throw new RuntimeError('NOT_FOUND', 'Question not found in this session.');
    return question;
  }

  private withSession<T>(id: string, action: (session: SessionRecord, now: number) => T): T {
    return this.storage.transaction(() => {
      const session = this.getSessionRecord(id);
      const now = this.clock();
      this.expire(session, now);
      return action(session, now);
    });
  }

  private changeSession(id: string, revision: number, change: (session: SessionRecord) => {
    changed: boolean; apply: (now: number) => void;
  }): SessionView {
    validated(revisionSchema.safeParse(revision));
    const result = this.withSession(id, (session, now) => {
      if (session.status !== 'in_progress' || now >= session.deadline_at) return { error: 'This attempt is closed for changes.' } as const;
      const mutation = change(session);
      if (mutation.changed) {
        if (session.revision !== revision) return { error: 'The session has changed. Refresh before trying again.' } as const;
        mutation.apply(now);
        this.persistStateChange(session, now);
      }
      return { session: this.sessionView(session, now) } as const;
    });
    // Throw after committing any auto-finalization caused by this request.
    if (result.error !== undefined) throw new RuntimeError('CONFLICT', result.error);
    return result.session;
  }

  private expire(session: SessionRecord, now: number) {
    if (session.status === 'in_progress' && session.snapshot.exam.auto_submit_on_timeout && now >= session.deadline_at) {
      this.finalize(session, 'timeout', now);
    }
  }

  private finalize(session: SessionRecord, reason: SubmissionReason, now: number) {
    session.submission_reason = reason;
    session.submitted_at = reason === 'timeout' ? session.deadline_at : now;
    if (session.snapshot.grading.mode === 'answer_key') {
      const result = computeResult(session.snapshot, this.storage.listResponses(session.id));
      this.storage.insertResult(session.id, result, now);
      session.status = 'graded';
    } else {
      session.status = 'pending_grading';
    }
    this.persistStateChange(session, now);
  }

  private sessionView(session: SessionRecord, now: number): SessionView {
    const { snapshot } = session;
    const responses = this.storage.listResponses(session.id);
    const flags = this.storage.listFlags(session.id);
    const total = snapshot.questions.length;
    const answered = responses.filter((response) => response.value !== null).length;
    return {
      id: session.id, exam_id: session.exam_id, title: snapshot.exam.title, subject: snapshot.exam.subject,
      status: session.status, started_at: session.started_at, deadline_at: session.deadline_at,
      submitted_at: session.submitted_at, submission_reason: session.submission_reason,
      revision: session.revision, updated_at: session.updated_at ?? session.started_at, server_now: now,
      current_question_id: this.currentQuestion(session),
      expired: (session.submitted_at ?? now) >= session.deadline_at,
      allow_review: snapshot.exam.allow_review, auto_submit_on_timeout: snapshot.exam.auto_submit_on_timeout,
      grading_mode: snapshot.grading.mode, questions: snapshot.questions.map(candidateQuestion),
      responses, flagged_question_ids: flags,
      progress: { total, answered, unanswered: total - answered, flagged: flags.length },
    };
  }

  private resultView(session: SessionRecord, includeReview: boolean): ResultView {
    const header = {
      session_id: session.id, exam_id: session.exam_id, title: session.snapshot.exam.title,
      started_at: session.started_at, deadline_at: session.deadline_at, submitted_at: session.submitted_at,
      submission_reason: session.submission_reason,
      time_taken_seconds: session.submitted_at === null ? null : Math.floor(Math.max(0, session.submitted_at - session.started_at) / 1000),
    };
    if (session.status !== 'graded') return { ...header, status: session.status, result: null };
    const result = this.storage.getResult<ExamResult>(session.id);
    if (!result) throw new Error('Graded attempt has no stored result.');
    const review = includeReview || session.snapshot.exam.allow_review;
    return { ...header, status: 'graded', result: review ? result : { ...result, questions: [] } };
  }
}

export function openRuntime(filename?: string, clock?: () => number): ExamRuntime {
  return new ExamRuntime(openStorage(filename), clock);
}
