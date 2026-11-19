import { useCallback, useRef, useState } from 'react';
import type { ExamSummary } from '@exam-runtime/core';
import { api, errorMessage, examPath, sessionPath } from './api';
import { countLabel, formatPercent, formatScore, gradingLabel, Icon, LoadState, Notice, PageTitle, Shell, usePage, useResource } from './ui';

function ExamCard({ exam }: { exam: ExamSummary }) {
  return <article className="surface exam-card">
    <div className="flex items-start justify-between gap-3"><span className="tile-icon"><Icon name="list" /></span>{exam.difficulty && <span className="pill">{exam.difficulty}</span>}</div>
    <div className="card-copy">
      <p className="eyebrow">{exam.subject}</p>
      <h3><a href={examPath(exam.id)}>{exam.title}</a></h3>
      {exam.description && <p className="card-description">{exam.description}</p>}
    </div>
    <div className="card-meta">
      <span><Icon name="list" /> {countLabel(exam.question_count, 'question')}</span>
      <span><Icon name="clock" /> {exam.duration_minutes} min</span>
    </div>
    <a className="text-link" href={examPath(exam.id)} aria-label={`View exam: ${exam.title}`}>View exam <Icon name="arrow" /></a>
  </article>;
}

export function Library() {
  usePage('Exam library');
  const { data, error, retry } = useResource(api.exams);
  return <Shell section="Exam library">
    <section className="library-hero">
      <div className="hero-copy">
        <PageTitle eyebrow="Assessment workspace" title="Exam library">
          <p className="lead">Choose a published exam to start a timed attempt. Review the instructions and scoring rules before you begin.</p>
        </PageTitle>
      </div>
      <div className="hero-art" aria-hidden="true">
        <div className="art-sheet">
          <span className="art-heading"><Icon name="mark" /><i /></span>
          <span className="art-row"><Icon name="check" /><i /></span><span className="art-row"><b /><i /></span><span className="art-row"><b /><i /></span>
          <span className="art-line" />
        </div>
        <span className="art-clock"><Icon name="clock" /></span>
      </div>
    </section>
    <section className="library-list" aria-labelledby="available-exams">
      <div className="section-heading"><h2 id="available-exams">Available exams</h2>{data && <span className="pill">{countLabel(data.length, 'exam')}</span>}</div>
      {!data ? <LoadState error={error} retry={retry} /> : data.length ? <div className="exam-grid">{data.map((exam) => <ExamCard key={exam.id} exam={exam} />)}</div> :
        <div className="surface empty-state"><span className="tile-icon"><Icon name="list" /></span><h3>No published exams yet</h3><p>Exams appear here when they are published.</p><button className="button secondary" onClick={retry}>Refresh list</button></div>}
    </section>
  </Shell>;
}

export function ExamIntro({ id }: { id: string }) {
  const load = useCallback((signal: AbortSignal) => api.exam(id, signal), [id]);
  const { data: exam, error, retry } = useResource(load);
  const [startError, setStartError] = useState('');
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  usePage(exam?.title ?? 'Exam overview');

  async function start() {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setStartError('');
    try {
      const session = await api.start(id);
      window.location.assign(sessionPath(session.id));
    } catch (cause) {
      setStartError(errorMessage(cause));
      startingRef.current = false;
      setStarting(false);
    }
  }

  return <Shell section="Exam overview">
    <a className="text-link back-link" href="/"><Icon name="back" /> Exam library</a>
    {!exam ? <LoadState error={error} retry={retry} /> : <>
      <PageTitle eyebrow={exam.subject} title={exam.title}>
        {exam.description && <p className="lead prose-text">{exam.description}</p>}
      </PageTitle>
      <div className="overview-grid">
        <section className="surface panel overview-instructions" aria-labelledby="instructions-heading">
          <h2 id="instructions-heading">Instructions</h2>
          {exam.instructions ? <p className="prose-text">{exam.instructions}</p> : <p>No additional instructions are provided for this exam.</p>}
          <hr />
          <h3>During your attempt</h3>
          <ul className="rules">
            <li>The timer starts when you select <strong>Start exam</strong> and continues if you leave the page.</li>
            <li>Answers save as you work. You can return to any question before submitting.</li>
            <li>{exam.allow_review ? 'You can flag questions to revisit and review your answers after grading.' : 'Question flags and post-grading answer review are not available for this exam.'}</li>
            <li>{exam.auto_submit_on_timeout ? 'Your saved answers are submitted automatically when time runs out.' : 'When time runs out, answers lock. You must submit the attempt yourself.'}</li>
          </ul>
        </section>
        <section className="surface panel overview-summary" aria-labelledby="details-heading">
          <h2 id="details-heading">Exam details</h2>
          <dl className="facts">
            <div><dt>Questions</dt><dd>{exam.question_count}</dd></div>
            <div><dt>Time limit</dt><dd>{countLabel(exam.duration_minutes, 'minute')}</dd></div>
            <div><dt>Grading</dt><dd>{gradingLabel(exam.grading_mode)}</dd></div>
            <div><dt>Maximum points</dt><dd>{formatScore(exam.maximum_points)}</dd></div>
            <div><dt>Passing score</dt><dd>{formatPercent(exam.passing_percent)}</dd></div>
            {exam.difficulty && <div><dt>Difficulty</dt><dd>{exam.difficulty}</dd></div>}
          </dl>
          {startError && <Notice error>{startError}</Notice>}
          <button className="button primary w-full" onClick={() => void start()} disabled={starting}>{starting ? 'Starting…' : 'Start exam'} <Icon name="arrow" /></button>
          <p className="small centered">Your timer starts immediately.</p>
        </section>
      </div>
    </>}
  </Shell>;
}
