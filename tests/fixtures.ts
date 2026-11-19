import type { ExamDefinition } from '@exam-runtime/schemas';

type DefinitionInput = Pick<ExamDefinition, 'schema_version' | 'questions'> & {
  exam: Pick<ExamDefinition['exam'], 'title'> & Partial<ExamDefinition['exam']>;
  grading: Partial<ExamDefinition['grading']>;
};

export function makeAnswerKeyExam(exam: Partial<ExamDefinition['exam']> = {}): DefinitionInput {
  return {
    schema_version: '1.0',
    exam: { title: 'Weighted practice', subject: 'Systems', duration_minutes: 1, ...exam },
    grading: {
      correct_points: 1,
      incorrect_points: 0.1,
      unanswered_points: 0.2,
      passing_percent: 80,
      levels: [
        { name: 'Developing', min_percent: 50 },
        { name: 'Advanced', min_percent: 90 },
        { name: 'Proficient', min_percent: 80 },
      ],
    },
    questions: [
      {
        id: 'single', type: 'single_select', domain: 'Basics', text: 'Choose the first letter.',
        options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct_answers: ['a'],
        points: { correct_points: 0.5 }, metadata: { author_note: 'Not candidate content.' },
      },
      {
        id: 'multi', type: 'multi_select', domain: 'Basics', text: 'Choose the first and third letters.',
        options: [{ id: 'c', text: 'C' }, { id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
        correct_answers: ['a', 'c'], points: { correct_points: 1.5, incorrect_points: 0.25 },
      },
      {
        id: 'truth', type: 'true_false', domain: 'Logic', text: 'The letters A and B are the same.',
        correct_answers: ['false'],
      },
      {
        id: 'blank', type: 'single_select', domain: 'Logic', text: 'Choose the second letter.',
        options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct_answers: ['b'],
      },
    ],
  };
}

export function makeAgentGradedExam(exam: Partial<ExamDefinition['exam']> = {}): DefinitionInput {
  return {
    schema_version: '1.0',
    exam: { title: 'Written practice', subject: 'Systems', duration_minutes: 1, ...exam },
    grading: { mode: 'agent_graded', correct_points: 1, passing_percent: 50 },
    questions: [
      {
        id: 'essay', type: 'free_text', domain: 'Written', text: 'Explain why backups are tested.',
        points: { correct_points: 2 },
      },
      {
        id: 'choice', type: 'single_select', domain: 'Written', text: 'Choose a backup type.',
        options: [{ id: 'full', text: 'Full' }, { id: 'delta', text: 'Incremental' }],
      },
    ],
  };
}
