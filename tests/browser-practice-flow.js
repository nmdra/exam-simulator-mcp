// Run with Playwright CLI on the Backup and Recovery Practice intro page.
// Start examples/explanation-subscription-client.ts against the same database first.
async page => {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const snapshot = () => page.evaluate(async () => (await (await fetch(`/api${location.pathname}`)).json()).data);
  const question = (num) => page.getByText(`Question ${num} of 2`, { exact: true });
  const wrongAnswer = () => page.getByRole('radio', { name: 'Check that the backup file exists.' });
  const timer = () => page.getByRole('timer', { name: 'Time remaining' });
  const completed = () => page.getByText('This is deterministic mock content', { exact: false });

  await page.getByRole('button', { name: 'Start Exam' }).click();
  await question(1).waitFor({ timeout: 5_000 });
  const initial = await snapshot();
  await wrongAnswer().check();
  await page.getByRole('button', { name: 'Flag for review' }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await question(2).waitFor({ timeout: 5_000 });
  await page.reload();
  await question(2).waitFor({ timeout: 5_000 });
  const restored = await snapshot();
  expect(restored.deadline_at === initial.deadline_at, 'Refresh changed the deadline.');
  expect(restored.current_question_id === 'q2', 'Refresh did not restore question 2.');
  expect(restored.responses.some((row) => row.question_id === 'q1' && row.value === 'B'), 'Answer was not saved.');
  expect(restored.flagged_question_ids.includes('q1'), 'Flag was not saved.');
  expect((await timer().innerText()).includes(':'), 'Timer is not displayed.');

  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await page.getByRole('button', { name: 'Request Hint' }).click();
  await completed().waitFor({ timeout: 10_000 });
  await page.reload();
  await completed().waitFor({ timeout: 5_000 });
  expect(await wrongAnswer().isChecked(), 'Answer was not restored after the explanation completed.');

  await page.getByRole('button', { name: 'Submit exam', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('1 question unanswered.', { exact: false }).waitFor({ timeout: 5_000 });
  await dialog.getByRole('button', { name: 'Submit exam', exact: true }).click();
  await page.waitForURL('**/results', { timeout: 5_000 });
  const result = await page.evaluate(async () => (await (await fetch(`/api${location.pathname}`)).json()).data);
  expect(result.status === 'graded' && result.result.incorrect === 1 && result.result.unanswered === 1, 'Unexpected result.');
  const incorrect = page.locator('details').filter({ hasText: 'What best verifies' });
  const unanswered = page.locator('details').filter({ hasText: 'A tested restore procedure' });
  await incorrect.locator('summary').click();
  await unanswered.locator('summary').click();
  const whyWrong = { name: 'Request Why my answer was wrong', exact: true };
  await incorrect.getByRole('button', whyWrong).waitFor({ timeout: 5_000 });
  expect(await unanswered.getByRole('button', whyWrong).count() === 0, 'Why-wrong assistance was offered for an unanswered question.');
  return 'Browser verified: restored timer, navigation, answer and flag; MCP hint delivered and visible after refresh; result graded with assistance only for eligible answers.';
}
