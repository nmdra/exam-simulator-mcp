import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { errorMessage } from './api';

const icons = {
  mark: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6m-6 4h6m-6 4h3" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  list: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h1m3 0h4m-8 6h1m3 0h4" /></>,
  arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
  back: <path d="M20 12H5m6-6-6 6 6 6" />,
  flag: <path d="M5 21V4m0 1c5-5 9 4 15 0v10c-6 4-10-5-15 0" />,
  check: <path d="m5 12 4 4L19 6" />,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 8v4m0 4h.01" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
} satisfies Record<string, ReactNode>;

export function Icon({ name, className }: { name: keyof typeof icons; className?: string }) {
  return <svg className={className} aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{icons[name]}</svg>;
}

export function usePage(title: string) {
  useEffect(() => { document.title = `${title} | Exam Runtime`; }, [title]);
}

export function useHeadingFocus<T extends HTMLElement>(key: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => { ref.current?.focus(); }, [key]);
  return ref;
}

export function Shell({ children, section, tools }: { children: ReactNode; section: string; tools?: ReactNode }) {
  return <>
    <a href="#main-content" className="skip">Skip to content</a>
    <header className="shell-header">
      <div className="wrap header-inner">
        <a href="/" className="brand"><span className="brand-mark"><Icon name="mark" /></span> Exam Runtime</a>
        <span className="header-section">{section}</span>
        {tools && <div className="header-tools">{tools}</div>}
      </div>
    </header>
    <main id="main-content" className="wrap main-content" tabIndex={-1}>{children}</main>
    <footer className="wrap page-footer"><span>Exam Runtime</span><span>Assessment workspace</span></footer>
  </>;
}

export function PageTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  const ref = useHeadingFocus<HTMLHeadingElement>(title);
  return <div className="page-title"><p className="eyebrow">{eyebrow}</p><h1 ref={ref} tabIndex={-1}>{title}</h1>{children}</div>;
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice ${error ? 'notice-error' : ''}`} role={error ? 'alert' : 'status'}><Icon name={error ? 'alert' : 'clock'} /><div>{children}</div></div>;
}

export function LoadState({ error, retry }: { error?: string; retry?: () => void }) {
  return <section className="surface load-state">
    {error ? <><h1>Something went wrong</h1><Notice error>{error}</Notice>{retry && <button className="button secondary" onClick={retry}>Try again</button>}</> : <><span className="spinner" aria-hidden="true" /><p role="status">Loading exam information…</p></>}
  </section>;
}

type Resource<T> = { data?: T; error?: string };

export function useResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [resource, setResource] = useState<Resource<T>>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then((data) => {
      if (!controller.signal.aborted) setResource({ data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResource({ error: errorMessage(error) });
    });
    return () => controller.abort();
  }, [load, attempt]);
  const retry = () => { setResource({}); setAttempt((n) => n + 1); };
  return { ...resource, retry };
}

export const gradingLabel = (mode: 'answer_key' | 'agent_graded') => mode === 'answer_key' ? 'Answer key' : 'Agent graded';
export const formatScore = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
export const formatPercent = (value: number) => `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
export const countLabel = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`;

export function clockDisplay(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const tail = String(seconds % 60).padStart(2, '0');
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${tail}`
    : `${String(minutes).padStart(2, '0')}:${tail}`;
}

export function elapsedDisplay(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${seconds % 60}s`;
}
