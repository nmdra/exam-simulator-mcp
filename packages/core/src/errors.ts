export type ErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'UI_UNAVAILABLE';
export interface ErrorDetail { path: (string | number)[]; message: string }

export class RuntimeError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details: ErrorDetail[] = []) {
    super(message);
    this.name = 'RuntimeError';
  }
}

export function validated<T>(parsed: { success: true; data: T } | {
  success: false; error: { issues: { path: PropertyKey[]; message: string }[] };
}): T {
  if (parsed.success) return parsed.data;
  throw new RuntimeError('VALIDATION', 'Input failed validation.', parsed.error.issues.map(({ path, message }) => ({
    path: path.map((segment) => typeof segment === 'number' ? segment : String(segment)), message,
  })));
}
