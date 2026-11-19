import { trueFalseOptions } from '@exam-runtime/schemas';
import type { AgentGrade, ExamDefinition, Question, ResponseValue } from '@exam-runtime/schemas';
import type { StoredResponse } from '@exam-runtime/storage';
import type { CandidateQuestion, ExamResult, Performance, QuestionResult } from './contracts.js';

export function candidateQuestion(question: Question): CandidateQuestion {
  return {
    id: question.id, type: question.type, text: question.text, domain: question.domain,
    difficulty: question.difficulty,
    options: question.type === 'true_false' ? [...trueFalseOptions] : question.options,
  };
}

function questionPoints(definition: ExamDefinition, question: Question) {
  return { ...definition.grading, ...question.points };
}

// Accumulate integer thousandths to avoid floating point drift in score totals.
const units = (points: number) => Math.round(points * 1000);
export function maximumPoints(definition: ExamDefinition) {
  return definition.questions.reduce((total, question) => total + units(questionPoints(definition, question).correct_points), 0) / 1000;
}

export function gradeLimit(definition: ExamDefinition, question: Question) {
  return questionPoints(definition, question).correct_points;
}

function matches(response: Exclude<ResponseValue, null>, key: string[]): boolean {
  const selected = Array.isArray(response) ? response : [String(response)];
  return selected.length === key.length && key.every((id) => selected.includes(id));
}

function performance(rows: QuestionResult[], isAgent: boolean): Performance {
  let earned = 0;
  let max = 0;
  let correct = 0;
  let incorrect = 0;
  let unanswered = 0;
  for (const row of rows) {
    earned += units(row.earned_points);
    max += units(row.maximum_points);
    if (row.outcome === 'correct') correct++;
    if (row.outcome === 'incorrect') incorrect++;
    if (row.outcome === 'unanswered') unanswered++;
  }
  return {
    total: rows.length, correct: isAgent ? null : correct, incorrect: isAgent ? null : incorrect, unanswered,
    earned_points: earned / 1000, maximum_points: max / 1000, percent: max ? (earned * 100) / max : 0,
  };
}

export function computeResult(definition: ExamDefinition, responses: StoredResponse[], grades: AgentGrade[] = []): ExamResult {
  const grading = definition.grading;
  const isAgent = grading.mode === 'agent_graded';
  const byQuestion = new Map(responses.map(({ question_id, value }) => [question_id, value]));
  const gradeByQuestion = new Map(grades.map((grade) => [grade.question_id, grade]));
  const byDomain = new Map<string, QuestionResult[]>();
  const questions: QuestionResult[] = definition.questions.map((question) => {
    const response = byQuestion.get(question.id) ?? null;
    const points = questionPoints(definition, question);
    const entry: QuestionResult = {
      question_id: question.id, domain: question.domain, difficulty: question.difficulty,
      question: candidateQuestion(question), response, outcome: 'unanswered',
      earned_points: points.unanswered_points, maximum_points: points.correct_points,
    };
    if (isAgent) {
      const grade = gradeByQuestion.get(question.id);
      if (!grade) throw new Error('Missing validated agent grade.');
      entry.outcome = response === null ? 'unanswered' : 'agent_scored';
      entry.earned_points = grade.score;
      entry.feedback = grade.feedback;
    } else {
      if (!question.correct_answers) throw new Error('Missing validated answer key.');
      entry.correct_answers = question.correct_answers;
      if (response !== null) {
        const correct = matches(response, question.correct_answers);
        entry.outcome = correct ? 'correct' : 'incorrect';
        entry.earned_points = correct ? points.correct_points : points.incorrect_points;
      }
    }
    const domain = byDomain.get(question.domain);
    if (domain) domain.push(entry);
    else byDomain.set(question.domain, [entry]);
    return entry;
  });
  const totals = performance(questions, isAgent);
  const level = [...grading.levels].sort((a, b) => b.min_percent - a.min_percent)
    .find((candidate) => totals.percent >= candidate.min_percent)?.name ?? null;
  return {
    ...totals, grading_mode: grading.mode, passing_percent: grading.passing_percent,
    passed: totals.percent >= grading.passing_percent, level, questions,
    domains: Array.from(byDomain, ([domain, entries]) => ({ domain, ...performance(entries, isAgent) })),
  };
}
