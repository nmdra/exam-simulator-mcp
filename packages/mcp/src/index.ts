import { readFileSync } from 'node:fs';
import { checkExamUi, createRevisionWatcher, openRuntime, RuntimeError } from '@exam-runtime/core';
import type { AgentPrincipal, ErrorDetail, ExamRuntime } from '@exam-runtime/core';
import {
  agentGradesSchema, claimTokenSchema, entityIdSchema, examDefinitionSchema, examFilterSchema,
  explanationContentSchema, explanationStatusSchema, sessionListFilterSchema,
} from '@exam-runtime/schemas';
import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult, Transport } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import {
  examRecordSchema, examStateSchema, examSummarySchema, examUiSchema, explanationDetailSchema,
  explanationRequestSummarySchema, explanationViewSchema, resultViewSchema, sessionSummarySchema, sessionViewSchema,
  storedResponsesSchema, toolErrorSchema,
} from './tool-schemas.js';
import { authenticateAgent, filterListenResources, registerResources } from './resources.js';

const examId = z.strictObject({ exam_id: entityIdSchema });
const sessionId = z.strictObject({ session_id: entityIdSchema });

type ToolError = z.output<typeof toolErrorSchema>;

function result(payload: { data: unknown } | { error: ToolError }): CallToolResult {
  try {
    const text = JSON.stringify(payload);
    // Remove undefined optional properties so the two representations also match in memory.
    const structuredContent = JSON.parse(text) as typeof payload;
    const response: CallToolResult = { structuredContent, content: [{ type: 'text', text }] };
    if ('error' in payload) response.isError = true;
    return response;
  } catch (cause) {
    throw new Error('Could not encode the tool response.', { cause });
  }
}

function readServerVersion() {
  const manifest = new URL('../../../package.json', import.meta.url);
  try {
    const version = z.object({ version: z.string().min(1) });
    return version.parse(JSON.parse(readFileSync(manifest, 'utf8'))).version;
  } catch (cause) {
    throw new Error('Cannot read the Exam Runtime version.', { cause });
  }
}

function wireSchema(schema: z.ZodObject, io: 'input' | 'output') {
  return z.toJSONSchema(schema, {
    io,
    target: 'draft-7',
    override: ({ jsonSchema }) => {
      // SDK client validators can reject valid thousandths (such as 4.001) due to
      // binary rounding. The original Zod schemas still enforce score precision.
      if (jsonSchema.multipleOf === 0.001) delete jsonSchema.multipleOf;
    },
  });
}

function advertisedSchema<Schema extends z.ZodObject>(schema: Schema, jsonSchema: Record<string, unknown>) {
  const standard = schema['~standard'];
  return { '~standard': { ...standard, jsonSchema: { input: () => jsonSchema, output: () => jsonSchema } } };
}

function validationDetails(issues: z.ZodError['issues']): ErrorDetail[] {
  return issues.flatMap((issue) => {
    const path = issue.path.map((key) => typeof key === 'number' ? key : String(key));
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({ path: [...path, key], message: 'Unexpected property.' }));
    }
    return [{ path, message: issue.message }];
  });
}

function registerTool<Input extends z.ZodObject, Output extends z.ZodType>(
  server: McpServer,
  runtime: ExamRuntime,
  name: string,
  description: string,
  input: Input,
  data: Output,
  action: (input: z.output<Input>, principal: AgentPrincipal) => NoInfer<z.output<Output>> | Promise<NoInfer<z.output<Output>>>,
) {
  // The SDK returns a text-only error if its input parser rejects arguments. Advertise
  // the real schema and validate it in the callback to preserve structured issue paths.
  const inputSchema = advertisedSchema(z.looseObject({}), wireSchema(input, 'input'));
  // SDK clients validate structuredContent even when isError is true.
  const envelope = z.strictObject({ data: data.optional(), error: toolErrorSchema.optional() })
    .refine(({ data, error }) => (data === undefined) !== (error === undefined));
  const outputSchema = advertisedSchema(envelope, {
    ...wireSchema(envelope, 'output'),
    oneOf: [{ required: ['data'] }, { required: ['error'] }],
  });

  server.registerTool(name, { description, inputSchema, outputSchema }, async (args) => {
    try {
      const parsed = input.safeParse(args);
      if (!parsed.success) {
        return result({ error: {
          code: 'VALIDATION', message: 'Input failed validation.', details: validationDetails(parsed.error.issues),
        } });
      }
      const response = result({ data: await action(parsed.data, authenticateAgent(runtime)) });
      // Preserve the error envelope if runtime output no longer matches its contract.
      const checked = envelope.safeParse(response.structuredContent);
      if (!checked.success) throw checked.error;
      return response;
    } catch (error) {
      if (error instanceof RuntimeError) {
        return result({ error: { code: error.code, message: error.message, details: error.details } });
      }
      console.error(`[exam-runtime MCP] ${name} failed:`, error);
      return result({ error: { code: 'INTERNAL', message: 'The tool could not complete the request.', details: [] } });
    }
  });
}

export function createMcpServer(runtime: ExamRuntime, subscribe = false): McpServer {
  const server = new McpServer({ name: 'exam-runtime', version: readServerVersion() }, {
    capabilities: { resources: { subscribe } },
  });

  registerTool(server, runtime, 'exam_create', 'Create a draft from a complete exam definition.',
    z.strictObject({ definition: examDefinitionSchema }), examSummarySchema,
    ({ definition }, principal) => runtime.createExam(definition, principal.scope));
  registerTool(server, runtime, 'exam_update', 'Replace the complete definition of a draft exam.',
    examId.extend({ definition: examDefinitionSchema }), examSummarySchema,
    ({ exam_id, definition }, principal) => {
      runtime.assertExamAccess(exam_id, principal);
      return runtime.updateExam(exam_id, definition);
    });
  registerTool(server, runtime, 'exam_publish', 'Publish a draft exam so candidates can start it.',
    examId, examSummarySchema, ({ exam_id }, principal) => {
      runtime.assertExamAccess(exam_id, principal);
      return runtime.publishExam(exam_id);
    });
  registerTool(server, runtime, 'exam_list', 'List exam summaries. Filter by status or subject if supplied.',
    examFilterSchema, z.array(examSummarySchema),
    (filter, principal) => runtime.listExams(filter, principal.operator ? undefined : principal.scope));
  registerTool(server, runtime, 'exam_get', 'Get the full exam record, including the answer key. For trusted operators only.',
    examId, examRecordSchema, ({ exam_id }, principal) => {
      runtime.assertExamAccess(exam_id, principal);
      return runtime.getExam(exam_id);
    });
  registerTool(server, runtime, 'exam_list_sessions', 'List recent attempts in your scope without questions, answers, or results.',
    sessionListFilterSchema, z.array(sessionSummarySchema), (filter, principal) => runtime.listSessions(principal, filter));
  registerTool(server, runtime, 'exam_get_session', 'Get a candidate session, including progress and status.',
    sessionId, sessionViewSchema, ({ session_id }, principal) => {
      runtime.assertSessionAccess(session_id, principal);
      return runtime.getSession(session_id);
    });
  registerTool(server, runtime, 'exam_get_answers', 'Get the responses recorded for a candidate session.',
    sessionId, storedResponsesSchema, ({ session_id }, principal) => {
      runtime.assertSessionAccess(session_id, principal);
      return runtime.getAnswers(session_id);
    });
  registerTool(server, runtime, 'exam_get_results', 'Get the grading status and results for a candidate session.',
    sessionId, resultViewSchema, ({ session_id }, principal) => {
      runtime.assertSessionAccess(session_id, principal);
      return runtime.getResults(session_id);
    });
  registerTool(server, runtime, 'exam_submit_grades', 'Submit one score per question for a session pending agent grading.',
    sessionId.extend({ grades: agentGradesSchema }), resultViewSchema,
    ({ session_id, grades }, principal) => {
      runtime.assertSessionAccess(session_id, principal);
      return runtime.submitGrades(session_id, grades);
    });
  registerTool(server, runtime, 'exam_get_ui_url', 'Get the local Web UI URL and report whether it serves the published exam.',
    examId, examUiSchema, ({ exam_id }, principal) => {
      runtime.assertExamAccess(exam_id, principal);
      runtime.getPublishedExam(exam_id);
      return checkExamUi(exam_id);
    });

  registerTool(server, runtime, 'exam_get_state', 'Get the current exam state. Responses are omitted unless explicitly requested.',
    sessionId.extend({ include_responses: z.boolean().default(false) }), examStateSchema,
    ({ session_id, include_responses }, principal) => runtime.getState(session_id, principal, include_responses));

  const requestId = z.strictObject({ request_id: entityIdSchema });
  registerTool(server, runtime, 'explanation_requests_list', 'List explanation requests in your agent scope.',
    z.strictObject({ status: explanationStatusSchema.optional(), limit: z.number().int().min(1).max(100).optional() }),
    z.array(explanationRequestSummarySchema),
    ({ status, limit }, principal) => runtime.explanations.list(principal, status, limit));
  registerTool(server, runtime, 'explanation_request_get', 'Get an explanation request and its permitted question context.',
    requestId, explanationDetailSchema,
    ({ request_id }, principal) => runtime.explanations.get(principal, request_id));
  registerTool(server, runtime, 'explanation_claim', 'Claim a pending explanation request and get a short-lived token.',
    requestId, z.strictObject({ claim_token: claimTokenSchema, expires_at: z.number().int() }),
    ({ request_id }, principal) => runtime.explanations.claim(principal, request_id));
  registerTool(server, runtime, 'explanation_submit', 'Submit a completed explanation with the token from your claim.',
    requestId.extend({ claim_token: claimTokenSchema, content: explanationContentSchema }), explanationViewSchema,
    ({ request_id, claim_token, content }, principal) => runtime.explanations.submit(principal, request_id, claim_token, content));

  registerResources(server, runtime);
  return server;
}

export async function runMcp(): Promise<void> {
  const runtime = openRuntime();
  const reportError = (error: unknown) => console.error('[exam-runtime MCP]', error);
  const watcher = createRevisionWatcher(runtime, reportError);
  const maintain = setInterval(() => {
    try { runtime.maintain(); }
    catch (error) { reportError(error); }
  }, 1_000).unref();

  try {
    const stdio = new StdioServerTransport();
    const { promise: closed, resolve: onClose, reject: onStartError } = Promise.withResolvers<void>();
    const watched = new Set<string>();
    let modern: McpServer | undefined;
    const transport: Transport = {
      async start() {
        stdio.onmessage = (message) => transport.onmessage?.(filterListenResources(message, runtime, (uri, key) => {
          if (watched.has(uri)) return true;
          if (watched.size >= 64) return false;
          watcher.watch(key, () => { void modern?.server.sendResourceUpdated({ uri }).catch(reportError); });
          watched.add(uri);
          return true;
        }));
        stdio.onerror = (error) => transport.onerror?.(error);
        stdio.onclose = () => {
          transport.onclose?.();
          onClose();
        };
        try { await stdio.start(); }
        catch (error) { onStartError(error); throw error; }
      },
      close: () => stdio.close(),
      send: (message) => stdio.send(message),
    };
    const handle = serveStdio(({ era }) => {
      const server = createMcpServer(runtime, era === 'modern');
      modern = era === 'modern' ? server : undefined;
      return server;
    }, { transport, onerror: reportError, maxSubscriptions: 64 });
    try {
      await closed;
    } finally {
      await handle.close();
    }
  } finally {
    clearInterval(maintain);
    watcher.close();
    runtime.close();
  }
}
