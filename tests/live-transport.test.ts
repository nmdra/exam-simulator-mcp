import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ExamState, ExamSummary, SessionView } from '@exam-runtime/core';
import { expect, it } from 'vitest';
import { makeAnswerKeyExam } from './fixtures.js';

const cliEntry = fileURLToPath(new URL('../packages/cli/dist/main.js', import.meta.url));
const mcpEntry = fileURLToPath(new URL('../packages/mcp/dist/main.js', import.meta.url));
const writeHeaders = { 'Content-Type': 'application/json', 'X-Exam-Runtime': '1' };

async function reservePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  socket.close();
  await once(socket, 'close');
  if (!address || typeof address === 'string') throw new Error('No available HTTP port.');
  return address.port;
}

async function stopProcess(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'exit');
  child.kill('SIGTERM');
  const stop = setTimeout(() => child.kill('SIGKILL'), 3_000);
  try { await closed; } finally { clearTimeout(stop); }
}

async function readResource<T>(client: Client, uri: string) {
  const response = await client.readResource({ uri });
  expect(response).toHaveProperty('contents');
  if (!('contents' in response)) throw new Error('Resource response has no contents.');
  const item = response.contents.find((entry) => entry.uri === uri && 'text' in entry);
  if (!item || !('text' in item)) throw new Error('Missing JSON resource text.');
  return JSON.parse(item.text) as T;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  if (!('structuredContent' in response)) throw new Error(`${name} returned no structured response.`);
  return response.structuredContent as { data?: unknown; error?: { code: string; message: string } };
}

async function tool<T>(client: Client, name: string, args: Record<string, unknown>) {
  const response = await call(client, name, args);
  if (response.data === undefined) throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);
  return response.data as T;
}

type Pending = { revision: number; pending_count: number; requests: { request_id: string }[] };

it('routes Phase 2 subscriptions and SSE across separate SDK stdio and API processes and recovers after reconnect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exam-runtime-live-'));
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { EXAM_RUNTIME_DB_PATH: join(dir, 'live.sqlite3'), EXAM_RUNTIME_PORT: String(port) };
  const runCli = (...args: string[]) => execFileSync(process.execPath, [cliEntry, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5_000 });
  const diagnostics: string[] = [];
  let server: ChildProcess | undefined;
  async function serve() {
    server = spawn(process.execPath, [cliEntry, 'serve'], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr?.on('data', (data: Buffer) => diagnostics.push(data.toString()));
    await expect.poll(async () => {
      if (server?.exitCode !== null) throw new Error(`API process exited: ${diagnostics.join('')}`);
      try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).status; }
      catch { return null; }
    }, { timeout: 5_000 }).toBe(200);
  }
  async function http<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
    const response = await fetch(`${base}/api${path}`, {
      method, ...(payload === undefined ? {} : { body: JSON.stringify(payload), headers: writeHeaders }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return ((await response.json()) as { data: T }).data;
  }
  const clients = new Set<Client>();
  async function connect(id: string) {
    const credential = JSON.parse(runCli('agent', 'create', id)) as { token: string };
    const connectExisting = async () => {
      const client = new Client({ name: 'exam-runtime-wire-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
      const transport = new StdioClientTransport({
        command: process.execPath, args: [mcpEntry], stderr: 'pipe',
        env: { ...env, EXAM_RUNTIME_AGENT_ID: id, EXAM_RUNTIME_AGENT_TOKEN: credential.token },
      });
      transport.stderr?.on('data', (data: Buffer | string) => diagnostics.push(String(data)));
      clients.add(client);
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
      return client;
    };
    return { client: await connectExisting(), connectExisting };
  }
  const sseAbort = new AbortController();
  try {
    await serve();
    const scopeA = await connect('alpha');
    let alpha = scopeA.client;
    const beta = (await connect('beta')).client;
    const definition = { ...makeAnswerKeyExam({ mode: 'practice' }), assistance: { enabled: true } };
    async function start(client: Client) {
      const exam = await tool<ExamSummary>(client, 'exam_create', { definition });
      await tool(client, 'exam_publish', { exam_id: exam.id });
      return http<SessionView>(`/exams/${exam.id}/sessions`, 'POST', {});
    }
    const own = await start(alpha);
    const other = await start(beta);
    const path = `/sessions/${own.id}`;
    const ownState = `exam://sessions/${own.id}/state`;
    const otherState = `exam://sessions/${other.id}/state`;
    const ownPending = 'exam://agents/alpha/explanations/pending';
    const otherPending = 'exam://agents/beta/explanations/pending';
    const notices: string[] = [];
    const betaNotices: string[] = [];
    alpha.setNotificationHandler('notifications/resources/updated', ({ params }) => { notices.push(params.uri); });
    beta.setNotificationHandler('notifications/resources/updated', ({ params }) => { betaNotices.push(params.uri); });
    const alphaSub = await alpha.listen({ resourceSubscriptions: [ownState, ownPending, otherState, otherPending] });
    const betaSub = await beta.listen({ resourceSubscriptions: [otherPending] });
    expect(alphaSub.honoredFilter.resourceSubscriptions).toEqual([ownState, ownPending]);
    expect(betaSub.honoredFilter.resourceSubscriptions).toEqual([otherPending]);
    await expect(alpha.readResource({ uri: otherState })).rejects.toThrow();
    await expect(alpha.readResource({ uri: otherPending })).rejects.toThrow();
    expect(await call(alpha, 'exam_get_state', { session_id: other.id })).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await call(alpha, 'exam_get_session', { session_id: other.id })).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const initial = await readResource<ExamState>(alpha, ownState);
    expect(initial).toMatchObject({ status: 'in_progress', revision: 0, progress: { current_question_id: 'single' } });
    expect(initial).not.toHaveProperty('responses');
    const moved = await http<SessionView>(`${path}/current-question`, 'PUT', { question_id: 'multi', revision: 0 });
    await expect.poll(() => notices, { timeout: 4_000 }).toContain(ownState);
    expect(notices).not.toContain(ownPending);
    const changed = await readResource<ExamState>(alpha, ownState);
    expect(changed).toMatchObject({ revision: moved.revision, progress: { current_question_id: 'multi' } });
    expect(JSON.stringify(changed)).not.toMatch(/correct_answers|author_note/);

    const stream = await fetch(`${base}/api${path}/explanations/events`, { signal: AbortSignal.any([sseAbort.signal, AbortSignal.timeout(15_000)]) });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('Server sent no SSE stream.');
    const decoder = new TextDecoder();
    let buffered = '';
    async function nextSseEvent() {
      for (;;) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary !== -1) {
          const event = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          if (event.includes('event: explanations')) return event;
        } else {
          const { value, done } = await reader!.read();
          if (done) throw new Error('SSE ended unexpectedly.');
          buffered += decoder.decode(value, { stream: true });
        }
      }
    }
    await nextSseEvent();
    const request = await http<{ request_id: string }>(`${path}/explanations`, 'POST', { question_id: 'multi', type: 'hint' });
    await nextSseEvent();
    await expect.poll(() => notices, { timeout: 4_000 }).toContain(ownPending);
    expect(await readResource<Pending>(alpha, ownPending)).toMatchObject({ pending_count: 1, requests: [{ request_id: request.request_id }] });
    expect(await readResource<Pending>(beta, otherPending)).toMatchObject({ pending_count: 0, requests: [] });
    expect(betaNotices).toEqual([]);
    expect(notices.every((uri) => uri === ownState || uri === ownPending)).toBe(true);
    const args = { request_id: request.request_id };
    const detail = await tool(alpha, 'explanation_request_get', args);
    expect(JSON.stringify(detail)).not.toMatch(/correct_answers|claim_token/);
    expect(await call(beta, 'explanation_claim', args)).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await alphaSub.close();
    await alpha.close();
    clients.delete(alpha);
    alpha = await scopeA.connectExisting();
    const reconnected = await alpha.listen({ resourceSubscriptions: [ownPending] });
    expect(await readResource<Pending>(alpha, ownPending)).toMatchObject({ pending_count: 1, requests: [args] });
    const claim = await tool<{ claim_token: string }>(alpha, 'explanation_claim', args);
    await nextSseEvent();
    const content = { summary: 'Read the choices as a set.', explanation: '**Demo:** Think about each option separately.' };
    const submission = { ...args, claim_token: claim.claim_token, content };
    await tool(alpha, 'explanation_submit', submission);
    await nextSseEvent();
    expect(await http(`${path}/explanations`)).toMatchObject({ requests: [{ ...args, status: 'completed', content }] });
    expect(await tool(alpha, 'explanation_submit', submission)).toMatchObject({ ...args, status: 'completed', content });
    expect(await readResource<Pending>(alpha, ownPending)).toMatchObject({ pending_count: 0 });
    expect(await tool(alpha, 'explanation_requests_list', { status: 'pending' })).toEqual([]);
    expect(diagnostics).toEqual([]);
    await reconnected.close();
    await betaSub.close();
    // Real SSE clients release their connection on disconnect or server shutdown.
    await stopProcess(server);
    sseAbort.abort();
    await serve();
    expect(await http(`${path}/explanations`)).toMatchObject({ requests: [{ ...args, status: 'completed', content }] });
    expect(await tool(alpha, 'exam_get_state', { session_id: own.id })).toMatchObject({ revision: moved.revision, progress: { current_question_id: 'multi' } });
  } finally {
    sseAbort.abort();
    await Promise.allSettled([...clients].map((client) => client.close()));
    await stopProcess(server);
    rmSync(dir, { recursive: true, force: true });
  }
}, 25_000);
