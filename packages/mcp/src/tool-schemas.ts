import {
  entityIdSchema, examDefinitionSchema, examStatusSchema, gradingModeSchema, itemIdSchema,
  questionTypeSchema, responseSchema, revisionSchema, sessionStatusSchema, submissionReasonSchema,
} from '@exam-runtime/schemas';
import { z } from 'zod';

const timestamp = z.number().int();
const count = z.number().int().nonnegative();
const difficulty = z.string().optional();

export const examSummarySchema = z.strictObject({
  id: entityIdSchema,
  status: examStatusSchema,
  title: z.string(),
  subject: z.string(),
  difficulty,
  description: z.string(),
  instructions: z.string(),
  question_count: count,
  duration_minutes: count,
  grading_mode: gradingModeSchema,
  passing_percent: z.number(),
  maximum_points: z.number(),
  allow_review: z.boolean(),
  auto_submit_on_timeout: z.boolean(),
  created_at: timestamp,
  updated_at: timestamp,
});

export const examRecordSchema = z.strictObject({
  ...examSummarySchema.pick({ id: true, status: true, created_at: true, updated_at: true }).shape,
  definition: examDefinitionSchema,
});

const candidateQuestionSchema = z.strictObject({
  id: itemIdSchema,
  type: questionTypeSchema,
  text: z.string(),
  domain: z.string(),
  difficulty,
  options: z.array(z.strictObject({ id: itemIdSchema, text: z.string() })).optional(),
});

export const storedResponsesSchema = z.array(z.strictObject({
  question_id: itemIdSchema,
  value: responseSchema,
  updated_at: timestamp,
}));

const sessionTiming = {
  started_at: timestamp,
  deadline_at: timestamp,
  submitted_at: timestamp.nullable(),
  submission_reason: submissionReasonSchema.nullable(),
};

export const sessionViewSchema = z.strictObject({
  id: entityIdSchema,
  exam_id: entityIdSchema,
  title: z.string(),
  subject: z.string(),
  status: sessionStatusSchema,
  ...sessionTiming,
  revision: revisionSchema,
  server_now: timestamp,
  expired: z.boolean(),
  allow_review: z.boolean(),
  auto_submit_on_timeout: z.boolean(),
  grading_mode: gradingModeSchema,
  questions: z.array(candidateQuestionSchema),
  responses: storedResponsesSchema,
  flagged_question_ids: z.array(itemIdSchema),
  progress: z.strictObject({ total: count, answered: count, unanswered: count, flagged: count }),
});

const performance = {
  total: count,
  correct: count.nullable(),
  incorrect: count.nullable(),
  unanswered: count,
  earned_points: z.number(),
  maximum_points: z.number(),
  percent: z.number(),
};

const examResultSchema = z.strictObject({
  ...performance,
  grading_mode: gradingModeSchema,
  passing_percent: z.number(),
  passed: z.boolean(),
  level: z.string().nullable(),
  domains: z.array(z.strictObject({ domain: z.string(), ...performance })),
  questions: z.array(z.strictObject({
    question_id: itemIdSchema,
    domain: z.string(),
    difficulty,
    question: candidateQuestionSchema,
    response: responseSchema,
    outcome: z.enum(['correct', 'incorrect', 'unanswered', 'agent_scored']),
    earned_points: z.number(),
    maximum_points: z.number(),
    correct_answers: z.array(itemIdSchema).optional(),
    feedback: z.string().optional(),
  })),
});

const resultHeader = {
  session_id: entityIdSchema,
  exam_id: entityIdSchema,
  title: z.string(),
  ...sessionTiming,
  time_taken_seconds: count.nullable(),
};

export const resultViewSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...resultHeader, status: z.enum(['in_progress', 'pending_grading']), result: z.null() }),
  z.strictObject({ ...resultHeader, status: z.literal('graded'), result: examResultSchema }),
]);

export const examUiSchema = z.discriminatedUnion('available', [
  z.strictObject({ url: z.url(), available: z.literal(true) }),
  z.strictObject({ url: z.url(), available: z.literal(false), message: z.string() }),
]);

export const toolErrorSchema = z.strictObject({
  code: z.enum(['VALIDATION', 'NOT_FOUND', 'CONFLICT', 'UI_UNAVAILABLE', 'INTERNAL']),
  message: z.string(),
  details: z.array(z.strictObject({ path: z.array(z.union([z.string(), count])), message: z.string() })),
});
