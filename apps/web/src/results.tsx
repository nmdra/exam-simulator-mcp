import { useEffect, useRef, useState } from 'react';
import type { CandidateQuestion, QuestionResult, ResponseValue, ResultView } from '@exam-runtime/core';
import { api, errorMessage, examPath, sessionPath } from './api';
import { ExplanationPanel, ExplanationUpdates, useExplanations } from './explanations';
import { elapsedDisplay, formatPercent, formatScore, gradingLabel, Icon, LoadState, Notice, PageTitle, Shell, usePage } from './ui';

const outcomeText = { correct: 'Correct', incorrect: 'Incorrect', unanswered: 'Unanswered', agent_scored: 'Scored' };

function describeResponse(question: CandidateQuestion, response: ResponseValue) {
  if (response === null) return 'No response';
  if (typeof response === 'boolean') return response ? 'True' : 'False';
  if (question.type === 'free_text' && typeof response === 'string') return response;
  return (Array.isArray(response) ? response : [response]).map((id) => question.options?.find((option) => option.id === id)?.text ?? id).join('\n');
}

function QuestionReview({ row, number, explanations }: {
  row: QuestionResult; number: number; explanations: ReturnType<typeof useExplanations>;
}) {
  return <details className="review-item">
    <summary>
      <div className="review-label"><span className="eyebrow">Question {number} · {row.domain}</span><span className="review-question">{row.question.text}</span></div>
      <span className={`pill outcome-${row.outcome}`}>{outcomeText[row.outcome]}</span><Icon name="chevron" className="review-chevron" />
    </summary>
    <div className="review-body">
      <p className="small"><strong>{formatScore(row.earned_points)} / {formatScore(row.maximum_points)} points</strong></p>
      <dl className="review-answers">
        <div><dt>Your response</dt><dd className="prose-text">{describeResponse(row.question, row.response)}</dd></div>
        {row.correct_answers && <div><dt>Answer key</dt><dd className="prose-text">{describeResponse(row.question, row.correct_answers)}</dd></div>}
        {row.feedback && <div><dt>Feedback</dt><dd className="prose-text">{row.feedback}</dd></div>}
      </dl>
      <ExplanationPanel state={explanations} questionId={row.question_id} incorrect={row.outcome === 'incorrect'} />
    </div>
  </details>;
}

function SubmissionFacts({ view }: { view: ResultView }) {
  if (view.submitted_at === null) return null;
  return <dl className="facts">
    <div><dt>Time taken</dt><dd>{view.time_taken_seconds === null ? 'Not available' : elapsedDisplay(view.time_taken_seconds)}</dd></div>
    <div><dt>Submission reason</dt><dd>{view.submission_reason === 'timeout' ? 'Time limit reached' : 'Submitted manually'}</dd></div>
    <div><dt>Submitted</dt><dd><time dateTime={new Date(view.submitted_at).toISOString()}>{new Date(view.submitted_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></dd></div>
  </dl>;
}

function Graded({ view }: { view: Extract<ResultView, { status: 'graded' }> }) {
  const { result } = view;
  const explanations = useExplanations(view.session_id, result.questions.length > 0);
  return <>
    <div className="overview-grid result-grid">
      <section className="surface score-panel" aria-labelledby="score-heading">
        <div><h2 id="score-heading">Final score</h2><div className="score-value">{formatPercent(result.percent)}</div><p>{formatScore(result.earned_points)} of {formatScore(result.maximum_points)} points · {formatPercent(result.passing_percent)} to pass</p></div>
        <span className={`pill ${result.passed ? 'outcome-correct' : 'outcome-incorrect'}`}>{result.passed ? 'Passed' : 'Did not pass'}</span>
        <progress className="progress-bar" max={100} value={result.percent} aria-label="Final score percentage" />
        <dl className="score-stats">
          <div><dt>Questions</dt><dd>{result.total}</dd></div>
          {result.correct !== null && <div><dt>Correct</dt><dd>{result.correct}</dd></div>}
          {result.incorrect !== null && <div><dt>Incorrect</dt><dd>{result.incorrect}</dd></div>}
          <div><dt>Unanswered</dt><dd>{result.unanswered}</dd></div>
        </dl>
      </section>
      <section className="surface panel" aria-labelledby="submission-heading"><h2 id="submission-heading">Attempt details</h2>
        <SubmissionFacts view={view} />
        <dl className="facts grading-facts"><div><dt>Grading</dt><dd>{gradingLabel(result.grading_mode)}</dd></div>{result.level && <div><dt>Level</dt><dd>{result.level}</dd></div>}</dl>
      </section>
    </div>
    <section className="surface panel result-section" aria-labelledby="domain-heading">
      <h2 id="domain-heading">Performance by domain</h2>
      <ul className="domains">{result.domains.map((domain) => <li key={domain.domain}>
        <div className="domain-heading"><strong>{domain.domain}</strong><span>{formatPercent(domain.percent)}</span></div>
        <progress className="progress-bar" max={100} value={domain.percent} aria-label={`${domain.domain} score percentage`} />
        <div className="domain-meta"><span>{formatScore(domain.earned_points)} / {formatScore(domain.maximum_points)} points</span><span>{domain.total} questions · {domain.unanswered} unanswered{domain.correct !== null ? ` · ${domain.correct} correct` : ''}</span></div>
      </li>)}</ul>
    </section>
    <section className="surface panel result-section" aria-labelledby="review-heading">
      <h2 id="review-heading">Question review</h2>
      {result.questions.length ? <>
        <p className="small">Expand a question to see your response, score, and any feedback.</p>
        <ExplanationUpdates state={explanations} />
        <div className="review-list">{result.questions.map((row, index) => <QuestionReview key={row.question_id} row={row} number={index + 1} explanations={explanations} />)}</div>
      </> : <p>Question review is not available for this exam.</p>}
    </section>
  </>;
}

export function Results({ id }: { id: string }) {
  const [view, setView] = useState<ResultView>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(false);
  usePage(view ? `${view.title} results` : 'Exam results');
  const retry = () => { setError(''); setAttempt((count) => count + 1); };

  useEffect(() => {
    let timeout: number | undefined;
    const controller = new AbortController();
    async function load() {
      try {
        const next = await api.results(id, controller.signal);
        if (controller.signal.aborted) return;
        setView(next);
        setError('');
        pending.current = next.status === 'pending_grading';
        if (pending.current) timeout = window.setTimeout(load, 2400);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(errorMessage(cause));
        if (pending.current) timeout = window.setTimeout(load, 5000);
      }
    }
    void load();
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [id, attempt]);

  return <Shell section="Exam results">
    <a className="text-link back-link" href="/"><Icon name="back" /> Exam library</a>
    {!view ? <LoadState error={error} retry={retry} /> : <>
      <PageTitle title={view.title} eyebrow="Exam results" />
      {error && <Notice error>Could not refresh results. {error} <button className="text-link inline-link" onClick={retry}>Check again</button></Notice>}
      {view.status === 'graded' ? <><Graded view={view} /><div className="result-links"><a className="button secondary" href={examPath(view.exam_id)}>Back to exam overview <Icon name="arrow" /></a></div></>
        : view.status === 'pending_grading' ? <div className="overview-grid">
          <section className="surface panel pending-panel"><span className="tile-icon"><Icon name="clock" /></span><h2>Grading in progress</h2><p role="status">Your attempt is submitted. This page updates automatically when your grade is ready.</p><button className="button secondary" onClick={retry}>Check for results</button></section>
          <section className="surface panel"><h2>Attempt details</h2><SubmissionFacts view={view} /></section>
        </div> : <section className="surface panel pending-panel"><h2>Attempt in progress</h2><p>Submit your attempt before you can view results.</p><a className="button primary" href={sessionPath(id)}>Return to attempt <Icon name="arrow" /></a></section>}
    </>}
  </Shell>;
}
