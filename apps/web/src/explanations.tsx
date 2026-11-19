import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExplanationStatus, ExplanationType, SessionExplanationView } from '@exam-runtime/core';
import { api, errorMessage, explanationEventsUrl } from './api';
import type { ExplanationsSnapshot } from './api';
import { Notice } from './ui';

const labels: Record<ExplanationType, string> = {
  hint: 'Hint', detailed: 'Detailed explanation', why_wrong: 'Why my answer was wrong',
};

const statusLabels: Record<ExplanationStatus, string> = {
  pending: 'Waiting for AI agent', processing: 'Processing', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
};

const requestKey = (questionId: string, type: ExplanationType) => `${questionId}:${type}`;
const canRetry = (status: ExplanationStatus) => status === 'failed' || status === 'cancelled';

type Client = { signal: AbortSignal; refresh: () => Promise<void> };
type RequestAction = { requesting: boolean; error?: string };

export function useExplanations(id: string, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<ExplanationsSnapshot>();
  const [actions, setActions] = useState<Record<string, RequestAction>>({});
  const [readError, setReadError] = useState('');
  const [streamClosed, setStreamClosed] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const client = useRef<Client | null>(null);

  useEffect(() => {
    setSnapshot(undefined);
    setActions({});
    setReadError('');
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    let inFlight: Promise<void> | undefined;
    let refreshNeeded = false;
    function refresh() {
      refreshNeeded = true;
      // Coalesce notifications, but always fetch again if a notification arrived during a read.
      inFlight ??= (async () => {
        while (refreshNeeded && !signal.aborted) {
          refreshNeeded = false;
          try {
            const next = await api.explanations(id, signal);
            if (signal.aborted) break;
            setSnapshot(next);
            setReadError('');
          } catch (cause) {
            if (!signal.aborted) setReadError(errorMessage(cause));
          }
        }
        inFlight = undefined;
      })();
      return inFlight;
    }
    client.current = { signal, refresh };
    void refresh();
    return () => { controller.abort(); client.current = null; };
  }, [id, enabled]);

  const refresh = useCallback(() => { void client.current?.refresh(); }, []);
  const canSubscribe = enabled && !!snapshot?.allowed_types.length;
  useEffect(() => {
    setStreamClosed(false);
    if (!canSubscribe) return;
    const stream = typeof EventSource === 'undefined' ? undefined : new EventSource(explanationEventsUrl(id));
    // Keep delivery working if SSE is unavailable or the browser is reconnecting.
    const poll = window.setInterval(() => {
      if (!stream || stream.readyState !== EventSource.OPEN) refresh();
    }, 5_000);
    if (stream) {
      stream.onopen = () => { setStreamClosed(false); refresh(); };
      stream.addEventListener('explanations', refresh);
      stream.onerror = () => {
        if (stream.readyState === EventSource.CLOSED) setStreamClosed(true);
      };
    } else {
      setStreamClosed(true);
    }
    return () => { window.clearInterval(poll); stream?.close(); };
  }, [id, canSubscribe, refresh, streamAttempt]);

  async function request(questionId: string, type: ExplanationType) {
    const current = client.current;
    if (!current || !snapshot?.allowed_types.includes(type)) return;
    const key = requestKey(questionId, type);
    if (actions[key]?.requesting) return;
    setActions((previous) => ({ ...previous, [key]: { requesting: true } }));
    let error: string | undefined;
    try {
      await api.requestExplanation(id, questionId, type, current.signal);
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      if (!current.signal.aborted) await current.refresh();
      if (!current.signal.aborted) setActions((previous) => ({ ...previous, [key]: { requesting: false, error } }));
    }
  }

  const requests = useMemo(() => {
    const latest = new Map<string, SessionExplanationView>();
    for (const row of snapshot?.requests ?? []) {
      const key = requestKey(row.question_id, row.type);
      const previous = latest.get(key);
      if (!previous || row.created_at > previous.created_at ||
        (row.created_at === previous.created_at && canRetry(previous.status) && !canRetry(row.status))) {
        latest.set(key, row);
      }
    }
    return latest;
  }, [snapshot]);

  return {
    allowedTypes: enabled ? snapshot?.allowed_types ?? [] : [], requests, actions, request,
    readError: enabled ? readError : '', streamClosed: canSubscribe && streamClosed,
    retry: () => { refresh(); if (streamClosed) setStreamAttempt((value) => value + 1); },
  };
}

type ExplanationState = ReturnType<typeof useExplanations>;

export function ExplanationUpdates({ state }: { state: ExplanationState }) {
  if (!state.readError && !state.streamClosed) return null;
  return <Notice error>
    {state.readError ? `Could not load explanations. ${state.readError}` : 'Live explanation updates are unavailable.'}{' '}
    <button className="text-link inline-link" onClick={state.retry}>Check for explanations</button>
  </Notice>;
}

// Render only a small Markdown subset. HTML, link destinations and images stay plain text.
function Markdown({ text }: { text: string }) {
  return <div className="explanation-copy">{text.split(/\r?\n(?:[ \t]*\r?\n)+/).map((paragraph, block) =>
    <p key={block} className="prose-text">{paragraph.split(/(`[^`\r\n]+`|\*\*[^*\r\n]+\*\*|\*[^*\r\n]+\*)/).map((part, index) => {
      if (index % 2 === 0) return part;
      if (part.startsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
      if (part.startsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
      return <em key={index}>{part.slice(1, -1)}</em>;
    })}</p>,
  )}</div>;
}

export function ExplanationPanel({ state, questionId, incorrect = false }: {
  state: ExplanationState; questionId: string; incorrect?: boolean;
}) {
  const types = state.allowedTypes.filter((type) => type !== 'why_wrong' || incorrect);
  if (!types.length) return null;
  return <section className="explanation-panel" aria-label="Explanations">
    <h3>Explanations</h3>
    {types.map((type) => {
      const key = requestKey(questionId, type);
      const row = state.requests.get(key);
      const action = state.actions[key];
      const requesting = action?.requesting;
      const status = requesting ? 'Requesting…' : row ? statusLabels[row.status] : '';
      const showButton = requesting || !row || canRetry(row.status);
      return <div key={type} className="explanation-item">
        <div className="explanation-heading">
          <strong>{labels[type]}</strong>
          <span role="status" className={status ? 'pill' : 'sr-only'}>{status}</span>
          {showButton && <button className="button secondary" disabled={requesting} onClick={() => void state.request(questionId, type)}>
            {row ? 'Request again' : 'Request'}<span className="sr-only"> {labels[type]}</span>
          </button>}
        </div>
        {action?.error && showButton && <p className="small" role="alert">Could not request this explanation. {action.error}</p>}
        {!requesting && row?.content && <>
          <Markdown text={row.content.summary} />
          <Markdown text={row.content.explanation} />
          {row.content.learning_tip && <div><p><strong>Learning tip</strong></p><Markdown text={row.content.learning_tip} /></div>}
        </>}
      </div>;
    })}
  </section>;
}
