import { z } from 'zod';

const label = z.string().trim().min(1).max(160);
const points = z.number().finite().min(0).max(10_000).multipleOf(0.001);
const positivePoints = points.gt(0);
const percent = z.number().finite().min(0).max(100);
const metadata = z.record(z.string(), z.json()).optional();

export const entityIdSchema = z.uuid();
export const itemIdSchema = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
export const examStatusSchema = z.enum(['draft', 'published']);
export const sessionStatusSchema = z.enum(['in_progress', 'pending_grading', 'graded']);
export const submissionReasonSchema = z.enum(['manual', 'timeout']);
export const gradingModeSchema = z.enum(['answer_key', 'agent_graded']);
export const questionTypeSchema = z.enum(['single_select', 'multi_select', 'true_false', 'free_text']);
export const revisionSchema = z.number().int().nonnegative();
export type ExamStatus = z.infer<typeof examStatusSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SubmissionReason = z.infer<typeof submissionReasonSchema>;

const optionSchema = z.strictObject({ id: itemIdSchema, text: z.string().trim().min(1).max(4_000) });
const levelsSchema = z.array(z.strictObject({ name: label, min_percent: percent })).max(100);
const gradingSchema = z.strictObject({
  mode: gradingModeSchema.default('answer_key'),
  correct_points: positivePoints.default(1),
  incorrect_points: points.default(0),
  unanswered_points: points.default(0),
  passing_percent: percent.default(70),
  levels: levelsSchema.default([]),
});
const overridesSchema = z.strictObject({
  correct_points: positivePoints.optional(),
  incorrect_points: points.optional(),
  unanswered_points: points.optional(),
});
const questionSchema = z.strictObject({
  id: itemIdSchema,
  type: questionTypeSchema,
  domain: label.default('General'),
  difficulty: label.optional(),
  text: z.string().trim().min(1).max(20_000),
  options: z.array(optionSchema).min(2).max(30).optional(),
  correct_answers: z.array(itemIdSchema).min(1).max(30).optional(),
  points: overridesSchema.optional(),
  metadata,
});
const examSchema = z.strictObject({
  title: label,
  description: z.string().max(8_000).default(''),
  instructions: z.string().max(8_000).default(''),
  subject: label.default('General'),
  difficulty: label.optional(),
  mode: z.literal('exam').default('exam'),
  duration_minutes: z.number().int().min(1).max(1_440).default(60),
  shuffle_questions: z.boolean().default(false),
  allow_review: z.boolean().default(true),
  auto_submit_on_timeout: z.boolean().default(true),
  metadata,
});

export const trueFalseOptions = [
  { id: 'true', text: 'True' },
  { id: 'false', text: 'False' },
] as const;

export const examDefinitionSchema = z.strictObject({
  schema_version: z.literal('1.0'),
  exam: examSchema,
  grading: gradingSchema.prefault({}),
  questions: z.array(questionSchema).min(1).max(500),
}).superRefine((doc, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const grading = doc.grading;
  if (grading.incorrect_points > grading.correct_points || grading.unanswered_points > grading.correct_points) {
    issue(['grading'], 'Incorrect and unanswered points cannot exceed correct points.');
  }
  if (grading.mode === 'agent_graded' && (grading.incorrect_points !== 0 || grading.unanswered_points !== 0)) {
    issue(['grading'], 'Agent grading uses explicit scores; incorrect and unanswered points must be zero.');
  }
  const thresholds = new Set<number>();
  const names = new Set<string>();
  for (const [i, level] of grading.levels.entries()) {
    if (thresholds.has(level.min_percent)) issue(['grading', 'levels', i, 'min_percent'], 'Duplicate level threshold.');
    if (names.has(level.name)) issue(['grading', 'levels', i, 'name'], 'Duplicate level name.');
    thresholds.add(level.min_percent);
    names.add(level.name);
  }
  const questionIds = new Set<string>();
  for (const [i, question] of doc.questions.entries()) {
    const key = (field: string) => ['questions', i, field];
    if (questionIds.has(question.id)) issue(key('id'), 'Question IDs must be unique.');
    questionIds.add(question.id);

    const rules = { ...grading, ...question.points };
    if (rules.incorrect_points > rules.correct_points || rules.unanswered_points > rules.correct_points) {
      issue(key('points'), 'Effective incorrect and unanswered points cannot exceed effective correct points.');
    }
    if (grading.mode === 'agent_graded' && (rules.incorrect_points !== 0 || rules.unanswered_points !== 0)) {
      issue(key('points'), 'Agent grading uses explicit scores; incorrect and unanswered points must be zero.');
    }

    if (question.type === 'free_text') {
      if (grading.mode !== 'agent_graded') issue(key('type'), 'Free text requires agent_graded mode.');
      if (question.options) issue(key('options'), 'Free text does not use options.');
      if (question.correct_answers) issue(key('correct_answers'), 'Free text does not use an answer key.');
      continue;
    }
    if (question.type === 'true_false') {
      if (question.options) issue(key('options'), 'True/false has built-in true and false options. Omit options.');
    } else if (!question.options) {
      issue(key('options'), 'Select questions require at least two options.');
    }
    const options = question.type === 'true_false' ? trueFalseOptions : question.options ?? [];
    const ids = new Set(options.map((option) => option.id));
    if (ids.size !== options.length) issue(key('options'), 'Option IDs must be unique.');
    const answers = question.correct_answers;
    if (!answers) {
      if (grading.mode === 'answer_key') issue(key('correct_answers'), 'An answer key is required.');
      continue;
    }
    if (question.type !== 'multi_select' && answers.length !== 1) issue(key('correct_answers'), 'Exactly one correct answer is required.');
    if (new Set(answers).size !== answers.length) issue(key('correct_answers'), 'Correct answer IDs must be unique.');
    for (const [j, id] of answers.entries()) {
      if (!ids.has(id)) issue([...key('correct_answers'), j], 'Answer ID is not a question option.');
    }
  }
});

export const responseSchema = z.union([z.string().max(20_000), z.array(itemIdSchema).max(30), z.boolean(), z.null()]);
export const agentGradeSchema = z.strictObject({ question_id: itemIdSchema, score: points, feedback: z.string().max(8_000).optional() });
export const agentGradesSchema = z.array(agentGradeSchema).min(1).max(500);
export const examFilterSchema = z.strictObject({ status: examStatusSchema.optional(), subject: label.optional() });
export type ExamDefinition = z.output<typeof examDefinitionSchema>;
export type Question = ExamDefinition['questions'][number];
export type ResponseValue = z.infer<typeof responseSchema>;
export type AgentGrade = z.infer<typeof agentGradeSchema>;
export type ExamFilter = z.infer<typeof examFilterSchema>;
