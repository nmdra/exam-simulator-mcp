import { useEffect, useRef, useState } from 'react';
import type { ResponseValue, SessionView } from '@exam-runtime/core';
import { api, ApiError, errorMessage, resultPath } from './api';

type Change = { question: string } & ({ kind: 'answer'; value: ResponseValue } | { kind: 'flag'; flagged: boolean });
type ClockOrigin = { remaining: number; measuredAt: number };

function measure(session: SessionView): ClockOrigin {
  return { remaining: session.expired ? 0 : session.deadline_at - session.server_now, measuredAt: performance.now() };
}

function remaining(origin: ClockOrigin) {
  return Math.max(0, Math.ceil((origin.remaining - (performance.now() - origin.measuredAt)) / 1000));
}

export function useAttempt(initial: SessionView) {
  const id = initial.id;
  const [session, setSession] = useState(initial);
  const latest = useRef(initial);
  const [origin, setOrigin] = useState(() => measure(initial));
  const clock = useRef(origin);
  const [seconds, setSeconds] = useState(() => remaining(origin));
  const [draft, setDraft] = useState<Change | null>(null);
  const queued = useRef<Change | null>(null);
  const active = useRef<Promise<boolean> | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const closing = useRef(false);
  const [saveError, setSaveError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [clockError, setClockError] = useState('');
  const [clockAttempt, setClockAttempt] = useState(0);

  function exit() {
    closing.current = true;
    queued.current = null;
    window.location.replace(resultPath(id));
  }

  function accept(next: SessionView) {
    latest.current = next;
    const measured = measure(next);
    clock.current = measured;
    setSession(next);
    setOrigin(measured);
    setSeconds(remaining(measured));
    if (next.status !== 'in_progress') exit();
  }

  useEffect(() => {
    const tick = () => setSeconds(remaining(clock.current));
    const interval = window.setInterval(tick, 200);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (queued.current && !closing.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, []);

  useEffect(() => {
    if (seconds !== 0 || session.expired || closing.current) return;
    let cancelled = false;
    const controller = new AbortController();
    async function verifyDeadline() {
      try {
        await active.current;
        if (cancelled || closing.current || latest.current.expired || remaining(clock.current) > 0) return;
        const next = await api.session(id, controller.signal);
        if (cancelled || closing.current) return;
        setClockError('');
        accept(next);
      } catch (cause) {
        if (!cancelled && !closing.current) setClockError(errorMessage(cause));
      }
    }
    void verifyDeadline();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [seconds, session.expired, id, origin, clockAttempt]);

  function updateDraft(change: Change | null) {
    queued.current = change;
    setDraft(change);
  }

  function isClosed() {
    return closing.current || latest.current.expired || remaining(clock.current) === 0;
  }

  function flush(): Promise<boolean> {
    if (active.current) return active.current;
    if (!queued.current || isClosed()) return Promise.resolve(!queued.current);
    setSaving(true);
    setSaveError('');
    const perform = async () => {
      while (queued.current && !isClosed()) {
        const change = queued.current;
        try {
          const revision = latest.current.revision;
          const next = change.kind === 'answer'
            ? await api.answer(id, change.question, change.value, revision)
            : await api.flag(id, change.question, change.flagged, revision);
          accept(next);
          // A new text edit can arrive during the request. Keep it until its own write completes.
          if (queued.current === change) updateDraft(null);
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 409) {
            try {
              const next = await api.session(id);
              accept(next);
              if (!closing.current) {
                setSaveError(next.expired ? 'Time expired before this change was saved.'
                  : 'The session changed in another tab or client. The latest saved state is loaded. Retry to apply your change, or discard it.');
              }
            } catch {
              setSaveError('The session changed, but the latest saved state could not be loaded. Try again.');
            }
          } else {
            setSaveError(`Change not saved. ${errorMessage(cause)}`);
          }
          return false;
        }
      }
      return queued.current === null;
    };
    active.current = perform().finally(() => {
      active.current = null;
      setSaving(false);
    });
    return active.current;
  }

  function changeAnswer(question: string, value: ResponseValue) {
    if (isClosed()) return;
    const previous = queued.current;
    if (previous && (previous.kind !== 'answer' || previous.question !== question)) return;
    updateDraft({ kind: 'answer', question, value });
    // Keep edits local after a failed write until the candidate explicitly retries.
    if (!saveError) void flush();
  }

  function changeFlag(question: string, flagged: boolean) {
    if (isClosed() || !latest.current.allow_review || queued.current) return;
    updateDraft({ kind: 'flag', question, flagged });
    void flush();
  }

  async function prepareToLeave() {
    if (submitting || closing.current) return false;
    if (isClosed()) {
      await active.current;
      return !closing.current;
    }
    if (saveError) return false;
    const saved = await flush();
    return !closing.current && (saved || isClosed());
  }

  async function submit() {
    await active.current;
    if (closing.current || (latest.current.auto_submit_on_timeout && isClosed())) return;
    closing.current = true;
    setSubmitting(true);
    setSubmitError('');
    try {
      await api.submit(id);
      exit();
    } catch (cause) {
      closing.current = false;
      setSubmitting(false);
      setSubmitError(errorMessage(cause));
      setClockAttempt((value) => value + 1);
    }
  }

  return {
    session, seconds, expired: session.expired || seconds === 0, draft, saving, submitting, saveError, submitError, clockError,
    changeAnswer, changeFlag, prepareToLeave, submit,
    retrySave: () => void flush(),
    discard: () => { if (!active.current) { updateDraft(null); setSaveError(''); } },
    retryClock: () => setClockAttempt((value) => value + 1),
  };
}
