import { test, expect, type Page } from '@playwright/test';

// Cold mock stacks (first Vite dep-optimise + the fixture replay server) can take
// a minute to boot; the global 60s budget is too tight for that plus the steady
// state watch below.
test.describe.configure({ timeout: 150_000 });

/**
 * Regression — the live-stream context must settle once events arrive.
 *
 * `useLiveStream` used to derive `lastDataAgeMs` from a raw `Date.now()` read
 * during render. `useLiveStreamProvider` memoises its published context on that
 * value, so every render produced a freshly-identified context, which
 * republished it, which force-rendered every `useLive()` subscriber, which
 * re-rendered the hook. React reports the runaway as "Maximum update depth
 * exceeded" and the tab freezes.
 *
 * The loop only began once the first SSE event set `lastDataAt`, so the initial
 * paint looked fine and the terminal showed no error — the failure lived
 * entirely in the browser, which is why it belongs in this suite and not in
 * vitest (there is no DOM environment there).
 *
 * Runs against `dev:mock`, whose feed sends a `snapshot` on connect and a tick
 * every second, so the trigger is deterministic.
 */

/** Load the app and wait until the board is populated (scan + SSE snapshot in). */
async function openBoard(page: Page): Promise<void> {
  // Mirrors home.spec's `ready()`: on the very first load Vite discovers and
  // pre-bundles dependencies and triggers a full reload, which aborts the first
  // navigation. The retry keeps that warm-up from reading as a failure.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      break;
    } catch {
      if (attempt === 1) throw new Error('could not load the page after a retry');
      await page.waitForTimeout(1500);
    }
  }
  await expect(page.locator('[data-testid="board-row"]').first()).toBeVisible({ timeout: 45_000 });
}

test.describe('live stream context', () => {
  test('settles after the first SSE event instead of looping', async ({ page }) => {
    const loopWarnings: string[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (/Maximum update depth exceeded/i.test(text)) loopWarnings.push(text);
      else consoleErrors.push(text);
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await openBoard(page);

    // Judge the steady state only: discard any warm-up noise from the first
    // paint, then watch where the loop actually lives.
    loopWarnings.length = 0;
    consoleErrors.length = 0;
    pageErrors.length = 0;

    // Several 1s ticks and a simulated 5m candle close flow through here. If the
    // context churns, React floods the console within a couple of seconds.
    await page.waitForTimeout(8_000);

    expect(loopWarnings, `render loop warnings:\n${loopWarnings.join('\n')}`).toEqual([]);
    const fatal = pageErrors.filter((e) => /Too many re-renders|Maximum update depth/i.test(e));
    expect(fatal, `render loop errors:\n${fatal.join('\n')}`).toEqual([]);
    // Unrelated console errors (an upstream 429, a StrictMode aborted fetch) are
    // reported but do not fail this test — its job is the render loop only.
    if (consoleErrors.length) console.log(`[live-loop] unrelated console errors:\n${consoleErrors.join('\n')}`);

    // A tab stuck in a render loop cannot answer this or keep its rows painted.
    expect(await page.evaluate(() => 1 + 1)).toBe(2);
    expect(await page.locator('[data-testid="board-row"]').count()).toBeGreaterThan(0);
  });
});
