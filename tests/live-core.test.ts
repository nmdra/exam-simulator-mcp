import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRuntime } from '@exam-runtime/core';
import type { ExamRuntime, RuntimeError } from '@exam-runtime/core';
import { examDefinitionSchema } from '@exam-runtime/schemas';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAnswerKeyExam } from './fixtures.js';

const startTime = 1_700_000_000_000;
const practiceWithAssistance = {
  ...makeAnswerKeyExam({ mode: 'practice', duration_minutes: 10 }),
  assistance: { enabled: true },
};
const explanation = { summary: 'Compare the choices.', explanation: 'Read the letters in order.' };

function expectRuntimeError(action: () => unknown, code: RuntimeError['code']) {
  expect(action).toThrow(expect.objectContaining({ name: 'RuntimeError', code }));
}

function start(runtime: ExamRuntime, definition: unknown, scope?: string) {
  const { id } = runtime.createExam(definition, scope);
  runtime.publishExam(id);
  return runtime.startSession(id);
}

describe('live runtime', () => {
  let runtime: ExamRuntime;
  let now: number;

  beforeEach(() => {
    now = startTime;
    runtime = openRuntime(':memory:', () => now);
  });
  afterEach(() => runtime.close());

  it('authenticates complete credentials and isolates exams, session state, and explanation requests by scope', () => {
    const { token } = runtime.createAgent('alpha');
    const { token: otherToken } = runtime.createAgent('beta');
    const alpha = runtime.authenticateAgent('alpha', token);
    const beta = runtime.authenticateAgent('beta', otherToken);
    const operator = runtime.authenticateAgent();
    expect(alpha).toEqual({ scope: 'alpha', operator: false });
    expect(operator).toEqual({ scope: 'local', operator: true });
    expectRuntimeError(() => runtime.authenticateAgent('alpha'), 'FORBIDDEN');
    expectRuntimeError(() => runtime.authenticateAgent(undefined, token), 'FORBIDDEN');
    expectRuntimeError(() => runtime.authenticateAgent('alpha', otherToken), 'FORBIDDEN');
    expectRuntimeError(() => runtime.authenticateAgent('missing', token), 'FORBIDDEN');
    expectRuntimeError(() => runtime.createAgent('alpha'), 'CONFLICT');
    expectRuntimeError(() => runtime.createAgent('local'), 'VALIDATION');
    expectRuntimeError(() => runtime.createExam(practiceWithAssistance, 'missing'), 'NOT_FOUND');

    const own = start(runtime, practiceWithAssistance, alpha.scope);
    const other = start(runtime, practiceWithAssistance, beta.scope);
    const local = start(runtime, practiceWithAssistance);
    expect(runtime.listExams(undefined, alpha.scope).map(({ id }) => id)).toEqual([own.exam_id]);
    expect(() => runtime.assertExamAccess(own.exam_id, alpha)).not.toThrow();
    expect(() => runtime.assertSessionAccess(own.id, alpha)).not.toThrow();
    expectRuntimeError(() => runtime.assertExamAccess(other.exam_id, alpha), 'NOT_FOUND');
    expectRuntimeError(() => runtime.assertSessionAccess(other.id, alpha), 'NOT_FOUND');
    expectRuntimeError(() => runtime.getState(other.id, alpha), 'NOT_FOUND');
    expectRuntimeError(() => runtime.getState(local.id, alpha), 'NOT_FOUND');
    expectRuntimeError(() => runtime.getState(own.id, operator), 'NOT_FOUND');
    expect(runtime.getState(own.id, alpha).session_id).toBe(own.id);
    expect(runtime.getState(local.id, operator).session_id).toBe(local.id);

    const { request_id: requestId } = runtime.explanations.request(own.id, 'single', 'hint');
    expect(runtime.explanations.pending(alpha)).toMatchObject({ pending_count: 1, requests: [{ request_id: requestId }] });
    expect(runtime.explanations.pending(beta)).toMatchObject({ pending_count: 0, requests: [] });
    expectRuntimeError(() => runtime.explanations.get(beta, requestId), 'NOT_FOUND');
    expectRuntimeError(() => runtime.explanations.claim(beta, requestId), 'NOT_FOUND');
    const claim = runtime.explanations.claim(alpha, requestId);
    expectRuntimeError(() => runtime.explanations.submit(beta, requestId, claim.claim_token, explanation), 'NOT_FOUND');
  });

  it('projects progress and opt-in responses without writing state or exposing answer keys', () => {
    const operator = runtime.authenticateAgent();
    const { id, deadline_at: deadline } = start(runtime, makeAnswerKeyExam());
    now += 1_000;
    runtime.recordAnswer(id, 'single', 'b', 0);
    runtime.setFlag(id, 'single', true, 1);
    runtime.setCurrentQuestion(id, 'multi', 2);
    const keys = [`state:${id}`];
    const versions = runtime.getChangeVersions(keys);
    now = deadline;

    const state = runtime.getState(id, operator);
    const withResponses = runtime.getState(id, operator, true);
    expect(state).toMatchObject({
      status: 'in_progress', revision: 3, updated_at: new Date(startTime + 1_000).toISOString(),
      timer: { duration_seconds: 60, elapsed_seconds: 60, remaining_seconds: 0, is_expired: true },
      progress: { total_questions: 4, answered: 1, unanswered: 3, flagged: 1, current_question_id: 'multi' },
      grading: { status: 'not_started', result_available: false },
    });
    expect(state).not.toHaveProperty('responses');
    expect(withResponses).toEqual({
      ...state,
      responses: [{ question_id: 'single', value: 'b', selected_answers: ['b'], is_flagged: true, updated_at: startTime + 1_000 }],
    });
    expect(runtime.getChangeVersions(keys)).toEqual(versions);
    expect(runtime.submitSession(id)).toMatchObject({ status: 'graded' });
    const graded = runtime.getState(id, operator, true);
    expect(graded.grading).toEqual({ status: 'graded', result_available: true });
    expect(JSON.stringify([withResponses, graded])).not.toMatch(/correct_answers|author_note|Not candidate content/);
  });

  it('allows practice hints, but keeps keys and grading outcomes out of their context', () => {
    const principal = runtime.authenticateAgent();
    const { id } = start(runtime, practiceWithAssistance);
    runtime.recordAnswer(id, 'single', 'b', 0);
    expect(runtime.explanations.forSession(id).allowed_types).toEqual(['hint', 'detailed']);
    expectRuntimeError(() => runtime.explanations.request(id, 'single', 'why_wrong'), 'FORBIDDEN');
    const { request_id: requestId } = runtime.explanations.request(id, 'single', 'hint');
    const detail = runtime.explanations.get(principal, requestId);
    expect(detail.context).toMatchObject({ question: { id: 'single' }, response: 'b' });
    expect(detail.context).not.toHaveProperty('outcome');
    expect(JSON.stringify(detail)).not.toMatch(/correct_answers|author_note|claim_token/);
  });

  it('allows exam assistance only after submission, and why_wrong only for an incorrect result', () => {
    const principal = runtime.authenticateAgent();
    const { id } = start(runtime, { ...makeAnswerKeyExam(), assistance: { enabled: true } });
    runtime.recordAnswer(id, 'single', 'b', 0);
    runtime.recordAnswer(id, 'truth', false, 1);
    expect(runtime.explanations.forSession(id).allowed_types).toEqual([]);
    expectRuntimeError(() => runtime.explanations.request(id, 'single', 'hint'), 'FORBIDDEN');

    runtime.submitSession(id);
    expect(runtime.explanations.forSession(id).allowed_types).toEqual(['hint', 'detailed', 'why_wrong']);
    expectRuntimeError(() => runtime.explanations.request(id, 'truth', 'why_wrong'), 'FORBIDDEN');
    expectRuntimeError(() => runtime.explanations.request(id, 'blank', 'why_wrong'), 'FORBIDDEN');
    const { request_id: requestId } = runtime.explanations.request(id, 'single', 'why_wrong');
    expect(runtime.explanations.get(principal, requestId).context).toMatchObject({
      response: 'b', outcome: 'incorrect', correct_answers: ['a'],
    });
  });

  it.each([
    ['assistance is disabled', { ...practiceWithAssistance, assistance: { enabled: false } }],
    ['review is disabled', { ...practiceWithAssistance, exam: { ...practiceWithAssistance.exam, allow_review: false } }],
  ])('disallows assistance after submission when %s', (_reason, definition) => {
    const { id } = start(runtime, definition);
    runtime.submitSession(id);
    expect(runtime.explanations.forSession(id).allowed_types).toEqual([]);
    expectRuntimeError(() => runtime.explanations.request(id, 'single', 'hint'), 'FORBIDDEN');
  });

  it('recovers an expired lease, rejects stale tokens, and keeps equivalent requests and submissions idempotent', () => {
    const principal = runtime.authenticateAgent();
    const service = runtime.explanations;
    const { id } = start(runtime, practiceWithAssistance);
    const request = service.request(id, 'single', 'hint');
    const requestId = request.request_id;
    expect(service.request(id, 'single', 'hint')).toEqual(request);
    const first = service.claim(principal, requestId);
    now = first.expires_at - 1;
    expectRuntimeError(() => service.claim(principal, requestId), 'CONFLICT');
    expect(service.request(id, 'single', 'hint')).toEqual({ request_id: requestId, status: 'processing' });

    now = first.expires_at;
    expectRuntimeError(() => service.submit(principal, requestId, first.claim_token, explanation), 'CONFLICT');
    expect(service.pending(principal)).toMatchObject({ pending_count: 1, requests: [{ request_id: requestId, attempt_count: 1 }] });
    const second = service.claim(principal, requestId);
    expect(second.claim_token).not.toBe(first.claim_token);
    expectRuntimeError(() => service.submit(principal, requestId, first.claim_token, explanation), 'CONFLICT');
    const content = { ...explanation, agent_metadata: { source: 'guide', version: 1 } };
    const completed = service.submit(principal, requestId, second.claim_token, content);
    expect(completed).toMatchObject({ request_id: requestId, content, status: 'completed', attempt_count: 2 });

    const browserView = service.forSession(id);
    expect(browserView.requests).toMatchObject([{ request_id: requestId, content: explanation }]);
    expect(browserView.requests[0]?.content).not.toHaveProperty('agent_metadata');
    now += 1_000;
    expect(service.submit(principal, requestId, second.claim_token, {
      ...explanation, agent_metadata: { version: 1, source: 'guide' },
    })).toEqual(completed);
    expectRuntimeError(() => service.submit(principal, requestId, second.claim_token, { ...explanation, summary: 'Changed.' }), 'CONFLICT');
    expect(service.request(id, 'single', 'hint')).toEqual({ request_id: requestId, status: 'completed' });
    expect(service.pending(principal).pending_count).toBe(0);
    expect(service.forSession(id)).toEqual(browserView);
  });

  it('cancels a claimed request only in its own session and allows a new request for the same hint', () => {
    const principal = runtime.authenticateAgent();
    const service = runtime.explanations;
    const { id } = start(runtime, practiceWithAssistance);
    const other = start(runtime, practiceWithAssistance);
    const { request_id: requestId } = service.request(id, 'single', 'hint');
    const lease = service.claim(principal, requestId);
    expectRuntimeError(() => service.cancel(other.id, requestId), 'NOT_FOUND');
    const cancelled = service.cancel(id, requestId);
    expect(cancelled).toEqual({ request_id: requestId, status: 'cancelled' });
    const view = service.forSession(id);
    expect(service.cancel(id, requestId)).toEqual(cancelled);
    expect(service.forSession(id)).toEqual(view);
    expectRuntimeError(() => service.submit(principal, requestId, lease.claim_token, explanation), 'CONFLICT');
    now = lease.expires_at;
    expect(service.pending(principal).pending_count).toBe(0);
    const replacement = service.request(id, 'single', 'hint');
    expect(replacement.status).toBe('pending');
    expect(replacement.request_id).not.toBe(requestId);
  });
});

it('preserves a v1 exam and active attempt when opening the database with the current runtime', () => {
  const directory = mkdtempSync(join(tmpdir(), 'exam-runtime-v1-'));
  const filename = join(directory, 'exam.sqlite3');
  try {
    const definition = examDefinitionSchema.parse(makeAnswerKeyExam());
    const { questions, ...header } = definition;
    const answeredAt = startTime + 1_000;
    const legacy = new Database(filename);
    try {
      // A frozen v1 fixture is independent of the migration code under test.
      legacy.exec(`
        PRAGMA user_version = 1;
        CREATE TABLE exams (
          id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
          subject TEXT NOT NULL, definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX exams_by_status_subject ON exams (status, subject);
        CREATE INDEX exams_by_subject ON exams (subject);
        CREATE TABLE exam_questions (
          exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE, question_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 0), question_json TEXT NOT NULL CHECK (json_valid(question_json)),
          PRIMARY KEY (exam_id, question_id), UNIQUE (exam_id, position)
        ) STRICT;
        CREATE TABLE exam_sessions (
          id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES exams(id),
          status TEXT NOT NULL CHECK (status IN ('in_progress', 'pending_grading', 'graded')),
          snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
          auto_submit_on_timeout INTEGER NOT NULL CHECK (auto_submit_on_timeout IN (0, 1)),
          started_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, submitted_at INTEGER,
          submission_reason TEXT CHECK (submission_reason IN ('manual', 'timeout')),
          revision INTEGER NOT NULL CHECK (revision >= 0)
        ) STRICT;
        CREATE INDEX exam_sessions_by_exam ON exam_sessions (exam_id);
        CREATE INDEX exam_sessions_due ON exam_sessions (deadline_at, id)
          WHERE status = 'in_progress' AND auto_submit_on_timeout = 1;
        CREATE TABLE session_responses (
          session_id TEXT NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE, question_id TEXT NOT NULL,
          value_json TEXT NOT NULL CHECK (json_valid(value_json)), updated_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, question_id)
        ) STRICT;
        CREATE TABLE session_flags (
          session_id TEXT NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE, question_id TEXT NOT NULL,
          PRIMARY KEY (session_id, question_id)
        ) STRICT;
        CREATE TABLE exam_results (
          session_id TEXT PRIMARY KEY REFERENCES exam_sessions(id) ON DELETE CASCADE,
          result_json TEXT NOT NULL CHECK (json_valid(result_json)), created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE question_grades (
          session_id TEXT NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
          question_id TEXT NOT NULL, score REAL NOT NULL, feedback TEXT, PRIMARY KEY (session_id, question_id)
        ) STRICT;
      `);
      legacy.prepare("INSERT INTO exams VALUES ('legacy-exam', 'published', ?, ?, ?, ?)")
        .run(definition.exam.subject, JSON.stringify(header), startTime, startTime);
      const insertQuestion = legacy.prepare("INSERT INTO exam_questions VALUES ('legacy-exam', ?, ?, ?)");
      questions.forEach((question, position) => insertQuestion.run(question.id, position, JSON.stringify(question)));
      legacy.prepare("INSERT INTO exam_sessions VALUES ('legacy-attempt', 'legacy-exam', 'in_progress', ?, 1, ?, ?, NULL, NULL, 2)")
        .run(JSON.stringify(definition), startTime, startTime + 60_000);
      legacy.prepare("INSERT INTO session_responses VALUES ('legacy-attempt', 'single', ?, ?)")
        .run(JSON.stringify('a'), answeredAt);
      legacy.exec("INSERT INTO session_flags VALUES ('legacy-attempt', 'single')");
    } finally {
      legacy.close();
    }

    const runtime = openRuntime(filename, () => startTime + 2_000);
    try {
      const operator = runtime.authenticateAgent();
      expect(runtime.getExam('legacy-exam')).toMatchObject({ status: 'published', agent_scope: 'local', definition });
      expect(runtime.getState('legacy-attempt', operator, true)).toMatchObject({
        exam_id: 'legacy-exam', revision: 2, status: 'in_progress', updated_at: new Date(answeredAt).toISOString(),
        progress: { current_question_id: 'single', answered: 1, flagged: 1 },
        responses: [{ question_id: 'single', value: 'a', updated_at: answeredAt, is_flagged: true }],
      });
      expect(runtime.submitSession('legacy-attempt')).toMatchObject({
        status: 'graded', result: { correct: 1, unanswered: 3 },
      });
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
