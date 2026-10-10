import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

test('loads the samples and diffs v1 against v2', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'genai-trace-diff' })).toBeVisible();

  await page.getByRole('button', { name: 'Load sample traces' }).click();
  await expect(page.getByTestId('load-status')).toHaveText('Loaded 5 traces from 4 files.');
  await expect(page.getByTestId('trace-table').locator('tbody tr')).toHaveCount(5);

  // Samples open straight into the diff of refund-v1 (A) and refund-v2 (B).
  await expect(page.getByRole('button', { name: 'Diff two traces' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('diff-summary')).toHaveText('3 changed · 2 only in B · 1 only in A · 1 same');

  const totals = page.getByTestId('totals-table');
  await expect(totals.getByRole('row', { name: /Cost/ })).toContainText('$0.005940');
  await expect(totals.getByRole('row', { name: /Cost/ })).toContainText('-$0.001475');
  await expect(totals.getByRole('row', { name: /Model calls/ })).toContainText('+1');

  const rows = page.getByTestId('diff-row');
  await expect(rows).toHaveCount(7);
  await expect(rows.nth(3)).toHaveAttribute('data-status', 'removed');
  await expect(rows.nth(3)).toContainText('refund_policy');
  await expect(rows.nth(5)).toHaveAttribute('data-status', 'added');
  await expect(rows.nth(5)).toContainText('issue_refund');

  // Changed tool arguments are listed with their path and values.
  const lookup = rows.nth(2);
  await expect(lookup).toContainText('arguments changed: include');
  await lookup.getByText('show values').first().click();
  await expect(lookup.locator('pre.after').first()).toContainText('"items"');

  // Swapping A and B flips the sign of the deltas.
  await page.getByRole('button', { name: 'Swap A and B' }).click();
  await expect(page.getByTestId('diff-summary')).toHaveText('3 changed · 1 only in B · 2 only in A · 1 same');
  await expect(totals.getByRole('row', { name: /Cost/ })).toContainText('+$0.001475');
});

test('shows a trace as a chat timeline with tool calls and errors', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Load sample traces' }).click();
  await page.getByRole('button', { name: 'Timeline' }).click();

  const timeline = page.getByRole('region', { name: /invoke_agent support-bot/ });
  await expect(timeline.getByTestId('step')).toHaveCount(5);
  await expect(timeline).toContainText('my order A-1001 arrived with the mug cracked');
  await expect(timeline).toContainText('calls lookup_order');
  await expect(timeline).toContainText('Shall I refund the $42.50');

  // Open the failing run from the trace table.
  const table = page.getByTestId('trace-table');
  await table.getByRole('row', { name: /refund-v2-timeout/ }).getByRole('button').click();
  await expect(page.getByText('Error: payments API timed out after 5000 ms').first()).toBeVisible();
});

test('loads files from the file picker and reports bad files', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('file-input').setInputFiles([fixture('agent-runtime-kit.otlp.json')]);
  await expect(page.getByTestId('load-status')).toHaveText('Loaded 2 traces from 1 file.');
  // agent-runtime-kit traces carry tokens but no cost attribute.
  await expect(page.getByRole('region', { name: /invoke_agent support-bot/ })).toContainText('not priced');

  await page.getByTestId('file-input').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"spans": []}') });
  await expect(page.getByRole('alert')).toContainText('broken.json: expected an OTLP/JSON object with a "resourceSpans" array');
});
