import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z } from 'zod';
import { loopbackHost, runtimePort, RuntimeError, uiBaseUrl } from '@exam-runtime/core';
import type { ExamRuntime } from '@exam-runtime/core';
import { entityIdSchema, examFilterSchema, itemIdSchema, responseSchema, revisionSchema } from '@exam-runtime/schemas';

const examParams = z.strictObject({ examId: entityIdSchema });
const sessionParams = z.strictObject({ sessionId: entityIdSchema });
const questionParams = sessionParams.extend({ questionId: itemIdSchema });
const answerBody = z.strictObject({ value: responseSchema, revision: revisionSchema });
const flagBody = z.strictObject({ flagged: z.boolean(), revision: revisionSchema });
const emptyBody = z.strictObject({});
const publishedFilter = examFilterSchema.pick({ subject: true });
const root = fileURLToPath(new URL('../../../apps/web/dist/', import.meta.url));

function parse<T>(schema: z.ZodType<T>, input: unknown, scope: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new RuntimeError('VALIDATION', 'Request failed validation.', result.error.issues.map(({ path, message }) => ({
    path: [scope, ...path.map((part) => typeof part === 'number' ? part : String(part))], message,
  })));
}

const data = <T>(value: T) => ({ data: value });
const error = (code: string, message: string, details: RuntimeError['details'] = []) => ({ error: { code, message, details } });

export function buildServer(runtime: ExamRuntime, options: { port?: number; webRoot?: string | false; logger?: boolean } = {}) {
  const port = runtimePort(options.port);
  const origin = uiBaseUrl(port);
  const authority = port === 80 ? loopbackHost : `${loopbackHost}:${port}`;
  const webRoot = options.webRoot === false ? false : resolve(options.webRoot ?? root);
  const uiAvailable = webRoot !== false && existsSync(resolve(webRoot, 'index.html'));
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_048_576 });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (request.url.startsWith('/api/') || request.url === '/api') reply.header('Cache-Control', 'no-store');
    const host = request.headers.host;
    if (host !== authority && host !== `${loopbackHost}:${port}`) {
      return reply.code(403).send(error('FORBIDDEN', `Use the local address ${origin}.`));
    }
    // No CORS headers are sent. Only a same-origin browser or a local CLI may use the API.
    if (request.headers.origin !== undefined && request.headers.origin !== origin) {
      return reply.code(403).send(error('FORBIDDEN', 'Cross-origin requests are not supported.'));
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.headers['x-exam-runtime'] !== '1' || request.headers['sec-fetch-site'] === 'cross-site') {
        return reply.code(403).send(error('FORBIDDEN', 'Writes require the X-Exam-Runtime: 1 header from the local UI or client.'));
      }
      const type = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
      if (type !== 'application/json') {
        return reply.code(415).send(error('UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json.'));
      }
    }
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof RuntimeError) {
      const status = { VALIDATION: 400, NOT_FOUND: 404, CONFLICT: 409, UI_UNAVAILABLE: 503 }[err.code];
      return reply.code(status).send(error(err.code, err.message, err.details));
    }
    const status = typeof err === 'object' && err !== null && 'statusCode' in err ? err.statusCode : undefined;
    if (status === 400) return reply.code(400).send(error('VALIDATION', 'Malformed JSON or invalid request.'));
    if (status === 413) return reply.code(413).send(error('PAYLOAD_TOO_LARGE', 'The request body is too large.'));
    if (status === 415) return reply.code(415).send(error('UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json.'));
    request.log.error({ err }, 'Unexpected request failure');
    return reply.code(500).send(error('INTERNAL', 'An unexpected runtime error occurred.'));
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(error('NOT_FOUND', 'Route not found.')));

  app.get('/api/health', () => data({ service: 'exam-runtime', ui_available: uiAvailable }));
  app.get('/api/exams', (request) => {
    const filter = parse(publishedFilter, request.query, 'query');
    return data(runtime.listExams({ ...filter, status: 'published' }));
  });
  app.get('/api/exams/:examId', (request) => data(runtime.getPublishedExam(parse(examParams, request.params, 'params').examId)));
  app.post('/api/exams/:examId/sessions', (request, reply) => {
    const { examId } = parse(examParams, request.params, 'params');
    parse(emptyBody, request.body, 'body');
    const session = runtime.startSession(examId);
    return reply.code(201).header('Location', `/api/sessions/${session.id}`).send(data(session));
  });
  app.get('/api/sessions/:sessionId', (request) => data(runtime.getSession(parse(sessionParams, request.params, 'params').sessionId)));
  app.put('/api/sessions/:sessionId/responses/:questionId', (request) => {
    const { sessionId, questionId } = parse(questionParams, request.params, 'params');
    const { value, revision } = parse(answerBody, request.body, 'body');
    return data(runtime.recordAnswer(sessionId, questionId, value, revision));
  });
  app.put('/api/sessions/:sessionId/flags/:questionId', (request) => {
    const { sessionId, questionId } = parse(questionParams, request.params, 'params');
    const { flagged, revision } = parse(flagBody, request.body, 'body');
    return data(runtime.setFlag(sessionId, questionId, flagged, revision));
  });
  app.post('/api/sessions/:sessionId/submit', (request) => {
    const { sessionId } = parse(sessionParams, request.params, 'params');
    parse(emptyBody, request.body, 'body');
    return data(runtime.submitSession(sessionId, false));
  });
  app.get('/api/sessions/:sessionId/results', (request) => data(runtime.getResults(parse(sessionParams, request.params, 'params').sessionId, false)));

  if (uiAvailable) {
    app.register(fastifyStatic, { root: webRoot, wildcard: false, index: false });
    for (const route of ['/', '/exams/:examId', '/sessions/:sessionId', '/sessions/:sessionId/results']) {
      app.get(route, (_request, reply) => reply.header('Cache-Control', 'no-cache').sendFile('index.html'));
    }
  } else {
    app.get('/', (_request, reply) => reply.code(503).send(error('UI_UNAVAILABLE', 'Run npm run build and restart the server.')));
  }

  let sweep: NodeJS.Timeout | undefined;
  app.addHook('onListen', async () => {
    const expire = () => {
      try { runtime.finalizeExpired(); }
      catch (err) { app.log.error({ err }, 'Failed to check exam deadlines'); }
    };
    expire();
    sweep = setInterval(expire, 5_000);
    sweep.unref();
  });
  app.addHook('onClose', async () => clearInterval(sweep));
  return app;
}

export async function serveRuntime(runtime: ExamRuntime, port = runtimePort()) {
  const app = buildServer(runtime, { port });
  try {
    await app.listen({ host: loopbackHost, port });
    return app;
  } catch (err) {
    await app.close();
    throw err;
  }
}
