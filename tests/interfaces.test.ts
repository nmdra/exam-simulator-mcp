import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openRuntime } from '@exam-runtime/core';
import type { ExamRecord, ExamSummary, ResultView, SessionView, StoredResponse } from '@exam-runtime/core';
import { buildServer } from '@exam-runtime/server';
import { describe, expect, it } from 'vitest';
import { makeAgentGradedExam, makeAnswerKeyExam } from './fixtures.js';

const cliEntry = fileURLToPath(new URL('../packages/cli/dist/main.js', import.meta.url));
const mcpEntry = fileURLToPath(new URL('../packages/mcp/dist/main.js', import.meta.url));
const fixturePath = fileURLToPath(new URL('../examples/aws-practice.json', import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port.');
  return address.port;
}

async function connectMcp(entry: string[], dbPath: string, port: number) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: entry, stderr: 'pipe',
    env: { EXAM_RUNTIME_DB_PATH: dbPath, EXAM_RUNTIME_PORT: String(port) },
  });
  const client = new Client({ name: 'exam-runtime-integration', version: '1.0.0' });
  const diagnostics: string[] = [];
  transport.stderr?.on('data', (data: Buffer | string) => diagnostics.push(String(data)));
  await client.connect(transport);
  return { client, diagnostics };
}

async function mcpData<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toHaveProperty('data');
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
  if (!result.structuredContent || typeof result.structuredContent !== 'object' || !('data' in result.structuredContent)) {
    throw new Error(`Missing data in ${name} response.`);
  }
  return result.structuredContent.data as T;
}

describe('candidate HTTP API', () => {
  it('publishes only safe metadata, validates writes, restores answers, and exposes review only after grading', async () => {
    const runtime = openRuntime(':memory:');
    const app = buildServer(runtime, { port: 3000, webRoot: false });
    const host = '127.0.0.1:3000';
    const headers = { host, 'x-exam-runtime': '1', 'content-type': 'application/json', origin: `http://${host}` };
    try {
      const draft = runtime.createExam(makeAnswerKeyExam());
      const exam = runtime.publishExam(runtime.createExam(makeAnswerKeyExam({ allow_review: false })).id);
      const list = await app.inject({ method: 'GET', url: '/api/exams', headers: { host } });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({ data: [{ id: exam.id }] });
      expect(list.body).not.toContain('correct_answers');
      expect(list.headers['cache-control']).toBe('no-store');
      expect((await app.inject({ url: `/api/exams/${draft.id}`, headers: { host } })).statusCode).toBe(404);
      const start = `/api/exams/${exam.id}/sessions`;
      expect((await app.inject({ method: 'POST', url: start, headers: { host }, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: start, headers, payload: { unexpected: true } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: start, headers: { ...headers, 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(415);
      expect((await app.inject({ method: 'POST', url: start, headers, payload: '{' })).statusCode).toBe(400);
      const started = await app.inject({ method: 'POST', url: start, headers, payload: {} });
      expect(started.statusCode).toBe(201);
      const { data: session } = started.json<{ data: SessionView }>();
      const sessionUrl = `/api/sessions/${session.id}`;
      expect(started.headers.location).toBe(sessionUrl);
      expect(started.body).not.toMatch(/correct_answers|author_note/);
      const answer = await app.inject({ method: 'PUT', url: `${sessionUrl}/responses/single`, headers, payload: { value: 'a', revision: 0 } });
      expect(answer.statusCode).toBe(200);
      expect(answer.body).not.toContain('correct_answers');
      expect((await app.inject({ method: 'PUT', url: `${sessionUrl}/responses/single`, headers, payload: { value: 'b', revision: 0 } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'PUT', url: `${sessionUrl}/flags/single`, headers, payload: { flagged: true, revision: 1 } })).statusCode).toBe(409);
      const restored = await app.inject({ url: sessionUrl, headers: { host } });
      expect(restored.json()).toMatchObject({ data: { deadline_at: session.deadline_at, responses: [{ question_id: 'single', value: 'a' }] } });
      expect(restored.body).not.toContain('correct_answers');
      const early = await app.inject({ url: `${sessionUrl}/results`, headers: { host } });
      expect(early.json()).toMatchObject({ data: { status: 'in_progress', result: null } });
      const submitted = await app.inject({ method: 'POST', url: `${sessionUrl}/submit`, headers, payload: {} });
      expect(submitted.json()).toMatchObject({ data: { status: 'graded', result: { correct: 1, unanswered: 3, questions: [] } } });
      expect(submitted.body).not.toContain('correct_answers');
      const results = await app.inject({ url: `${sessionUrl}/results`, headers: { host } });
      expect(results.json()).toEqual(submitted.json());
      expect((await app.inject({ method: 'PUT', url: `${sessionUrl}/responses/single`, headers, payload: { value: 'b', revision: 2 } })).statusCode).toBe(409);
    } finally {
      await app.close();
      runtime.close();
    }
  });
});

it('shares a durable database across a real MCP client, HTTP server, and CLI through both grading flows', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'exam-runtime-interfaces-'));
  const dbPath = join(folder, 'shared.sqlite');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const cli = (...args: string[]) => execFileSync(process.execPath, [cliEntry, ...args], {
    encoding: 'utf8', env: { ...process.env, EXAM_RUNTIME_DB_PATH: dbPath, EXAM_RUNTIME_PORT: String(port) }, timeout: 5_000,
  });
  let app: ReturnType<typeof buildServer> | undefined;
  let runtime: ReturnType<typeof openRuntime> | undefined;
  let client: Client | undefined;
  try {
    expect(cli('init')).toContain(dbPath);
    const imported = cli('exam', 'import', fixturePath);
    const importedId = imported.split(' ')[1]!;
    expect(cli('exam', 'list', '--status', 'draft')).toContain(importedId);
    expect(JSON.parse(cli('exam', 'show', importedId))).toMatchObject({ status: 'draft' });
    expect(cli('exam', 'publish', importedId)).toContain('[published]');
    const mcp = await connectMcp([mcpEntry], dbPath, port);
    client = mcp.client;
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'exam_create', 'exam_get', 'exam_get_answers', 'exam_get_results', 'exam_get_session',
      'exam_get_ui_url', 'exam_list', 'exam_publish', 'exam_submit_grades', 'exam_update',
    ]));
    const create = tools.tools.find((tool) => tool.name === 'exam_create');
    expect(create?.inputSchema).toMatchObject({ type: 'object', required: ['definition'] });
    expect(create?.outputSchema).toMatchObject({ type: 'object', properties: { data: {}, error: {} } });
    const invalid = await client.callTool({ name: 'exam_create', arguments: { definition: { schema_version: '9' } } });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ error: { code: 'VALIDATION', details: expect.arrayContaining([
      expect.objectContaining({ path: ['definition', 'schema_version'] }),
    ]) } });
    const bad = await client.callTool({ name: 'exam_get', arguments: { exam_id: 'not-a-uuid' } });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({ error: { code: 'VALIDATION' } });

    const answerKey = makeAnswerKeyExam();
    const exam = await mcpData<ExamSummary>(client, 'exam_create', { definition: answerKey });
    expect(exam.status).toBe('draft');
    const updated = await mcpData<ExamSummary>(client, 'exam_update', { exam_id: exam.id, definition: { ...answerKey, exam: { ...answerKey.exam, title: 'MCP updated' } } });
    expect(updated.title).toBe('MCP updated');
    expect((await mcpData<ExamSummary>(client, 'exam_publish', { exam_id: exam.id })).status).toBe('published');
    const trusted = await mcpData<ExamRecord>(client, 'exam_get', { exam_id: exam.id });
    expect(trusted.definition.questions[0]?.correct_answers).toEqual(['a']);
    expect(await mcpData(client, 'exam_get_ui_url', { exam_id: exam.id })).toMatchObject({ available: false, url: `${base}/exams/${exam.id}` });
    const exams = await mcpData<ExamSummary[]>(client, 'exam_list', { status: 'published', subject: 'Systems' });
    expect(exams.map((entry) => entry.id)).toEqual([exam.id]);

    const webRoot = join(folder, 'web');
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Exam Runtime</title>');
    runtime = openRuntime(dbPath);
    app = buildServer(runtime, { port, webRoot });
    await app.listen({ host: '127.0.0.1', port });
    const http = async <T>(path: string, method = 'GET', payload?: unknown): Promise<T> => {
      const response = await fetch(`${base}/api${path}`, {
        method,
        ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-Exam-Runtime': '1' }, body: JSON.stringify(payload) }),
      });
      if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${await response.text()}`);
      const { data } = await response.json() as { data: T };
      return data;
    };
    expect(await mcpData(client, 'exam_get_ui_url', { exam_id: exam.id })).toMatchObject({ available: true });
    const candidatePage = await fetch(`${base}/exams/${exam.id}`);
    expect(candidatePage.status).toBe(200);
    expect(await candidatePage.text()).toContain('Exam Runtime');
    const attempt = await http<SessionView>(`/exams/${exam.id}/sessions`, 'POST', {});
    const url = `/sessions/${attempt.id}`;
    await http(`${url}/responses/single`, 'PUT', { value: 'a', revision: 0 });
    await http(`${url}/responses/multi`, 'PUT', { value: ['a', 'c'], revision: 1 });
    await http(`${url}/responses/truth`, 'PUT', { value: false, revision: 2 });
    await http(`${url}/responses/blank`, 'PUT', { value: 'b', revision: 3 });
    await http(`${url}/flags/multi`, 'PUT', { flagged: true, revision: 4 });
    const saved = await mcpData<SessionView>(client, 'exam_get_session', { session_id: attempt.id });
    expect(saved.progress).toEqual({ total: 4, answered: 4, unanswered: 0, flagged: 1 });
    const recorded = await mcpData<StoredResponse[]>(client, 'exam_get_answers', { session_id: attempt.id });
    expect(recorded).toHaveLength(4);
    expect(recorded.find((answer) => answer.question_id === 'truth')?.value).toBe(false);
    const graded = await http<ResultView>(`${url}/submit`, 'POST', {});
    expect(graded).toMatchObject({ status: 'graded', result: { correct: 4, percent: 100, level: 'Advanced', passed: true } });
    expect(await mcpData(client, 'exam_get_results', { session_id: attempt.id })).toEqual(graded);

    const agent = await mcpData<ExamSummary>(client, 'exam_create', { definition: makeAgentGradedExam() });
    await mcpData(client, 'exam_publish', { exam_id: agent.id });
    const agentAttempt = await http<SessionView>(`/exams/${agent.id}/sessions`, 'POST', {});
    const agentUrl = `/sessions/${agentAttempt.id}`;
    await http(`${agentUrl}/responses/essay`, 'PUT', { revision: 0, value: 'Verify that recovery works before an incident.' });
    expect(await http(`${agentUrl}/submit`, 'POST', {})).toMatchObject({ status: 'pending_grading', result: null });
    expect(cli('results', agentAttempt.id)).toContain('Pending grading');
    const invalidGrade = await client.callTool({ name: 'exam_submit_grades', arguments: { session_id: agentAttempt.id, grades: [{ question_id: 'essay', score: 3 }] } });
    expect(invalidGrade.structuredContent).toMatchObject({ error: { code: 'VALIDATION', details: [{ path: ['grades', 0, 'score'] }] } });
    const agentResult = await mcpData<ResultView>(client, 'exam_submit_grades', {
      session_id: agentAttempt.id,
      grades: [{ question_id: 'essay', score: 1.5, feedback: 'Good recovery focus.' }, { question_id: 'choice', score: 0 }],
    });
    expect(agentResult).toMatchObject({ status: 'graded', result: { earned_points: 1.5, maximum_points: 3, percent: 50, passed: true, unanswered: 1 } });
    expect(await http(`${agentUrl}/results`)).toEqual(agentResult);
    expect(cli('results', agentAttempt.id)).toContain('Passed with 50%');
    expect(mcp.diagnostics).toEqual([]);
    await client.close();
    client = undefined;
    await app.close();
    app = undefined;
    runtime.close();
    runtime = undefined;
    const restarted = await connectMcp([cliEntry, 'mcp'], dbPath, port);
    client = restarted.client;
    expect(await mcpData(client, 'exam_get_results', { session_id: attempt.id })).toEqual(graded);
    expect(await mcpData(client, 'exam_get_results', { session_id: agentAttempt.id })).toEqual(agentResult);
    expect(await mcpData(client, 'exam_get_answers', { session_id: attempt.id })).toEqual(recorded);
    expect(restarted.diagnostics).toEqual([]);
  } finally {
    await client?.close();
    await app?.close();
    runtime?.close();
    rmSync(folder, { recursive: true, force: true });
  }
}, 20_000);
