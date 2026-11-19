import { createRoot } from 'react-dom/client';
import { Attempt } from './attempt';
import { ExamIntro, Library } from './browse';
import { Results } from './results';
import { Icon, PageTitle, Shell, usePage } from './ui';
import './styles.css';

function NotFound() {
  usePage('Page not found');
  return <Shell section="Page not found">
    <PageTitle eyebrow="404" title="Page not found"><p className="lead">Check the address or return to the exam library.</p></PageTitle>
    <a className="button secondary" href="/"><Icon name="back" /> Exam library</a>
  </Shell>;
}

function App() {
  let parts: string[];
  try {
    parts = window.location.pathname.replace(/\/$/, '').split('/').slice(1).map(decodeURIComponent);
  } catch {
    return <NotFound />;
  }
  const [resource, id, page] = parts;
  if (!parts.length) return <Library />;
  if (id && resource === 'exams' && parts.length === 2) return <ExamIntro id={id} />;
  if (id && resource === 'sessions') {
    if (parts.length === 2) return <Attempt id={id} />;
    if (parts.length === 3 && page === 'results') return <Results id={id} />;
  }
  return <NotFound />;
}

createRoot(document.getElementById('root')!).render(<App />);
