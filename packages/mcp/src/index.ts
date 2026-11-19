import process from 'node:process';
import { checkExamUi, openRuntime, RuntimeError } from '@exam-runtime/core';
import type { ErrorDetail, ExamRuntime } from '@exam-runtime/core';
import { agentGradesSchema, entityIdSchema, examDefinitionSchema, examFilterSchema } from '@exam-runtime/schemas';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  examRecordSchema, examSummarySchema, examUiSchema, resultViewSchema, sessionViewSchema,
  storedResponsesSchema, toolErrorSchema,
} from './tool-schemas.js';

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
  name: string,
  description: string,
  input: Input,
  data: Output,
  action: (input: z.output<Input>) => NoInfer<z.output<Output>> | Promise<NoInfer<z.output<Output>>>,
) {
  // The SDK returns a text-only error if its input parser rejects arguments. Advertise
  // the real schema and validate it in the callback to preserve structured issue paths.
  const inputSchema = z.looseObject({}).meta(wireSchema(input, 'input'));
  // SDK clients validate structuredContent even when isError is true.
  const envelope = z.strictObject({ data: data.optional(), error: toolErrorSchema.optional() })
    .refine(({ data, error }) => (data === undefined) !== (error === undefined));
  const outputSchema = envelope.meta({
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
      const response = result({ data: await action(parsed.data) });
      // Preserve the error envelope if runtime output no longer matches its contract.
      const checked = outputSchema.safeParse(response.structuredContent);
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

export function createMcpServer(runtime: ExamRuntime): McpServer {
  const server = new McpServer({ name: 'exam-runtime', version: '0.1.0' });

  registerTool(server, 'exam_create', 'Create a draft from a complete exam definition.',
    z.strictObject({ definition: examDefinitionSchema }), examSummarySchema,
    ({ definition }) => runtime.createExam(definition));
  registerTool(server, 'exam_update', 'Replace the complete definition of a draft exam.',
    examId.extend({ definition: examDefinitionSchema }), examSummarySchema,
    ({ exam_id, definition }) => runtime.updateExam(exam_id, definition));
  registerTool(server, 'exam_publish', 'Publish a draft exam so candidates can start it.',
    examId, examSummarySchema, ({ exam_id }) => runtime.publishExam(exam_id));
  registerTool(server, 'exam_list', 'List exam summaries. Filter by status or subject if supplied.',
    examFilterSchema, z.array(examSummarySchema), (filter) => runtime.listExams(filter));
  registerTool(server, 'exam_get', 'Get the full exam record, including the answer key. For trusted operators only.',
    examId, examRecordSchema, ({ exam_id }) => runtime.getExam(exam_id));
  registerTool(server, 'exam_get_session', 'Get a candidate session, including progress and status.',
    sessionId, sessionViewSchema, ({ session_id }) => runtime.getSession(session_id));
  registerTool(server, 'exam_get_answers', 'Get the responses recorded for a candidate session.',
    sessionId, storedResponsesSchema, ({ session_id }) => runtime.getAnswers(session_id));
  registerTool(server, 'exam_get_results', 'Get the grading status and results for a candidate session.',
    sessionId, resultViewSchema, ({ session_id }) => runtime.getResults(session_id));
  registerTool(server, 'exam_submit_grades', 'Submit one score per question for a session pending agent grading.',
    sessionId.extend({ grades: agentGradesSchema }), resultViewSchema,
    ({ session_id, grades }) => runtime.submitGrades(session_id, grades));
  registerTool(server, 'exam_get_ui_url', 'Get the local Web UI URL and report whether it serves the published exam.',
    examId, examUiSchema, ({ exam_id }) => {
      runtime.getPublishedExam(exam_id);
      return checkExamUi(exam_id);
    });

  return server;
}

export async function runMcp(): Promise<void> {
  const runtime = openRuntime();
  try {
    const server = createMcpServer(runtime);
    const transport = new StdioServerTransport();
    const { stdin, stdout } = process;
    const { promise: closed, resolve: onClose } = Promise.withResolvers<void>();
    const reportError = (error: Error) => {
      process.stderr.write(`[exam-runtime MCP] Transport error: ${error.stack ?? error.message}\n`);
    };
    const onOutputError = (error: Error) => {
      reportError(error);
      onClose();
    };
    server.server.onclose = () => onClose();
    server.server.onerror = reportError;
    // The SDK transport handles data and errors but does not close on stdin EOF.
    stdin.once('end', onClose);
    stdin.once('close', onClose);
    stdout.once('close', onClose);
    stdout.once('error', onOutputError);
    try {
      await server.connect(transport);
      if (stdin.readableEnded || stdin.destroyed || stdout.destroyed) onClose();
      await closed;
    } finally {
      stdin.off('end', onClose);
      stdin.off('close', onClose);
      stdout.off('close', onClose);
      try {
        await server.close();
      } finally {
        stdout.off('error', onOutputError);
      }
    }
  } finally {
    runtime.close();
  }
}
