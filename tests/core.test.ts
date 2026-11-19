import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRuntime, RuntimeError } from '@exam-runtime/core';
import type { ExamRuntime } from '@exam-runtime/core';
import { examDefinitionSchema } from '@exam-runtime/schemas';
import { openStorage } from '@exam-runtime/storage';
import { makeAgentGradedExam, makeAnswerKeyExam } from './fixtures.js';

const startTime = 1_700_000_000_000;
const questionOrder = ['single', 'multi', 'truth', 'blank'];

function expectRuntimeError(action: () => unknown, code: RuntimeError['code'], path?: (string | number)[]) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error).toMatchObject({ code });
    if (path !== undefined) {
      expect((error as RuntimeError).details).toContainEqual(expect.objectContaining({ path }));
    }
    return;
  }
  throw new Error(`Expected ${code} error.`);
}

function withTempDatabase(check: (filename: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'exam-runtime-test-'));
  try {
    check(join(directory, 'exam.sqlite3'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function start(runtime: ExamRuntime, definition = makeAnswerKeyExam()) {
  const { id } = runtime.createExam(definition);
  runtime.publishExam(id);
  return runtime.startSession(id);
}

type InvalidDefinitionCase = {
  name: string;
  change: (doc: ReturnType<typeof makeAnswerKeyExam>) => unknown;
  path: (string | number)[];
};

const invalidDefinitions: InvalidDefinitionCase[] = [
  { name: 'unsupported schema version', change: (doc) => ({ ...doc, schema_version: '2.0' }), path: ['schema_version'] },
  { name: 'unknown document field', change: (doc) => ({ ...doc, status: 'published' }), path: [] },
  { name: 'blank exam title', change: (doc) => ({ ...doc, exam: { ...doc.exam, title: '  ' } }), path: ['exam', 'title'] },
  { name: 'non-integer duration', change: (doc) => ({ ...doc, exam: { ...doc.exam, duration_minutes: 1.5 } }), path: ['exam', 'duration_minutes'] },
  { name: 'no questions', change: (doc) => ({ ...doc, questions: [] }), path: ['questions'] },
  {
    name: 'duplicate question IDs', path: ['questions', 1, 'id'],
    change: (doc) => ({ ...doc, questions: [doc.questions[0], doc.questions[0]] }),
  },
  {
    name: 'select question without options', path: ['questions', 0, 'options'],
    change: (doc) => ({ ...doc, questions: [{ ...doc.questions[0], options: undefined }] }),
  },
  {
    name: 'duplicate option IDs', path: ['questions', 0, 'options'],
    change: (doc) => ({ ...doc, questions: [{ ...doc.questions[0], options: [{ id: 'a', text: 'A' }, { id: 'a', text: 'B' }] }] }),
  },
  {
    name: 'missing answer key', path: ['questions', 0, 'correct_answers'],
    change: (doc) => ({ ...doc, questions: [{ ...doc.questions[0], correct_answers: undefined }] }),
  },
  {
    name: 'multiple single-select answers', path: ['questions', 0, 'correct_answers'],
    change: (doc) => ({ ...doc, questions: [{ ...doc.questions[0], correct_answers: ['a', 'b'] }] }),
  },
  {
    name: 'duplicate multi-select answers', path: ['questions', 0, 'correct_answers'],
    change: (doc) => ({ ...doc, questions: [{ ...doc.questions[1], correct_answers: ['a', 'a'] }] }),
  },
  {
    name: 'answer not in options', path: ['questions', 0, 'correct_answers', 0],
    change: (doc) => ({ ...doc, questions: [{ ...doc.questions[0], correct_answers: ['missing'] }] }),
  },
  {
    name: 'custom true/false options', path: ['questions', 0, 'options'],
    change: (doc) => ({ ...doc, questions: [{ ...doc.questions[2], options: doc.questions[0]!.options }] }),
  },
  {
    name: 'free text with answer-key grading', path: ['questions', 0, 'type'],
    change: (doc) => ({ ...doc, questions: [makeAgentGradedExam().questions[0]] }),
  },
  {
    name: 'free text with an answer key', path: ['questions', 0, 'correct_answers'],
    change: () => {
      const doc = makeAgentGradedExam();
      doc.questions[0]!.correct_answers = ['a'];
      return doc;
    },
  },
  {
    name: 'free text with options', path: ['questions', 0, 'options'],
    change: (answerKey) => {
      const doc = makeAgentGradedExam();
      doc.questions[0]!.options = answerKey.questions[0]!.options;
      return doc;
    },
  },
  {
    name: 'zero correct points', path: ['grading', 'correct_points'],
    change: (doc) => ({ ...doc, grading: { ...doc.grading, correct_points: 0 } }),
  },
  {
    name: 'points smaller than a thousandth', path: ['grading', 'incorrect_points'],
    change: (doc) => ({ ...doc, grading: { ...doc.grading, incorrect_points: 0.0001 } }),
  },
  {
    name: 'passing percent above 100', path: ['grading', 'passing_percent'],
    change: (doc) => ({ ...doc, grading: { ...doc.grading, passing_percent: 100.1 } }),
  },
  {
    name: 'incorrect points above correct points', path: ['grading'],
    change: (doc) => ({ ...doc, grading: { ...doc.grading, incorrect_points: 1.1 } }),
  },
  {
    name: 'inherited unanswered points above the question maximum', path: ['questions', 0, 'points'],
    change: (doc) => ({ ...doc, questions: [{ ...doc.questions[0], points: { correct_points: 0.15 } }] }),
  },
  {
    name: 'duplicate level threshold', path: ['grading', 'levels', 1, 'min_percent'],
    change: (doc) => ({ ...doc, grading: { ...doc.grading, levels: [{ name: 'A', min_percent: 50 }, { name: 'B', min_percent: 50 }] } }),
  },
  {
    name: 'duplicate level name after trimming', path: ['grading', 'levels', 1, 'name'],
    change: (doc) => ({ ...doc, grading: { ...doc.grading, levels: [{ name: 'A', min_percent: 50 }, { name: ' A ', min_percent: 75 }] } }),
  },
  {
    name: 'agent grading with implicit unanswered points', path: ['grading'],
    change: (doc) => ({ ...doc, grading: { ...doc.grading, mode: 'agent_graded' } }),
  },
  {
    name: 'agent grading with implicit incorrect points on a question', path: ['questions', 0, 'points'],
    change: () => {
      const doc = makeAgentGradedExam();
      doc.questions[0]!.points = { correct_points: 2, incorrect_points: 1 };
      return doc;
    },
  },
];

describe('exam definitions and drafts', () => {
  let runtime: ExamRuntime;
  let now: number;

  beforeEach(() => {
    now = startTime;
    runtime = openRuntime(':memory:', () => now);
  });
  afterEach(() => runtime.close());

  it.each(invalidDefinitions)('rejects $name without storing a draft', ({ change, path }) => {
    expectRuntimeError(() => runtime.createExam(change(makeAnswerKeyExam())), 'VALIDATION', path);
    expect(runtime.listExams()).toEqual([]);
  });

  it('applies defaults to a minimal document and normalizes labels', () => {
    const parsed = examDefinitionSchema.parse({
      schema_version: '1.0', exam: { title: '  Minimal  ' },
      questions: [{ id: 'q', type: 'true_false', text: '  True? ', correct_answers: ['true'] }],
    });
    expect(parsed.exam).toEqual({
      title: 'Minimal', description: '', instructions: '', subject: 'General', mode: 'exam',
      duration_minutes: 60, shuffle_questions: false, allow_review: true, auto_submit_on_timeout: true,
    });
    expect(parsed.grading).toEqual({
      mode: 'answer_key', correct_points: 1, incorrect_points: 0, unanswered_points: 0, passing_percent: 70, levels: [],
    });
    expect(parsed.questions).toEqual([{ id: 'q', type: 'true_false', domain: 'General', text: 'True?', correct_answers: ['true'] }]);
  });

  it('replaces a draft, rejects invalid updates, and publishes an immutable definition', () => {
    const original = runtime.createExam(makeAnswerKeyExam());
    const draft = runtime.getExam(original.id);
    expect(original).toMatchObject({
      status: 'draft', created_at: startTime, updated_at: startTime, question_count: 4, maximum_points: 4,
    });
    expectRuntimeError(() => runtime.getPublishedExam(original.id), 'NOT_FOUND');
    expectRuntimeError(() => runtime.startSession(original.id), 'CONFLICT');
    expectRuntimeError(() => runtime.updateExam(original.id, { ...draft.definition, questions: [] }), 'VALIDATION', ['questions']);
    expect(runtime.getExam(original.id)).toEqual(draft);

    now += 1000;
    const replacement = makeAgentGradedExam({ title: 'Revised exam', subject: 'Storage' });
    const revised = runtime.updateExam(original.id, replacement);
    expect(revised).toMatchObject({
      id: original.id, status: 'draft', created_at: startTime, updated_at: now,
      title: 'Revised exam', subject: 'Storage', grading_mode: 'agent_graded', question_count: 2, maximum_points: 3,
    });
    const otherDraft = runtime.createExam(makeAnswerKeyExam({ subject: 'Storage' }));
    expect(runtime.listExams({ status: 'draft', subject: 'Storage' })).toEqual([otherDraft, revised]);
    expect(runtime.listExams({ subject: 'Systems' })).toEqual([]);

    now += 1000;
    const published = runtime.publishExam(original.id);
    expect(published).toEqual({ ...revised, status: 'published', updated_at: now });
    expect(runtime.getPublishedExam(original.id)).toEqual(published);
    expect(runtime.listExams({ status: 'published', subject: 'Storage' })).toEqual([published]);
    expect(runtime.listExams({ status: 'draft' })).toEqual([otherDraft]);
    now += 1000;
    expect(runtime.publishExam(original.id)).toEqual(published);
    expectRuntimeError(() => runtime.updateExam(original.id, makeAnswerKeyExam()), 'CONFLICT');
    expect(runtime.getExam(original.id).definition).toEqual(examDefinitionSchema.parse(replacement));
    expectRuntimeError(() => runtime.publishExam('missing'), 'NOT_FOUND');
  });

  it('validates the bundled local practice exam', () => {
    const sample = JSON.parse(readFileSync(new URL('../examples/aws-practice.json', import.meta.url), 'utf8'));
    expect(runtime.createExam(sample)).toMatchObject({ status: 'draft', question_count: 10, maximum_points: 12 });
  });
});

describe('sessions and answer-key grading', () => {
  let runtime: ExamRuntime;
  let now: number;

  beforeEach(() => {
    now = startTime;
    runtime = openRuntime(':memory:', () => now);
  });
  afterEach(() => runtime.close());

  it('starts an isolated attempt with stable authored order and no answer keys or author metadata', () => {
    const definition = makeAnswerKeyExam();
    const initial = start(runtime, definition);
    expect(initial).toMatchObject({
      title: 'Weighted practice', status: 'in_progress', revision: 0, started_at: startTime,
      deadline_at: startTime + 60_000, server_now: startTime, expired: false, submitted_at: null,
      submission_reason: null, responses: [], flagged_question_ids: [],
      progress: { total: 4, answered: 0, unanswered: 4, flagged: 0 },
    });
    expect(initial.questions.map(({ id }) => id)).toEqual(questionOrder);
    expect(initial.questions[0]).toEqual({
      id: 'single', type: 'single_select', domain: 'Basics', text: 'Choose the first letter.',
      options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
    });
    expect(initial.questions[2]?.options).toEqual([{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }]);
    for (const question of initial.questions) {
      expect(question).not.toHaveProperty('correct_answers');
      expect(question).not.toHaveProperty('points');
      expect(question).not.toHaveProperty('metadata');
    }
    expect(runtime.getResults(initial.id)).toMatchObject({ status: 'in_progress', result: null });

    definition.questions.reverse();
    initial.questions.reverse();
    runtime.recordAnswer(initial.id, 'single', 'a', 0);
    now += 1000;
    const next = runtime.startSession(initial.exam_id);
    expect(next.id).not.toBe(initial.id);
    expect(next.questions.map(({ id }) => id)).toEqual(questionOrder);
    expect(runtime.getSession(initial.id).questions).toEqual(next.questions);
    expect(next).toMatchObject({ responses: [], revision: 0, started_at: now, deadline_at: now + 60_000 });
  });

  it('lists recent attempts only in the exact scope without finalizing expired attempts', () => {
    const local = runtime.authenticateAgent();
    const alpha = runtime.createAgent('alpha');
    const beta = runtime.createAgent('beta');
    const principal = runtime.authenticateAgent(alpha.agent_id, alpha.token);
    const alphaExam = runtime.publishExam(runtime.createExam(makeAnswerKeyExam(), alpha.agent_id).id);
    const betaExam = runtime.publishExam(runtime.createExam(makeAnswerKeyExam(), beta.agent_id).id);
    const localAttempt = start(runtime);
    const betaAttempt = runtime.startSession(betaExam.id);
    const first = runtime.startSession(alphaExam.id);
    now += 1_000;
    runtime.recordAnswer(first.id, 'single', 'a', 0);
    runtime.submitSession(first.id);
    const submitted = runtime.getSession(first.id);
    const second = runtime.startSession(alphaExam.id);
    const third = runtime.startSession(alphaExam.id);
    const tiedIds = [second.id, third.id].sort().reverse();
    now = third.deadline_at + 1;

    const listed = runtime.listSessions(principal);
    expect(listed.map(({ session_id }) => session_id)).toEqual([...tiedIds, first.id]);
    expect(listed[0]).toEqual({
      session_id: tiedIds[0], exam_id: alphaExam.id, status: 'in_progress',
      started_at: third.started_at, deadline_at: third.deadline_at, submitted_at: null, updated_at: third.updated_at,
    });
    expect(runtime.getState(third.id, principal)).toMatchObject({ status: 'in_progress', revision: 0 });
    expect(runtime.listSessions(principal, { exam_id: alphaExam.id, status: 'graded' })).toEqual([{
      session_id: first.id, exam_id: alphaExam.id, status: 'graded',
      started_at: first.started_at, deadline_at: first.deadline_at, submitted_at: submitted.submitted_at, updated_at: submitted.updated_at,
    }]);
    expect(runtime.listSessions(principal, { status: 'in_progress', limit: 1 })).toEqual([listed[0]]);
    expect(runtime.listSessions(principal, { exam_id: betaExam.id })).toEqual([]);
    expect(runtime.listSessions(principal, { exam_id: '00000000-0000-4000-8000-000000000000' })).toEqual([]);
    expect(runtime.listSessions(local).map(({ session_id }) => session_id)).toEqual([localAttempt.id]);
    expect(runtime.listSessions(local, { exam_id: betaAttempt.exam_id })).toEqual([]);

    for (let i = 0; i < 20; i++) runtime.startSession(alphaExam.id);
    expect(runtime.listSessions(principal)).toHaveLength(20);
    expect(runtime.listSessions(principal, { limit: 100 })).toHaveLength(23);
    expectRuntimeError(() => runtime.listSessions(principal, { limit: -1 }), 'VALIDATION', ['limit']);
  });

  it('keeps shuffled attempt order without altering the published definition', () => {
    const definition = makeAnswerKeyExam({ shuffle_questions: true });
    for (let i = 1; i <= 12; i++) {
      definition.questions.push({ ...definition.questions[2]!, id: `extra-${i}` });
    }
    const authored = definition.questions.map(({ id }) => id);
    const first = start(runtime, definition);
    const second = runtime.startSession(first.exam_id);
    const orders = [first, second].map((attempt) => attempt.questions.map(({ id }) => id));
    // One valid shuffle can match authored order. With 16 questions, two matches are negligible.
    expect(orders).not.toEqual([authored, authored]);
    for (const order of orders) expect([...order].sort()).toEqual([...authored].sort());
    runtime.recordAnswer(first.id, 'single', 'a', 0);
    expect(runtime.getSession(first.id).questions).toEqual(first.questions);
    expect(runtime.getExam(first.exam_id).definition.questions.map(({ id }) => id)).toEqual(authored);
    expect(runtime.submitSession(first.id).result?.questions.map(({ question_id }) => question_id)).toEqual(orders[0]);
  });

  it.each([
    ['single', true], ['single', 'missing'], ['multi', 'a'], ['multi', ['a', 'a']], ['multi', ['missing']], ['truth', 'false'],
  ] as const)('rejects an invalid %s response (%j) without changing progress', (questionId, value) => {
    const attempt = start(runtime);
    expectRuntimeError(() => runtime.recordAnswer(attempt.id, questionId, value, 0), 'VALIDATION', ['value']);
    expect(runtime.getSession(attempt.id)).toEqual(attempt);
  });

  it('saves and clears responses and flags, rejects stale edits, and accepts identical retries', () => {
    const attempt = start(runtime);
    const { id } = attempt;
    expectRuntimeError(() => runtime.recordAnswer(id, 'single', { option: 'a' }, 0), 'VALIDATION');
    expectRuntimeError(() => runtime.recordAnswer(id, 'single', 'a', -1), 'VALIDATION');
    expectRuntimeError(() => runtime.setFlag(id, 'single', true, 0.5), 'VALIDATION');
    expectRuntimeError(() => runtime.recordAnswer(id, 'missing', 'a', 0), 'NOT_FOUND');
    expectRuntimeError(() => runtime.setFlag(id, 'missing', true, 0), 'NOT_FOUND');
    expect(runtime.getSession(id)).toEqual(attempt);

    now += 10;
    const answered = runtime.recordAnswer(id, 'multi', ['a', 'c'], 0);
    expect(answered).toMatchObject({
      revision: 1, progress: { answered: 1, unanswered: 3, flagged: 0 },
      responses: [{ question_id: 'multi', value: ['c', 'a'], updated_at: now }],
    });
    now += 10;
    expect(runtime.recordAnswer(id, 'multi', ['c', 'a'], 0)).toEqual({ ...answered, server_now: now });
    expectRuntimeError(() => runtime.recordAnswer(id, 'multi', ['a'], 0), 'CONFLICT');
    expectRuntimeError(() => runtime.setFlag(id, 'multi', true, 0), 'CONFLICT');
    const flagged = runtime.setFlag(id, 'multi', true, 1);
    expect(flagged).toMatchObject({ revision: 2, flagged_question_ids: ['multi'], progress: { flagged: 1, answered: 1 } });
    expect(runtime.setFlag(id, 'multi', true, 1)).toEqual(flagged);
    expectRuntimeError(() => runtime.setFlag(id, 'multi', false, 1), 'CONFLICT');

    const cleared = runtime.recordAnswer(id, 'multi', [], 2);
    expect(cleared).toMatchObject({
      revision: 3, progress: { answered: 0, unanswered: 4, flagged: 1 },
      responses: [{ question_id: 'multi', value: null, updated_at: now }],
    });
    expect(runtime.recordAnswer(id, 'multi', null, 2)).toEqual(cleared);
    const unflagged = runtime.setFlag(id, 'multi', false, 3);
    expect(unflagged).toMatchObject({ revision: 4, flagged_question_ids: [], progress: { flagged: 0 } });
    expect(runtime.getAnswers(id)).toEqual(unflagged.responses);
  });

  it('disallows flags when review is disabled and omits question results when requested', () => {
    const { id } = start(runtime, makeAnswerKeyExam({ allow_review: false }));
    expectRuntimeError(() => runtime.setFlag(id, 'single', true, 0), 'CONFLICT');
    runtime.recordAnswer(id, 'single', 'a', 0);
    expect(runtime.submitSession(id, false).result).toMatchObject({ correct: 1, questions: [] });
    expect(runtime.getResults(id).result?.questions).toHaveLength(4);
  });

  it.each([
    { label: 'one missing option', selected: ['a'], multiPoints: 0.25, score: 1.95, percent: 48.75, passed: false, level: null },
    { label: 'one extra option', selected: ['a', 'b', 'c'], multiPoints: 0.25, score: 1.95, percent: 48.75, passed: false, level: null },
    { label: 'an exact set in reverse order', selected: ['c', 'a'], multiPoints: 1.5, score: 3.2, percent: 80, passed: true, level: 'Proficient' },
  ])('scores weighted questions with $label', ({ selected, multiPoints, score, percent, passed, level }) => {
    const { id } = start(runtime);
    runtime.recordAnswer(id, 'single', 'a', 0);
    runtime.recordAnswer(id, 'multi', selected, 1);
    runtime.recordAnswer(id, 'truth', false, 2);
    const { result } = runtime.submitSession(id);
    expect(result).toMatchObject({
      grading_mode: 'answer_key', total: 4, correct: passed ? 3 : 2, incorrect: passed ? 0 : 1, unanswered: 1,
      earned_points: score, maximum_points: 4, percent, passing_percent: 80, passed, level,
      questions: [
        { question_id: 'single', response: 'a', outcome: 'correct', earned_points: 0.5, maximum_points: 0.5 },
        { question_id: 'multi', correct_answers: ['a', 'c'], outcome: passed ? 'correct' : 'incorrect', earned_points: multiPoints, maximum_points: 1.5 },
        { question_id: 'truth', response: false, correct_answers: ['false'], outcome: 'correct', earned_points: 1, maximum_points: 1 },
        { question_id: 'blank', response: null, outcome: 'unanswered', earned_points: 0.2, maximum_points: 1 },
      ],
      domains: [
        { domain: 'Basics', total: 2, earned_points: passed ? 2 : 0.75, maximum_points: 2 },
        { domain: 'Logic', total: 2, earned_points: 1.2, maximum_points: 2, percent: 60, unanswered: 1 },
      ],
    });
  });

  it('uses default incorrect points and the highest eligible level regardless of declaration order', () => {
    const wrong = start(runtime);
    runtime.recordAnswer(wrong.id, 'single', 'b', 0);
    runtime.recordAnswer(wrong.id, 'truth', true, 1);
    expect(runtime.submitSession(wrong.id).result).toMatchObject({
      earned_points: 0.6, percent: 15, correct: 0, incorrect: 2, unanswered: 2, passed: false, level: null,
    });
    const perfect = runtime.startSession(wrong.exam_id);
    runtime.recordAnswer(perfect.id, 'single', 'a', 0);
    runtime.recordAnswer(perfect.id, 'multi', ['a', 'c'], 1);
    runtime.recordAnswer(perfect.id, 'truth', false, 2);
    runtime.recordAnswer(perfect.id, 'blank', 'b', 3);
    expect(runtime.submitSession(perfect.id).result).toMatchObject({ percent: 100, passed: true, level: 'Advanced' });
  });

  it('submits manually once and preserves the timestamp, result, and revision on retries', () => {
    const attempt = start(runtime);
    runtime.recordAnswer(attempt.id, 'single', 'a', 0);
    now += 1_234;
    const submitted = runtime.submitSession(attempt.id);
    expect(submitted).toMatchObject({
      status: 'graded', submission_reason: 'manual', submitted_at: now, time_taken_seconds: 1,
    });
    now = attempt.deadline_at + 5000;
    expect(runtime.submitSession(attempt.id)).toEqual(submitted);
    expect(runtime.getResults(attempt.id)).toEqual(submitted);
    expect(runtime.getSession(attempt.id)).toMatchObject({ status: 'graded', revision: 2, expired: false });
    expectRuntimeError(() => runtime.recordAnswer(attempt.id, 'single', 'b', 2), 'CONFLICT');
    expectRuntimeError(() => runtime.setFlag(attempt.id, 'single', true, 2), 'CONFLICT');
    expect(runtime.finalizeExpired()).toBe(0);
  });

  it('finalizes at the deadline and commits timeout even when a late answer is rejected', () => {
    const attempt = start(runtime);
    now = attempt.deadline_at - 1;
    expect(runtime.finalizeExpired()).toBe(0);
    runtime.recordAnswer(attempt.id, 'truth', false, 0);
    now = attempt.deadline_at;
    expectRuntimeError(() => runtime.recordAnswer(attempt.id, 'truth', true, 1), 'CONFLICT');
    expect(runtime.finalizeExpired()).toBe(0);
    expect(runtime.getSession(attempt.id)).toMatchObject({
      status: 'graded', revision: 2, expired: true, submission_reason: 'timeout', submitted_at: attempt.deadline_at,
    });
    expect(runtime.getResults(attempt.id)).toMatchObject({
      time_taken_seconds: 60, result: { correct: 1, incorrect: 0, unanswered: 3, earned_points: 1.6 },
    });
  });

  it('leaves expired auto-disabled attempts paused until explicit submission', () => {
    const attempt = start(runtime, makeAnswerKeyExam({ auto_submit_on_timeout: false }));
    runtime.recordAnswer(attempt.id, 'truth', false, 0);
    const automatic = start(runtime);
    const stateKey = `state:${attempt.id}`;
    const beforeTimeout = runtime.getChangeVersions([stateKey]).get(stateKey)!;
    now = attempt.deadline_at + 15_000;
    expect(runtime.getState(attempt.id, runtime.authenticateAgent())).toMatchObject({
      status: 'in_progress', revision: 1, timer: { remaining_seconds: 0, is_expired: true },
    });
    expect(runtime.getChangeVersions([stateKey]).get(stateKey)).toBe(beforeTimeout);
    expect(runtime.finalizeExpired()).toBe(1);
    expect(runtime.getSession(automatic.id)).toMatchObject({ status: 'graded', submitted_at: automatic.deadline_at });
    const paused = runtime.getSession(attempt.id);
    expect(paused).toMatchObject({ status: 'in_progress', expired: true, revision: 2, submitted_at: null, submission_reason: null });
    expect(runtime.getChangeVersions([stateKey]).get(stateKey)).toBe(beforeTimeout + 1);
    expect(runtime.finalizeExpired()).toBe(0);
    expect(runtime.getChangeVersions([stateKey]).get(stateKey)).toBe(beforeTimeout + 1);
    expect(runtime.getResults(attempt.id)).toMatchObject({ status: 'in_progress', result: null });
    expectRuntimeError(() => runtime.recordAnswer(attempt.id, 'truth', true, 2), 'CONFLICT');
    expectRuntimeError(() => runtime.setFlag(attempt.id, 'truth', true, 2), 'CONFLICT');
    expect(runtime.getSession(attempt.id)).toEqual(paused);
    const result = runtime.submitSession(attempt.id);
    expect(result).toMatchObject({
      status: 'graded', submission_reason: 'timeout', submitted_at: attempt.deadline_at, time_taken_seconds: 60,
      result: { correct: 1, earned_points: 1.6 },
    });
    expect(runtime.submitSession(attempt.id)).toEqual(result);
    expect(runtime.getSession(attempt.id).revision).toBe(3);
    expect(runtime.finalizeExpired()).toBe(0);
  });
});

describe('agent grading', () => {
  it('requires an entire valid grade set and commits no scores for rejected submissions', () => withTempDatabase((filename) => {
    let now = startTime;
    const runtime = openRuntime(filename, () => now);
    try {
      const attempt = start(runtime, makeAgentGradedExam());
      const { id } = attempt;
      const grades = [
        { question_id: 'essay', score: 1.375, feedback: 'Explains verification.' },
        { question_id: 'choice', score: 0.125 },
      ];
      expectRuntimeError(() => runtime.submitGrades(id, grades), 'CONFLICT');
      expectRuntimeError(() => runtime.recordAnswer(id, 'essay', ['full'], 0), 'VALIDATION', ['value']);
      expect(runtime.recordAnswer(id, 'essay', '   ', 0)).toEqual(attempt);
      const answered = runtime.recordAnswer(id, 'essay', '  To verify recovery.  ', 0);
      expect(answered.responses).toEqual([{ question_id: 'essay', value: '  To verify recovery.  ', updated_at: now }]);
      now += 2000;
      const pending = runtime.submitSession(id);
      expect(pending).toMatchObject({ status: 'pending_grading', result: null, submission_reason: 'manual', submitted_at: now, time_taken_seconds: 2 });
      expectRuntimeError(() => runtime.recordAnswer(id, 'choice', 'full', 2), 'CONFLICT');
      const frozen = runtime.getSession(id);
      expect(frozen).toMatchObject({ status: 'pending_grading', revision: 2 });

      const invalidGrades: { input: unknown; path: (string | number)[] }[] = [
        { input: { grades }, path: [] },
        { input: [], path: [] },
        { input: [grades[0]], path: ['grades'] },
        { input: [grades[0], { question_id: 'missing', score: 0 }], path: ['grades', 1, 'question_id'] },
        { input: [grades[0], { question_id: 'essay', score: 0 }], path: ['grades', 1, 'question_id'] },
        { input: [grades[0], { question_id: 'choice', score: 1.001 }], path: ['grades', 1, 'score'] },
        { input: [grades[1], { question_id: 'essay', score: 2.001 }], path: ['grades', 1, 'score'] },
        { input: [grades[0], { question_id: 'choice', score: -0.001 }], path: [1, 'score'] },
        { input: [grades[0], { question_id: 'choice', score: 0.0001 }], path: [1, 'score'] },
        { input: [grades[0], { question_id: 'choice', score: '0' }], path: [1, 'score'] },
      ];
      const storage = openStorage(filename);
      try {
        for (const { input, path } of invalidGrades) {
          expectRuntimeError(() => runtime.submitGrades(id, input), 'VALIDATION', path);
          expect(runtime.getResults(id)).toEqual(pending);
          expect(runtime.getSession(id)).toEqual(frozen);
          expect(storage.listGrades(id)).toEqual([]);
        }

        now += 120_000;
        expect(runtime.submitSession(id)).toEqual(pending);
        const graded = runtime.submitGrades(id, grades);
        expect(graded).toMatchObject({
          ...pending, status: 'graded', result: {
            grading_mode: 'agent_graded', total: 2, correct: null, incorrect: null, unanswered: 1,
            earned_points: 1.5, maximum_points: 3, percent: 50, passed: true,
            questions: [
              { question_id: 'essay', outcome: 'agent_scored', earned_points: 1.375, maximum_points: 2, feedback: 'Explains verification.' },
              { question_id: 'choice', outcome: 'unanswered', response: null, earned_points: 0.125, maximum_points: 1 },
            ],
            domains: [{ domain: 'Written', earned_points: 1.5, maximum_points: 3, percent: 50 }],
          },
        });
        expect(runtime.getSession(id)).toMatchObject({ status: 'graded', revision: 3, expired: false });
        expectRuntimeError(() => runtime.submitGrades(id, grades), 'CONFLICT');
        expect(runtime.getResults(id)).toEqual(graded);
        expect(storage.listGrades(id)).toEqual([grades[1], grades[0]]);
      } finally {
        storage.close();
      }
    } finally {
      runtime.close();
    }
  }));

  it('moves an automatically expired agent attempt into pending grading', () => {
    let now = startTime;
    const runtime = openRuntime(':memory:', () => now);
    try {
      const attempt = start(runtime, makeAgentGradedExam());
      now = attempt.deadline_at + 1000;
      expect(runtime.getResults(attempt.id)).toMatchObject({
        status: 'pending_grading', result: null, submitted_at: attempt.deadline_at,
        submission_reason: 'timeout', time_taken_seconds: 60,
      });
      expect(runtime.finalizeExpired()).toBe(0);
      expect(runtime.getSession(attempt.id)).toMatchObject({ expired: true, revision: 1 });
    } finally {
      runtime.close();
    }
  });
});

it('restores durable attempts across close, a separate Node process, and reopen', () => withTempDatabase((filename) => {
  let now = startTime;
  const runtime = openRuntime(filename, () => now);
  const saved = (() => {
    try {
      const active = start(runtime, makeAnswerKeyExam({ shuffle_questions: true }));
      const agent = start(runtime, makeAgentGradedExam());
      now += 1000;
      runtime.recordAnswer(active.id, 'truth', false, 0);
      const beforeChild = runtime.setFlag(active.id, 'truth', true, 1);
      runtime.recordAnswer(agent.id, 'essay', 'Test recovery.', 0);
      const pending = runtime.submitSession(agent.id);
      return { active, beforeChild, agent, pending, exam: runtime.getPublishedExam(active.exam_id) };
    } finally {
      runtime.close();
    }
  })();

  now += 1000;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import { openRuntime } from '@exam-runtime/core';
    const [filename, timestamp, activeId, agentId] = process.argv.slice(1);
    const runtime = openRuntime(filename, () => Number(timestamp));
    try {
      const before = runtime.getSession(activeId);
      const pending = runtime.getResults(agentId);
      runtime.recordAnswer(activeId, 'single', 'a', before.revision);
      const graded = runtime.submitGrades(agentId, [
        { question_id: 'essay', score: 2, feedback: 'Correct.' },
        { question_id: 'choice', score: 0 },
      ]);
      process.stdout.write(JSON.stringify({ before, pending, graded }));
    } finally {
      runtime.close();
    }
  `, filename, String(now), saved.active.id, saved.agent.id], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000,
  });
  const child = JSON.parse(stdout);
  expect(child.before).toEqual({ ...saved.beforeChild, server_now: now });
  expect(child.pending).toEqual(saved.pending);
  expect(child.graded).toMatchObject({ status: 'graded', result: { earned_points: 2, maximum_points: 3 } });

  const reopened = openRuntime(filename, () => now);
  try {
    expect(reopened.getPublishedExam(saved.active.exam_id)).toEqual(saved.exam);
    expect(reopened.getExam(saved.active.exam_id).definition.questions.map(({ id }) => id)).toEqual(questionOrder);
    const restored = reopened.getSession(saved.active.id);
    expect(restored).toEqual({
      ...saved.beforeChild, server_now: now, updated_at: now, revision: 3,
      responses: [{ question_id: 'single', value: 'a', updated_at: now }, ...saved.beforeChild.responses],
      progress: { total: 4, answered: 2, unanswered: 2, flagged: 1 },
    });
    expectRuntimeError(() => reopened.setFlag(restored.id, 'truth', false, 2), 'CONFLICT');
    expect(reopened.getResults(saved.agent.id)).toEqual(child.graded);
    expect(reopened.getSession(saved.agent.id)).toMatchObject({ status: 'graded', revision: 3 });
    now += 1000;
    const submitted = reopened.submitSession(restored.id);
    expect(submitted).toMatchObject({ status: 'graded', submitted_at: now, result: { earned_points: 1.9, correct: 2 } });
    expect(reopened.getResults(restored.id)).toEqual(submitted);
  } finally {
    reopened.close();
  }
}));
