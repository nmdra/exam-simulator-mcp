import { RuntimeError } from './index.js';

export const loopbackHost = '127.0.0.1';

export function runtimePort(value: string | number = process.env.EXAM_RUNTIME_PORT ?? 3000): number {
  const port = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RuntimeError('VALIDATION', 'Choose a port from 1 to 65535 for EXAM_RUNTIME_PORT or --port.');
  }
  return port;
}

export function uiBaseUrl(port = runtimePort()): string {
  const validPort = runtimePort(port);
  return `http://${loopbackHost}${validPort === 80 ? '' : `:${validPort}`}`;
}

export function examUiUrl(examId: string, port = runtimePort()) {
  return `${uiBaseUrl(port)}/exams/${encodeURIComponent(examId)}`;
}

export function sessionUiUrl(sessionId: string, port = runtimePort()) {
  return `${uiBaseUrl(port)}/sessions/${encodeURIComponent(sessionId)}`;
}

export async function checkExamUi(examId: string, port = runtimePort()) {
  const url = examUiUrl(examId, port);
  const unavailable = (message: string) => ({ url, available: false as const, message });
  const base = uiBaseUrl(port);
  const options = { redirect: 'error' as const, signal: AbortSignal.timeout(1_500) };
  try {
    const response = await fetch(`${base}/api/health`, options);
    if (!response.ok) return unavailable('The port is not serving Exam Runtime.');
    const body: unknown = await response.json();
    const data = typeof body === 'object' && body !== null && 'data' in body ? body.data : null;
    if (typeof data !== 'object' || data === null || !('service' in data) || data.service !== 'exam-runtime') {
      return unavailable('The port is not serving Exam Runtime.');
    }
    if (!('ui_available' in data) || data.ui_available !== true) {
      return unavailable('The Web UI is not built. Run npm run build and restart exam-runtime serve.');
    }
    const exam = await fetch(`${base}/api/exams/${encodeURIComponent(examId)}`, options);
    const visible = exam.ok;
    await exam.body?.cancel();
    if (!visible) return unavailable('The running server cannot find this published exam. Verify its database and port.');
    return { url, available: true as const };
  } catch {
    return unavailable('The UI server did not respond. Run exam-runtime serve on the configured port.');
  }
}
