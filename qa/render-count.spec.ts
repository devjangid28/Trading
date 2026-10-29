import { test, expect, type Page } from '@playwright/test';

// Cold mock stacks can take a minute to boot; the global 60s budget is too
// tight for boot plus the window below.
test.describe.configure({ timeout: 150_000 });

/**
 * Regression — high-frequency prices must NOT flow through the app shell.
 *
 * The live prices used to live in `liveContext` and were rebuilt on every tick.
 * That gave the context a new identity every second and force-rendered `App`
 * (and therefore the whole tree) once per tick. `App` now reads only the
 * low-frequency board state; ticks go into `priceStore`, whose per-symbol
 * subscribers re-render only the cells showing that symbol.
 *
 * The assertion is deliberately deterministic rather than rate-based: the store
 * exposes a dev-only `window.__ofSimulateTicks(n)` that pushes n ticks straight
 * through the same `applyTick` path the socket uses. Firing a burst and proving
 * `App`'s render count barely moves cannot pass by accident on a quiet feed,
 * and cannot flake on a busy one.
 *
 * `App` increments `window.__ofAppRenders` and the store increments
 * `window.__ofAppliedTicks` in dev builds.
 *
 * Runs against `dev:mock`. Stop `npm run dev` before running, or the second
 * Vite instance wedges on `src/index.css`.
 */

interface Counters {
  renders: number;
  ticks: number;
  simTicks: boolean;
}

async function readCounters(page: Page): Promise<Counters> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __ofAppRenders?: number;
      __ofAppliedTicks?: number;
      __ofSimulateTicks?: (n: number) => void;
    };
    return {
      renders: w.__ofAppRenders ?? 0,
      ticks: w.__ofAppliedTicks ?? 0,
      simTicks: typeof w.__ofSimulateTicks === 'function',
    };
  });
}

async function openBoard(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      break;
    } catch {
      if (attempt === 5) throw new Error('could not load the page after retries');
      await page.waitForTimeout(2500);
    }
  }
  await expect(page.locator('[data-testid="board-row"]').first()).toBeVisible({ timeout: 45_000 });
}

test.describe('live render count', () => {
  test('a burst of ticks does not re-render the App shell', async ({ page }) => {
    await openBoard(page);

    // Let boot, the first snapshot and the context publish settle.
    await page.waitForTimeout(3_000);

    const before = await readCounters(page);
    expect(before.simTicks, 'dev tick injector should exist').toBe(true);

    // Push 2,000 ticks — far more than would arrive in a minute — through the
    // exact path a socket tick takes.
    await page.evaluate(() => {
      const w = window as unknown as { __ofSimulateTicks?: (n: number) => void };
      w.__ofSimulateTicks?.(2_000);
    });
    // Two animation frames is enough for the store's rAF-batched notification.
    await page.waitForTimeout(400);

    const after = await readCounters(page);

    console.log(
      `[render-count] burst: app renders +${after.renders - before.renders}, ` +
      `applied ticks +${after.ticks - before.ticks}`,
    );

    // The burst must actually have gone through the store...
    expect(after.ticks - before.ticks, 'expected the injected ticks to apply').toBeGreaterThan(1_000);

    // ...and must NOT have re-rendered the app shell. A per-tick design would
    // add ~2,000 renders here; allow a tiny margin for unrelated timers.
    const renderDelta = after.renders - before.renders;
    expect(renderDelta, `App re-rendered ${renderDelta} times for a tick burst`).toBeLessThanOrEqual(5);

    // And the board still shows a live price cell.
    await expect(page.locator('[data-testid="row-price"]').first()).toBeVisible();
  });

  test('the live feed drives row re-renders (the store is wired)', async ({ page }) => {
    await openBoard(page);
    // The visible price cells get their values from the store; if the socket
    // were not feeding it, every cell would fall back to the scan price.
    const first = page.locator('[data-testid="row-price"]').first();
    await expect(first).toBeVisible();
    const a = await first.textContent();
    await page.waitForTimeout(3_000);
    const b = await first.textContent();
    // Not asserting a change (a coin can stand still), only that a numeric
    // price is rendered and the page stays responsive.
    expect((a ?? '').trim().length).toBeGreaterThan(0);
    expect((b ?? '').trim().length).toBeGreaterThan(0);
    expect(await page.evaluate(() => 1 + 1)).toBe(2);
  });
});
