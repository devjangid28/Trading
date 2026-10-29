import { test, expect, type Page } from '@playwright/test';

/**
 * Honesty acceptance — M1.4.
 *
 * These exist because the four defects fixed in M1.4 were all invisible on
 * screen: every one of them rendered a plausible number. A fabricated
 * liquidation total looks exactly like a quiet market, and a hardcoded
 * `fundingZ: 0` rendered as "z=0.00" reads like a real statistic that happened
 * to be zero.
 *
 * So the contract under test is what does NOT appear.
 *
 * Runs against `dev:mock` (fixture replay). No exchange traffic.
 */

async function openDerivatives(page: Page): Promise<void> {
  await page.goto('/?tab=derivatives', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.getByText(/Derivatives heatmap/i)).toBeVisible({ timeout: 30_000 });
  /**
   * The panel title paints immediately; the rows arrive one poll later. Waiting
   * on the title alone made these tests read an empty table and pass vacuously,
   * which is worse than failing — so wait for an actual row.
   */
  await expect(page.getByTestId('liq-cell').first()).toBeVisible({ timeout: 30_000 });
}

test.describe('a value is never a lie', () => {
  test('the liquidation column never reports a fabricated zero', async ({ page }) => {
    await openDerivatives(page);

    // The derivatives poll resolves after the first paint, so openDerivatives has
    // already waited for real rows; counting here is safe.
    const cells = page.getByTestId('liq-cell');
    const n = await cells.count();
    expect(n).toBeGreaterThan(0);

    // Either a real amount, an em-dash for "zero observed on an attached
    // feed", or "n/a" for "no feed". Never "$0".
    for (let i = 0; i < Math.min(n, 12); i++) {
      const text = (await cells.nth(i).innerText()).trim();
      expect(text, `row ${i} shows a fabricated zero`).not.toBe('$0');
      expect(text, `row ${i} shows a fabricated zero`).not.toBe('$0.00');
    }

    // Where the feed is absent, the cell must say why on hover rather than
    // leaving an empty cell that reads as "no liquidations".
    const unavailable = page.locator('td[title*="No liquidation feed"]');
    if ((await unavailable.count()) > 0) {
      await expect(unavailable.first()).toHaveText('n/a');
    }
  });

  test('the funding tooltip does not claim a z-score it never computed', async ({ page }) => {
    await openDerivatives(page);

    // "z=0.00" is the exact string the hardcoded placeholder produced.
    await expect(page.locator('[title*="z=0.00"]')).toHaveCount(0);

    const honest = page.locator('[title*="z not computed"]');
    const computed = page.locator('[title*="z="]');
    // The tooltip must either admit it has no z-score, or carry a real one.
    expect((await honest.count()) + (await computed.count())).toBeGreaterThan(0);
  });

  test('the CVD tooltip states that it is a derived proxy', async ({ page }) => {
    await openDerivatives(page);

    // CVD comes from spot kline taker-buy notional. A reader must not be able
    // to mistake it for a futures trade tape, which is what the old
    // `source: 'binance-futures'` label invited.
    await expect(page.locator('[title*="not a futures trade tape"]').first()).toBeVisible();
  });
});