import { useCallback, useEffect, useRef, useState } from 'react';
import type { CandidateQuestion, ResponseValue, SessionView } from '@exam-runtime/core';
import { api, resultPath } from './api';
import { useAttempt } from './attempt-state';
import { ExplanationPanel, ExplanationUpdates, useExplanations } from './explanations';
import { clockDisplay, countLabel, Icon, LoadState, Notice, Shell, useHeadingFocus, usePage, useResource } from './ui';

const typeLabels = { single_select: 'Choose one answer', multi_select: 'Choose all that apply', true_false: 'Choose true or false', free_text: 'Write your response' };

function AnswerField({ question, value, locked, onChange }: {
  question: CandidateQuestion; value: ResponseValue; locked: boolean; onChange: (value: ResponseValue) => void;
}) {
  const options = question.options ?? [];
  const multiple = question.type === 'multi_select';
  return <fieldset disabled={locked} className="answer-fields">
    <legend>{typeLabels[question.type]}</legend>
    {question.type === 'free_text' ? <>
      <label htmlFor="written-answer" className="sr-only">Your response</label>
      <textarea id="written-answer" value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)} maxLength={20_000} rows={6} placeholder="Enter your response here…" />
    </> : <div className="option-list">{options.map((option, index) => {
      const id = question.type === 'true_false' ? option.id === 'true' : option.id;
      const checked = multiple ? Array.isArray(value) && value.includes(option.id) : value === id;
      return <label className="option" key={option.id}>
        <input type={multiple ? 'checkbox' : 'radio'} name={`answer-${question.id}`} checked={checked} onChange={() => {
          if (!multiple) return onChange(id);
          const current = Array.isArray(value) ? value : [];
          const next = checked ? current.filter((selection) => selection !== option.id) : [...current, option.id];
          onChange(next.length ? next : null);
        }} />
        <span className="option-letter" aria-hidden="true">{index < 26 ? String.fromCharCode(65 + index) : `A${String.fromCharCode(65 + index - 26)}`}</span>
        <span className="prose-text">{option.text}</span>
      </label>;
    })}</div>}
    {value !== null && <button className="button subtle clear-answer" onClick={() => onChange(null)}>Clear response</button>}
  </fieldset>;
}

function Timer({ seconds }: { seconds: number }) {
  return <div className={`timer ${seconds <= 60 ? 'timer-low' : ''}`}>
    <Icon name="clock" />
    <span className="timer-label">Time left</span>
    <span role="timer" aria-label="Time remaining" className="timer-value">{clockDisplay(seconds)}</span>
    <span className="sr-only" role="status">{seconds === 0 ? 'Time has expired.' : seconds <= 60 ? 'One minute or less remains.' : seconds <= 300 ? 'Five minutes or less remain.' : ''}</span>
  </div>;
}

function Workspace({ initial }: { initial: SessionView }) {
  const { session, seconds, expired, draft, saving, submitting, saveError, submitError, clockError, changeAnswer, changeFlag, changeQuestion, prepareToLeave, submit, retrySave, discard, retryClock } = useAttempt(initial);
  const [expiredSelection, setExpiredSelection] = useState<string>();
  const [preparing, setPreparing] = useState(false);
  const inTransition = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const submitTrigger = useRef<HTMLButtonElement | null>(null);
  const selected = (expired ? expiredSelection : undefined) ?? session.current_question_id;
  const index = Math.max(0, session.questions.findIndex((item) => item.id === selected));
  const question = session.questions[index];
  const focus = useHeadingFocus<HTMLHeadingElement>(question?.id);
  const responseById = new Map(session.responses.map((entry) => [entry.question_id, entry.value]));
  const flagged = new Set(session.flagged_question_ids);
  const questionDraft = draft?.question === question?.id ? draft : null;
  const total = session.progress.total;
  const autoFinishing = expired && session.auto_submit_on_timeout;
  const explanations = useExplanations(session.id, !expired && session.status === 'in_progress');
  usePage(session.title);

  async function transition(action: () => void | Promise<boolean>) {
    if (inTransition.current || submitting) return;
    inTransition.current = true;
    setPreparing(true);
    try { if (await prepareToLeave()) await action(); }
    finally { inTransition.current = false; setPreparing(false); }
  }

  function go(nextIndex: number) {
    const next = session.questions[nextIndex];
    if (!next || next.id === question?.id || autoFinishing) return;
    void transition(() => {
      if (expired) setExpiredSelection(next.id); // Read-only browsing after time expires.
      else return changeQuestion(next.id);
    });
  }

  function confirm(trigger: HTMLButtonElement) {
    if (autoFinishing) return;
    void transition(() => {
      submitTrigger.current = trigger;
      dialog.current?.showModal();
      cancel.current?.focus();
    });
  }

  function closeDialog() { dialog.current?.close(); }

  return <Shell section="Exam in progress" tools={<Timer seconds={seconds} />}>
    <div className="attempt-title"><p className="eyebrow">{session.subject}</p><h1>{session.title}</h1></div>
    {expired && <Notice>{autoFinishing ? 'Time is up. Finalizing your saved answers…' : 'Time is up. Answers and flags are locked. Submit your attempt to finish.'}</Notice>}
    {clockError && <Notice error>Could not confirm the timer with the server. {clockError} <button className="text-link inline-link" onClick={retryClock}>Check again</button></Notice>}
    {submitError && <Notice error>Could not submit the attempt. {submitError}</Notice>}
    {saveError && <Notice error>{saveError}{!expired && <div className="notice-actions"><button className="button secondary" onClick={retrySave} disabled={saving}>Retry save</button><button className="button subtle" onClick={discard} disabled={saving}>Discard unsaved change</button></div>}</Notice>}
    <ExplanationUpdates state={explanations} />
    <div className="attempt-grid">
      <section className="surface question-panel" aria-labelledby="question-heading">
        {question && <>
          <div className="question-top"><div className="question-labels"><span className="eyebrow">Question {index + 1} of {total}</span><span className="pill">{question.domain}</span></div>
            {session.allow_review && <button className="button subtle flag-button" aria-label="Flag for review" aria-pressed={questionDraft?.kind === 'flag' ? questionDraft.flagged : flagged.has(question.id)} disabled={expired || submitting} aria-disabled={!!draft || preparing || undefined} onClick={() => { if (!inTransition.current) changeFlag(question.id, !flagged.has(question.id)); }}><Icon name="flag" />{(questionDraft?.kind === 'flag' ? questionDraft.flagged : flagged.has(question.id)) ? 'Flagged' : 'Flag for review'}</button>}
          </div>
          <h2 id="question-heading" className="question-text prose-text" ref={focus} tabIndex={-1}>{question.text}</h2>
          <AnswerField key={question.id} question={question} value={questionDraft?.kind === 'answer' ? questionDraft.value : responseById.get(question.id) ?? null} locked={expired || submitting || preparing || draft?.kind === 'flag' || draft?.kind === 'navigation'} onChange={(value) => { if (!inTransition.current) changeAnswer(question.id, value); }} />
          <div className="question-foot">
            <span className="save-status" role="status">{saving ? 'Saving…' : draft ? 'Change not saved' : <><Icon name="check" /> Changes saved</>}</span>
            <div className="question-actions">
              <button className="button secondary" disabled={index === 0 || submitting} aria-disabled={preparing || undefined} onClick={() => go(index - 1)}><Icon name="back" /> Previous</button>
              {index + 1 < total ? <button className="button primary" aria-disabled={preparing || undefined} disabled={submitting} onClick={() => go(index + 1)}>Next <Icon name="arrow" /></button>
                : <button className="button primary" aria-disabled={preparing || undefined} disabled={submitting || autoFinishing} onClick={(event) => confirm(event.currentTarget)}>Submit exam <Icon name="arrow" /></button>}
            </div>
          </div>
          <ExplanationPanel state={explanations} questionId={question.id} />
        </>}
      </section>
      <aside className="surface navigator" aria-labelledby="navigator-heading">
        <div className="navigator-progress"><h2 id="navigator-heading">Your progress</h2><span>{session.progress.answered} / {total}</span></div>
        <progress className="progress-bar" max={total} value={session.progress.answered} aria-label="Questions answered" />
        <dl className="legend">
          <div><dt><i className="dot answered-dot" /> Answered</dt><dd>{session.progress.answered}</dd></div>
          <div><dt><i className="dot" /> Unanswered</dt><dd>{session.progress.unanswered}</dd></div>
          {session.allow_review && <div><dt><i className="dot flag-dot" /> Flagged</dt><dd>{session.progress.flagged}</dd></div>}
        </dl>
        <nav aria-label="Questions" className="question-nav">
          {session.questions.map((entry, questionIndex) => {
            const answered = responseById.has(entry.id) && responseById.get(entry.id) !== null;
            const marked = flagged.has(entry.id);
            return <button key={entry.id} className={`number-button${answered ? ' is-answered' : ''}${marked ? ' is-flagged' : ''}`} aria-current={entry.id === question?.id ? 'step' : undefined} aria-label={`Question ${questionIndex + 1}, ${answered ? 'answered' : 'unanswered'}${marked ? ', flagged' : ''}`} disabled={submitting} aria-disabled={preparing || undefined} onClick={() => go(questionIndex)}>{questionIndex + 1}</button>;
          })}
        </nav>
        <button className="button secondary w-full" disabled={submitting || autoFinishing} aria-disabled={preparing || undefined} onClick={(event) => confirm(event.currentTarget)}>{submitting ? 'Submitting…' : 'Submit exam'}</button>
      </aside>
    </div>
    <dialog ref={dialog} className="confirm-dialog" aria-labelledby="submit-heading" onClose={() => submitTrigger.current?.focus()}>
      <div className="dialog-body"><span className="tile-icon"><Icon name="check" /></span><h2 id="submit-heading">Submit this exam?</h2>
        <p>{session.progress.unanswered ? `${countLabel(session.progress.unanswered, 'question')} unanswered. ` : 'You answered every question. '}Only saved answers are submitted, and you cannot make changes afterward.</p>
        <form className="dialog-actions" onSubmit={(event) => { event.preventDefault(); closeDialog(); void submit(); }}>
          <button ref={cancel} type="button" className="button secondary" onClick={closeDialog}>Keep working</button>
          <button className="button primary" type="submit">Submit exam</button>
        </form>
      </div>
    </dialog>
  </Shell>;
}

function Finished({ id }: { id: string }) {
  useEffect(() => { window.location.replace(resultPath(id)); }, [id]);
  return <Shell section="Exam complete"><p role="status">Opening your results…</p></Shell>;
}

export function Attempt({ id }: { id: string }) {
  const load = useCallback((signal: AbortSignal) => api.session(id, signal), [id]);
  const { data, error, retry } = useResource(load);
  if (!data) return <Shell section="Exam attempt"><LoadState error={error} retry={retry} /></Shell>;
  if (data.status !== 'in_progress') return <Finished id={id} />;
  return <Workspace initial={data} />;
}
