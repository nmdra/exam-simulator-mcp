import type { ExamDefinition, ExamStatus, Question, ResponseValue, SessionStatus, SubmissionReason } from '@exam-runtime/schemas';
import type { StoredResponse } from '@exam-runtime/storage';

export interface ExamSummary {
  id: string;
  status: ExamStatus;
  title: string;
  subject: string;
  difficulty?: string;
  description: string;
  instructions: string;
  question_count: number;
  duration_minutes: number;
  grading_mode: ExamDefinition['grading']['mode'];
  passing_percent: number;
  maximum_points: number;
  allow_review: boolean;
  auto_submit_on_timeout: boolean;
  created_at: number;
  updated_at: number;
}

export type CandidateQuestion = Pick<Question, 'id' | 'type' | 'text' | 'domain' | 'difficulty' | 'options'>;

export interface SessionView {
  id: string;
  exam_id: string;
  title: string;
  subject: string;
  status: SessionStatus;
  started_at: number;
  deadline_at: number;
  submitted_at: number | null;
  submission_reason: SubmissionReason | null;
  revision: number;
  updated_at: number;
  current_question_id: string;
  server_now: number;
  expired: boolean;
  allow_review: boolean;
  auto_submit_on_timeout: boolean;
  grading_mode: ExamDefinition['grading']['mode'];
  questions: CandidateQuestion[];
  responses: StoredResponse[];
  flagged_question_ids: string[];
  progress: { total: number; answered: number; unanswered: number; flagged: number };
}

export interface AgentPrincipal { scope: string; operator: boolean }

export interface ExamState {
  session_id: string;
  exam_id: string;
  title: string;
  subject: string;
  mode: ExamDefinition['exam']['mode'];
  status: SessionStatus;
  revision: number;
  updated_at: string;
  server_now: string;
  deadline_at: string;
  timer: { duration_seconds: number; elapsed_seconds: number; remaining_seconds: number; is_expired: boolean };
  progress: { total_questions: number; answered: number; unanswered: number; flagged: number; current_question_id: string };
  flagged_question_ids: string[];
  responses?: (StoredResponse & { is_flagged: boolean; selected_answers?: string[] })[];
  grading: { status: 'not_started' | 'pending_grading' | 'graded'; result_available: boolean };
}

export interface QuestionResult {
  question_id: string;
  domain: string;
  difficulty?: string;
  question: CandidateQuestion;
  response: ResponseValue;
  outcome: 'correct' | 'incorrect' | 'unanswered' | 'agent_scored';
  earned_points: number;
  maximum_points: number;
  correct_answers?: string[];
  feedback?: string;
}

export interface Performance {
  total: number;
  correct: number | null;
  incorrect: number | null;
  unanswered: number;
  earned_points: number;
  maximum_points: number;
  percent: number;
}

export interface ExamResult extends Performance {
  grading_mode: ExamDefinition['grading']['mode'];
  passing_percent: number;
  passed: boolean;
  level: string | null;
  domains: (Performance & { domain: string })[];
  questions: QuestionResult[];
}

interface ResultHeader {
  session_id: string;
  exam_id: string;
  title: string;
  started_at: number;
  deadline_at: number;
  submitted_at: number | null;
  submission_reason: SubmissionReason | null;
  time_taken_seconds: number | null;
}

export type ResultView = ResultHeader & (
  | { status: 'in_progress' | 'pending_grading'; result: null }
  | { status: 'graded'; result: ExamResult }
);

export type { AgentGrade, ExamDefinition, ExamFilter, ExamStatus, ExplanationStatus, ExplanationType, ResponseValue } from '@exam-runtime/schemas';
export type { ExamRecord, StoredResponse } from '@exam-runtime/storage';
