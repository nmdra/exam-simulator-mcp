import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { claimTokenSchema, explanationContentSchema, explanationStatusSchema, explanationTypeSchema } from '@exam-runtime/schemas';
import type { ExplanationContent, ExplanationStatus, ExplanationType, Question, ResponseValue } from '@exam-runtime/schemas';
import type { ExplanationRecord, ExplanationRequestRecord, SessionRecord, Storage } from '@exam-runtime/storage';
import type { AgentPrincipal, CandidateQuestion, ExamResult, QuestionResult } from './contracts.js';
import { RuntimeError, validated } from './errors.js';
import { candidateQuestion } from './grading.js';

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;
const PAGE_SIZE = 100;
interface RequestReference {
  request_id: string;
  status: ExplanationStatus;
}

export interface ExplanationRequestSummary extends RequestReference {
  session_id: string;
  question_id: string;
  type: ExplanationType;
  attempt_count: number;
  created_at: number;
  updated_at: number;
}

export interface ExplanationView extends ExplanationRequestSummary {
  content: ExplanationContent | null;
  completed_at: number | null;
}

export interface SessionExplanationView extends Omit<ExplanationView, 'content'> {
  content: Omit<ExplanationContent, 'agent_metadata'> | null;
}

export interface ExplanationContext {
  question: CandidateQuestion;
  response: ResponseValue;
  correct_answers?: string[];
  outcome?: QuestionResult['outcome'];
}

export interface ExplanationDetail extends ExplanationView {
  context: ExplanationContext;
}

export interface AssistanceSummary {
  allowed_types: ExplanationType[];
}

// Per-question `why_wrong` eligibility still requires a persisted incorrect result.
export function assistanceSummary(session: SessionRecord, now: number): AssistanceSummary {
  const { snapshot } = session;
  const config = snapshot.assistance;
  if (!config?.enabled) return { allowed_types: [] };
  const mode = snapshot.exam.mode ?? 'exam';
  const policy = config[`${mode}_mode`];
  if (session.status === 'in_progress') {
    if (mode === 'exam' || policy !== 'on_request' || now >= session.deadline_at) return { allowed_types: [] };
    return { allowed_types: config.allowed_types.filter((type) => type !== 'why_wrong') };
  }
  if (!snapshot.exam.allow_review || policy === 'disabled') return { allowed_types: [] };
  const canExplainWrong = session.status === 'graded' && snapshot.grading.mode === 'answer_key';
  return { allowed_types: config.allowed_types.filter((type) => type !== 'why_wrong' || canExplainWrong) };
}

function summary(row: ExplanationRequestRecord): ExplanationRequestSummary {
  return {
    request_id: row.id, session_id: row.session_id, question_id: row.question_id,
    type: row.type, status: row.status, attempt_count: row.attempt_count,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function reference(row: ExplanationRequestRecord): RequestReference {
  return { request_id: row.id, status: row.status };
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function validToken(row: ExplanationRequestRecord, scope: string, token: string): boolean {
  if (row.claim_owner !== scope || !row.claim_hash || !claimTokenSchema.safeParse(token).success) return false;
  const stored = Buffer.from(row.claim_hash, 'hex');
  const supplied = hashToken(token);
  return stored.length === supplied.length && timingSafeEqual(stored, supplied);
}

function canonicalContent(content: ExplanationContent | null): string {
  return JSON.stringify(content, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RuntimeError('VALIDATION', 'Limit must be a positive integer.');
}

function scopeFor(principal: AgentPrincipal): string {
  if (typeof principal?.scope !== 'string' || !principal.scope.trim()) {
    throw new RuntimeError('FORBIDDEN', 'An agent principal is required.');
  }
  return principal.scope;
}

function sessionChangeKey(sessionId: string): string { return `explanations:${sessionId}`; }
function pendingChangeKey(scope: string): string { return `pending:${scope}`; }

export class ExplanationService {
  constructor(private readonly storage: Storage, private readonly clock: () => number) {}

  request(sessionId: string, questionId: string, input: unknown): RequestReference {
    const type = validated(explanationTypeSchema.safeParse(input));
    return this.storage.transaction(() => {
      const now = this.clock();
      const session = this.session(sessionId);
      const question = this.question(session, questionId);
      this.requirePolicy(session, question, type, now);
      const existing = this.storage.findEquivalentExplanation(sessionId, questionId, type);
      if (existing) {
        const current = this.recover(existing, now);
        if (current.status !== 'failed') return reference(current);
      }
      const row: ExplanationRequestRecord = {
        id: randomUUID(), session_id: sessionId, question_id: questionId, agent_scope: session.agent_scope ?? 'local',
        type, status: 'pending', attempt_count: 0, claim_owner: null, claim_hash: null, claim_expires_at: null,
        created_at: now, updated_at: now,
      };
      this.storage.insertExplanationRequest(row);
      this.bump(row);
      return reference(row);
    });
  }

  list(principal: AgentPrincipal, status?: ExplanationStatus, limit = PAGE_SIZE): ExplanationRequestSummary[] {
    const scope = scopeFor(principal);
    validateLimit(limit);
    if (status !== undefined) validated(explanationStatusSchema.safeParse(status));
    return this.storage.transaction(() => {
      this.recoverBatch(this.clock(), PAGE_SIZE);
      return this.storage.listScopeExplanationRequests(scope, status, limit).map(summary);
    });
  }

  get(principal: AgentPrincipal, requestId: string): ExplanationDetail {
    const scope = scopeFor(principal);
    return this.storage.transaction(() => {
      const now = this.clock();
      const row = this.scopedRequest(scope, requestId);
      const session = this.session(row.session_id);
      const question = this.question(session, row.question_id);
      this.requirePolicy(session, question, row.type, now);
      const result = row.type === 'hint' ? undefined : this.outcome(session, row.question_id);
      const context: ExplanationContext = {
        question: candidateQuestion(question),
        response: result?.response ?? this.storage.listResponses(session.id)
          .find((response) => response.question_id === question.id)?.value ?? null,
      };
      if (row.type !== 'hint' && session.snapshot.grading.mode === 'answer_key' && question.correct_answers) {
        context.correct_answers = question.correct_answers;
      }
      if (result) context.outcome = result.outcome;
      return { ...this.view(this.recover(row, now)), context };
    });
  }

  claim(principal: AgentPrincipal, requestId: string): { claim_token: string; expires_at: number } {
    const scope = scopeFor(principal);
    const claim = this.storage.transaction(() => {
      const now = this.clock();
      const row = this.scopedRequest(scope, requestId);
      const session = this.session(row.session_id);
      this.requirePolicy(session, this.question(session, row.question_id), row.type, now);
      const current = this.recover(row, now);
      if (current.status !== 'pending') return null;
      const token = randomBytes(32).toString('base64url');
      const expires = now + LEASE_MS;
      this.update({
        ...current, status: 'processing', attempt_count: current.attempt_count + 1,
        claim_owner: scope, claim_hash: hashToken(token).toString('hex'), claim_expires_at: expires, updated_at: now,
      });
      return { claim_token: token, expires_at: expires };
    });
    if (!claim) throw new RuntimeError('CONFLICT', 'This explanation cannot be claimed.');
    return claim;
  }

  submit(principal: AgentPrincipal, requestId: string, claimToken: string, input: unknown): ExplanationView {
    const scope = scopeFor(principal);
    const submitted = this.storage.transaction(() => {
      const now = this.clock();
      const row = this.scopedRequest(scope, requestId);
      const session = this.session(row.session_id);
      this.requirePolicy(session, this.question(session, row.question_id), row.type, now);
      const current = this.recover(row, now);
      if ((current.status !== 'processing' && current.status !== 'completed') || !validToken(current, scope, claimToken)) {
        return null;
      }
      const content = validated(explanationContentSchema.safeParse(input));
      if (current.status === 'completed') {
        const view = this.view(current);
        return canonicalContent(view.content) === canonicalContent(content) ? view : null;
      }
      this.storage.insertExplanation({
        id: randomUUID(), request_id: row.id, session_id: row.session_id, question_id: row.question_id,
        content, completed_at: now,
      });
      const completed = { ...current, status: 'completed' as const, claim_expires_at: null, updated_at: now };
      this.update(completed);
      return this.view(completed);
    });
    // Commit a lazy expiration even if the submit used an expired token.
    if (!submitted) throw new RuntimeError('CONFLICT', 'The claim or explanation content no longer matches.');
    return submitted;
  }

  pending(principal: AgentPrincipal): {
    revision: number; pending_count: number; requests: ExplanationRequestSummary[];
  } {
    const scope = scopeFor(principal);
    return this.storage.transaction(() => {
      this.recoverBatch(this.clock(), PAGE_SIZE);
      return {
        revision: this.version(pendingChangeKey(scope)), pending_count: this.storage.countPendingExplanations(scope),
        requests: this.storage.listScopeExplanationRequests(scope, 'pending', PAGE_SIZE).map(summary),
      };
    });
  }

  forSession(sessionId: string): { revision: number; allowed_types: ExplanationType[]; requests: SessionExplanationView[] } {
    return this.storage.transaction(() => {
      const now = this.clock();
      const session = this.session(sessionId);
      const types = assistanceSummary(session, now).allowed_types;
      const incorrect = types.includes('why_wrong') ? new Set(this.storage.getResult<ExamResult>(session.id)?.questions
        .filter(({ outcome }) => outcome === 'incorrect').map(({ question_id }) => question_id)) : undefined;
      const requests = this.storage.listSessionExplanationRequests(sessionId)
        .map((row) => this.recover(row, now))
        .filter((row) => types.includes(row.type) && (row.type !== 'why_wrong' || incorrect?.has(row.question_id)));
      return {
        revision: this.version(sessionChangeKey(sessionId)),
        allowed_types: types.filter((type) => type !== 'why_wrong' || !!incorrect?.size),
        requests: requests.map((row) => this.browserView(row)),
      };
    });
  }

  cancel(sessionId: string, requestId: string): RequestReference {
    return this.storage.transaction(() => {
      this.session(sessionId);
      const row = this.storage.getExplanationRequest(requestId);
      if (!row || row.session_id !== sessionId) throw new RuntimeError('NOT_FOUND', 'Explanation request not found.');
      if (row.status === 'cancelled') return reference(row);
      if (row.status !== 'pending' && row.status !== 'processing') {
        throw new RuntimeError('CONFLICT', 'This explanation request cannot be cancelled.');
      }
      const cancelled = this.release(row, 'cancelled', this.clock());
      return reference(cancelled);
    });
  }

  recoverExpiredClaims(limit = PAGE_SIZE): number {
    validateLimit(limit);
    return this.storage.transaction(() => this.recoverBatch(this.clock(), limit));
  }

  private session(id: string): SessionRecord {
    const session = this.storage.getSession(id);
    if (!session) throw new RuntimeError('NOT_FOUND', 'Session not found.');
    return session;
  }

  private question(session: SessionRecord, questionId: string): Question {
    const question = session.snapshot.questions.find(({ id }) => id === questionId);
    if (!question) throw new RuntimeError('NOT_FOUND', 'Question not found in this session.');
    return question;
  }

  private scopedRequest(scope: string, requestId: string): ExplanationRequestRecord {
    const row = this.storage.getExplanationRequest(requestId);
    if (!row || row.agent_scope !== scope) throw new RuntimeError('NOT_FOUND', 'Explanation request not found.');
    return row;
  }

  private outcome(session: SessionRecord, questionId: string): QuestionResult | undefined {
    if (session.status !== 'graded') return undefined;
    return this.storage.getResult<ExamResult>(session.id)?.questions.find((result) => result.question_id === questionId);
  }

  private requirePolicy(session: SessionRecord, question: Question, type: ExplanationType, now: number): void {
    if (!assistanceSummary(session, now).allowed_types.includes(type)) {
      throw new RuntimeError('FORBIDDEN', 'This explanation type is not available for this session.');
    }
    if (type === 'why_wrong' && this.outcome(session, question.id)?.outcome !== 'incorrect') {
      throw new RuntimeError('FORBIDDEN', 'This explanation requires an incorrect graded answer.');
    }
  }

  private view(row: ExplanationRequestRecord): ExplanationView {
    let record: ExplanationRecord | undefined;
    if (row.status === 'completed') {
      record = this.storage.getExplanation(row.id);
      if (!record) throw new Error('Completed explanation has no stored content.');
    }
    const content = record ? explanationContentSchema.parse(record.content) : null;
    return { ...summary(row), content, completed_at: record?.completed_at ?? null };
  }

  private browserView(row: ExplanationRequestRecord): SessionExplanationView {
    const { content, ...view } = this.view(row);
    if (!content) return { ...view, content: null };
    const { summary, explanation, learning_tip } = content;
    return { ...view, content: { summary, explanation, ...(learning_tip === undefined ? {} : { learning_tip }) } };
  }

  private version(key: string): number {
    return this.storage.getChangeVersions([key]).get(key) ?? 0;
  }

  private bump(row: ExplanationRequestRecord): void {
    this.storage.bumpChange(sessionChangeKey(row.session_id));
    this.storage.bumpChange(pendingChangeKey(row.agent_scope));
  }

  private update(row: ExplanationRequestRecord): void {
    this.storage.updateExplanationRequest(row);
    this.bump(row);
  }

  private release(row: ExplanationRequestRecord, status: 'pending' | 'failed' | 'cancelled', now: number): ExplanationRequestRecord {
    const released = { ...row, status, claim_owner: null, claim_hash: null, claim_expires_at: null, updated_at: now };
    this.update(released);
    return released;
  }

  private recover(row: ExplanationRequestRecord, now: number): ExplanationRequestRecord {
    if (row.status !== 'processing' || row.claim_expires_at === null || row.claim_expires_at > now) return row;
    return this.release(row, row.attempt_count >= MAX_ATTEMPTS ? 'failed' : 'pending', now);
  }

  private recoverBatch(now: number, limit: number): number {
    const rows = this.storage.listExpiredExplanationClaims(now, limit);
    for (const row of rows) this.recover(row, now);
    return rows.length;
  }
}
