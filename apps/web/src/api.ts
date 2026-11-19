import type { ExamSummary, ResponseValue, ResultView, SessionView } from '@exam-runtime/core';

type ErrorEnvelope = { error: { code: string; message: string; details: unknown } };

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, signal, cache: 'no-store',
    headers: { Accept: 'application/json', ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Exam-Runtime': '1' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as { data: T } | ErrorEnvelope | null;
  if (!response.ok || !payload || !('data' in payload)) {
    const message = payload && 'error' in payload ? payload.error.message : `The request could not be completed (${response.status}).`;
    throw new ApiError(response.status, message);
  }
  return payload.data;
}

export const examPath = (id: string) => `/exams/${encodeURIComponent(id)}`;
export const sessionPath = (id: string) => `/sessions/${encodeURIComponent(id)}`;
export const resultPath = (id: string) => `${sessionPath(id)}/results`;

export const api = {
  exams: (signal?: AbortSignal) => request<ExamSummary[]>('/exams', 'GET', undefined, signal),
  exam: (id: string, signal?: AbortSignal) => request<ExamSummary>(examPath(id), 'GET', undefined, signal),
  start: (id: string) => request<SessionView>(`${examPath(id)}/sessions`, 'POST', {}),
  session: (id: string, signal?: AbortSignal) => request<SessionView>(sessionPath(id), 'GET', undefined, signal),
  answer: (id: string, questionId: string, value: ResponseValue, revision: number) =>
    request<SessionView>(`${sessionPath(id)}/responses/${encodeURIComponent(questionId)}`, 'PUT', { value, revision }),
  flag: (id: string, questionId: string, flagged: boolean, revision: number) =>
    request<SessionView>(`${sessionPath(id)}/flags/${encodeURIComponent(questionId)}`, 'PUT', { flagged, revision }),
  submit: (id: string) => request<ResultView>(`${sessionPath(id)}/submit`, 'POST', {}),
  results: (id: string, signal?: AbortSignal) => request<ResultView>(resultPath(id), 'GET', undefined, signal),
};

export const errorMessage = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Cannot reach the exam server. Check your connection and try again.';
