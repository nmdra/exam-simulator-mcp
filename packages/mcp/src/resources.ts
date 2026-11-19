import process from 'node:process';
import type { AgentPrincipal, ExamRuntime } from '@exam-runtime/core';
import { RuntimeError } from '@exam-runtime/core';
import { agentIdSchema, entityIdSchema } from '@exam-runtime/schemas';
import { isJSONRPCRequest, isSpecType, PROTOCOL_VERSION_META_KEY, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import type { JSONRPCMessage, McpServer } from '@modelcontextprotocol/server';

const stateTemplate = 'exam://sessions/{session_id}/state';
const pendingTemplate = 'exam://agents/{agent_id}/explanations/pending';

export function authenticateAgent(runtime: ExamRuntime): AgentPrincipal {
  const { EXAM_RUNTIME_AGENT_ID, EXAM_RUNTIME_AGENT_TOKEN } = process.env;
  return runtime.authenticateAgent(EXAM_RUNTIME_AGENT_ID, EXAM_RUNTIME_AGENT_TOKEN);
}

function resourceRoute(uri: string) {
  const state = /^exam:\/\/sessions\/([^/]+)\/state$/.exec(uri);
  if (state && `exam://sessions/${state[1]}/state` === uri) {
    const id = entityIdSchema.safeParse(state[1]);
    if (id.success) return { type: 'state' as const, id: id.data };
  }
  const pending = /^exam:\/\/agents\/([^/]+)\/explanations\/pending$/.exec(uri);
  if (pending && `exam://agents/${pending[1]}/explanations/pending` === uri) {
    const id = agentIdSchema.safeParse(pending[1]);
    if (id.success) return { type: 'pending' as const, id: id.data };
  }
  return undefined;
}

function authorizeUri(runtime: ExamRuntime, principal: AgentPrincipal, uri: string) {
  const route = resourceRoute(uri);
  if (!route) throw new ResourceNotFoundError(uri);
  if (route.type === 'state') runtime.assertSessionAccess(route.id, principal, true);
  else if (route.id !== principal.scope) throw new ResourceNotFoundError(uri);
  return route;
}

export function registerResources(server: McpServer, runtime: ExamRuntime): void {
  const mimeType = 'application/json';
  const read = (url: URL) => {
    const uri = url.href;
    try {
      const principal = authenticateAgent(runtime);
      const route = authorizeUri(runtime, principal, uri);
      const value = route.type === 'state' ? runtime.getState(route.id, principal, false) : runtime.explanations.pending(principal);
      return { contents: [{ uri, mimeType, text: JSON.stringify(value) }] };
    } catch (error) {
      if (error instanceof RuntimeError && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')) {
        throw new ResourceNotFoundError(uri);
      }
      throw error;
    }
  };
  server.registerResource('exam-session-state', new ResourceTemplate(stateTemplate, { list: undefined }), { mimeType }, read);
  server.registerResource('exam-explanations-pending', new ResourceTemplate(pendingTemplate, { list: undefined }), { mimeType }, read);
}

// SDK 2.4 serves listen at its stdio entry, before dispatch reaches a server
// handler. Filter candidate URIs in its transport seam; let the SDK validate
// the request and handle the acknowledgement, delivery, and cancellation.
export function filterListenResources(
  message: JSONRPCMessage, runtime: ExamRuntime, watch: (uri: string, key: string) => boolean,
): JSONRPCMessage {
  if (!isJSONRPCRequest(message) || message.method !== 'subscriptions/listen') return message;
  if (message.params?._meta?.[PROTOCOL_VERSION_META_KEY] !== '2026-07-28') return message;
  const filter = message.params?.notifications;
  if (!isSpecType.SubscriptionFilter(filter)) return message;
  const uris = filter.resourceSubscriptions;
  if (!uris?.length) return message;

  let principal: AgentPrincipal | undefined;
  try { principal = authenticateAgent(runtime); }
  catch (error) { if (!(error instanceof RuntimeError)) throw error; }
  const authorized: string[] = [];
  for (const uri of new Set(uris)) {
    if (!principal) break;
    try {
      const route = authorizeUri(runtime, principal, uri);
      if (watch(uri, `${route.type}:${route.id}`)) authorized.push(uri);
    } catch (error) {
      if (!(error instanceof ResourceNotFoundError || (error instanceof RuntimeError &&
        (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')))) throw error;
    }
  }
  return {
    ...message,
    params: { ...message.params, notifications: { ...filter, resourceSubscriptions: authorized } },
  };
}
