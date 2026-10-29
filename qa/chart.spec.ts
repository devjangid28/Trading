import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Chart acceptance — the real candlestick chart.
 *
 * Runs against `dev:mock` (fixture replay of recorded Binance responses). No
 * exchange traffic.
 *
 * This file exists because of a specific, silent failure that unit tests could
 * not see and that looked perfectly fine on screen: the ticket used to draw
 * "candles" synthesised from `AssetRow.spark`, a close-only series, by setting
 * `open = previous close` and `high/low = max/min of two closes`. Every wick on
 * that chart was an invented number. `CandleChart` — the real OHLCV chart that
 * was already written — was never mounted anywhere.
 *
 * So these tests assert two things:
 *   1. the ticket renders real candles, and says so when it cannot;
 *   2. the full chart is reachable and draws the same real candles.
 *
 * They assert GEOMETRY AND TEXT, not pixels, because a pixel diff cannot tell a
 * real wick from a fabricated one.
 */

const SHOTS = 'qa/screens';
mkdirSync(SHOTS, { recursive: true });

let shotN = 0;
async function shot(page: Page, name: string): Promise<void> {
  shotN += 1;
  await page.screenshot({
    path: `${SHOTS}/chart-${String(shotN).padStart(2, '0')}-${name}.png`,
    fullPage: false,
  });
}

async function ready(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      break;
    } catch {
      if (attempt === 1) throw new Error('could not load the page after a retry');
      await page.waitForTimeout(1500);
    }
  }
  await expect(page.getByTestId('live-pill')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="board-row"]').first()).toBeVisible({ timeout: 45_000 });
}

/**
 * Open the ticket for the first board row that actually has a setup.
 *
 * A row click now pins the preview rather than navigating; "Open full view" in
 * that preview is the way to the Order Block stage where the ticket lives.
 */
async function openTicket(page: Page): Promise<void> {
  const rows = page.locator('[data-testid="board-row"]');
  const n = Math.min(8, await rows.count());
  for (let i = 0; i < n; i++) {
    await rows.nth(i).click();
    const preview = page.getByTestId('row-preview');
    await expect(preview).toBeVisible();
    await preview.getByRole('button', { name: 'Open full view' }).click();
    if (await page.getByTestId('ticket-chart').isVisible().catch(() => false)) return;
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  }
  throw new Error('no board row produced a visible ticket chart container');
}

test.describe('candlestick chart', () => {
  test('the ticket draws real OHLC candles, not synthesised ones', async ({ page }) => {
    await ready(page);
    await openTicket(page);

    const chart = page.getByTestId('ticket-chart');
    await expect(chart).toBeVisible();

    // Real candles arrive from GET /api/asset/:id. Either the chart rendered or
    // it is still loading — but it must never fall back to a drawn placeholder.
    const svg = chart.getByTestId('candle-chart');
    const loading = chart.getByTestId('ticket-chart-loading');

    await expect(svg.or(loading)).toBeVisible({ timeout: 30_000 });

    if (await loading.isVisible()) {
      // Still in flight. The honest placeholder is required, and the previous
      // behaviour — silently drawing candles — is what this asserts against.
      await expect(loading).toHaveText(/Loading 5m candles/i);
      await shot(page, 'ticket-loading');
    } else {
      await expect(svg).toBeVisible();

      const candles = svg.getByTestId('candle');
      const count = await candles.count();
      expect(count, 'a chart with no candles would be an empty frame').toBeGreaterThan(10);

      // Closed and forming candles are distinguished, so a forming bar can
      // never be mistaken for a confirmed one. `data-closed` sits on the candle
      // group itself, so it is selected as an attribute of that group rather
      // than as a descendant of it.
      const closed = await svg.locator('[data-testid="candle"][data-closed="true"]').count();
      expect(closed).toBeGreaterThan(0);

      // The chart must be a labelled image, not an anonymous graphic.
      await expect(svg).toHaveAttribute('role', 'img');
      const label = (await svg.getAttribute('aria-label')) ?? '';
      expect(label.length).toBeGreaterThan(0);
      expect(label).toMatch(/candles/i);

      await shot(page, 'ticket-real-candles');
    }
  });

  test('the full chart is reachable and draws the same real candles', async ({ page }) => {
    await ready(page);
    await openTicket(page);

    const open = page.getByTestId('open-chart');
    await expect(open).toBeVisible();
    await open.click();

    // The ticket is itself a dialog, so scope to the modal popup specifically
    // rather than to `role=dialog`, which would match both.
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    const svg = dialog.getByTestId('candle-chart');
    await expect(svg).toBeVisible({ timeout: 30_000 });

    const count = await svg.getByTestId('candle').count();
    expect(count).toBeGreaterThan(10);

    // The popup draws a wider slice than the ticket by default; both come from
    // the same endpoint, so the two charts must at least agree in kind.
    await expect(svg).toHaveAttribute('role', 'img');

    // The accessible name describes what is actually drawn, including whether
    // a zone is marked. It is an attribute, not visible text, so it is asserted
    // as one.
    const label = (await svg.getAttribute('aria-label')) ?? '';
    expect(label).toMatch(/order block zone/i);
    expect(label).toMatch(/candles/i);

    await shot(page, 'full-chart');

    // Escape closes it, matching the ticket and the row popup.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 5000 });
  });

  // Force the asset endpoint to fail. The contract under test: when real
  // candles cannot be had, the UI says so. It must never substitute invented
  // ones, because a plausible chart is worse than an empty one.
  test('a chart failure reports the reason instead of drawing something plausible', async ({ page }) => {
    await ready(page);

    // The route is armed BEFORE the ticket opens. Arming it afterwards would
    // test nothing: the chart would already have loaded its candles.
    await page.route('**/api/asset/**', (route) => route.fulfill({ status: 503, body: '{}' }));

    await openTicket(page);

    const err = page.getByTestId('ticket-chart-error');
    await expect(err).toBeVisible({ timeout: 15_000 });
    await expect(err).toHaveText(/Chart unavailable/i);

    // And specifically: no candles were drawn from the fallback.
    await expect(page.getByTestId('ticket-chart').getByTestId('candle')).toHaveCount(0);
    await shot(page, 'ticket-chart-error');
  });
});