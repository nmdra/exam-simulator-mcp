import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ExplanationDetail, ExplanationRequestSummary, ExamState } from '@exam-runtime/core';

const scope = process.env.EXAM_RUNTIME_AGENT_ID ?? 'local';
const session = process.argv[2] || undefined;
const pendingUri = `exam://agents/${scope}/explanations/pending`;
const stateUri = session && `exam://sessions/${session}/state`;
const uris = stateUri ? [pendingUri, stateUri] : [pendingUri];
const stop = new AbortController();
function shutdown() { stop.abort(); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
const entry = fileURLToPath(new URL('../packages/mcp/dist/main.js', import.meta.url));
const env: Record<string, string> = {};
for (const key of ['EXAM_RUNTIME_AGENT_ID', 'EXAM_RUNTIME_AGENT_TOKEN', 'EXAM_RUNTIME_DB_PATH', 'EXAM_RUNTIME_DATA_DIR', 'EXAM_RUNTIME_PORT', 'XDG_DATA_HOME']) {
  const value = process.env[key];
  if (value !== undefined) env[key] = value;
}

async function tool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const payload = 'structuredContent' in result ? result.structuredContent as { data?: T; error?: { message: string } } : undefined;
  if (payload?.data === undefined) throw new Error(payload?.error?.message ?? `${name} did not return data.`);
  return payload.data;
}

async function resource<T>(client: Client, uri: string): Promise<T> {
  const result = await client.readResource({ uri });
  const content = 'contents' in result ? result.contents.find((entry) => entry.uri === uri && 'text' in entry) : undefined;
  if (!content || !('text' in content)) throw new Error(`No JSON content for ${uri}.`);
  return JSON.parse(content.text) as T;
}

async function processRequests(client: Client, requests: ExplanationRequestSummary[]) {
  for (const request of requests) {
    if (stop.signal.aborted) return;
    const args = { request_id: request.request_id };
    try {
      const claim = await tool<{ claim_token: string }>(client, 'explanation_claim', args);
      const detail = await tool<ExplanationDetail>(client, 'explanation_request_get', args);
      // A real agent host would invoke its model here, using only this permitted context.
      await tool(client, 'explanation_submit', {
        ...args, claim_token: claim.claim_token,
        content: {
          summary: 'Demonstration only: review the concept behind this question.',
          explanation: `This is deterministic mock content, not an AI explanation.\n\nQuestion: ${detail.context.question.text}`,
          learning_tip: 'Explain the key term in your own words before reviewing the choices.',
        },
      });
      console.log(`Completed ${request.request_id} with demonstration text.`);
    } catch (err) {
      // Another worker can claim first. If this worker disconnects, the lease expires.
      if (!stop.signal.aborted) console.error(`Request ${request.request_id}:`, err instanceof Error ? err.message : err);
    }
  }
}

function logState(state: ExamState) {
  console.log(`State ${state.revision}: ${state.status}, ${state.progress.answered}/${state.progress.total_questions} answered, ${state.timer.remaining_seconds}s remaining.`);
}

async function runConnection() {
  const client = new Client({ name: 'exam-runtime-example', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: 'inherit' });
  const disconnected = Promise.withResolvers<void>();
  let connected = true;
  const onStop = () => { disconnected.resolve(); void client.close().catch(console.error); };
  client.onclose = () => { connected = false; disconnected.resolve(); };
  stop.signal.addEventListener('abort', onStop, { once: true });
  try {
    await client.connect(transport);
    const modern = client.getProtocolEra() === 'modern' && client.getServerCapabilities()?.resources?.subscribe;
    if (!modern) {
      console.log('Modern subscriptions unavailable. Polling the tools instead.');
      while (connected && !stop.signal.aborted) {
        await processRequests(client, await tool<ExplanationRequestSummary[]>(client, 'explanation_requests_list', { status: 'pending', limit: 20 }));
        if (session) logState(await tool<ExamState>(client, 'exam_get_state', { session_id: session }));
        await Promise.race([delay(2_000), disconnected.promise]);
      }
      return;
    }

    let refreshWork = Promise.resolve();
    const queued = new Set<string>();
    function queue(uri: string) {
      if (queued.has(uri) || !uris.includes(uri)) return;
      queued.add(uri);
      refreshWork = refreshWork.then(async () => {
        queued.delete(uri);
        if (!connected || stop.signal.aborted) return;
        if (uri === pendingUri) {
          const snapshot = await resource<{ requests: ExplanationRequestSummary[] }>(client, uri);
          await processRequests(client, snapshot.requests);
        } else logState(await resource<ExamState>(client, uri));
      }).catch((err: unknown) => {
        if (!stop.signal.aborted) console.error('Resource refresh failed:', err);
      });
    }
    client.setNotificationHandler('notifications/resources/updated', ({ params }) => { queue(params.uri); });
    const subscription = await client.listen({ resourceSubscriptions: uris }, { signal: stop.signal });
    try {
      const honored = subscription.honoredFilter.resourceSubscriptions ?? [];
      if (honored.length !== uris.length || uris.some((uri) => !honored.includes(uri))) {
        throw new Error('The server did not authorize every requested resource. Check the session scope.');
      }
      console.log('Subscribed:', honored.join(', '));
      // Subscribe first and then read, so reconnects recover work missed while offline.
      for (const uri of honored) queue(uri);
      await Promise.race([subscription.closed, disconnected.promise]);
    } finally {
      await subscription.close();
    }
  } finally {
    stop.signal.removeEventListener('abort', onStop);
    await client.close();
  }
}

while (!stop.signal.aborted) {
  try { await runConnection(); }
  catch (err) { if (!stop.signal.aborted) console.error(err); }
  if (!stop.signal.aborted) await delay(1_000, undefined, { signal: stop.signal }).catch(() => {});
}
