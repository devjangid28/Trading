import { expect, test } from '@playwright/test';

interface WhaleDebugPlan {
  visibleCandles: number;
  rightPadPx: number;
  seamPct: number | null;
  candleBandPct: number;
  bubbleCount: number;
  maxRadius: number;
  overlapMaxFrac: number;
  tagCount: number;
  netHeader: number;
  readingNet: number;
  solidEnd: number | null;
  timeLabelColor: string;
  timeLabelsGe6: boolean;
  zonesOn: boolean;
  bandHeightPx: number;
  plot: { left: number; right: number; top: number; bottom: number };
}

test('whales reference CHECKS (D1-D12), desktop web only', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 900, 'Desktop shell assertions.');

  await page.goto('/?tab=whales&debugwhales=1');
  await expect(page.locator('.whales-view')).toBeVisible();
  await page.waitForFunction(
    () => (window as { __whalesPlan?: { visibleCandles: number } }).__whalesPlan?.visibleCandles >= 120,
    undefined,
    { timeout: 30_000 },
  );

  const plan = await page.evaluate(
    () => (window as { __whalesPlan?: unknown }).__whalesPlan as WhaleDebugPlan,
  );
  console.log('PLAN', JSON.stringify({ ...plan, plot: plan.plot }));

  // D1: candles and trades share one price series
  expect(plan.seamPct === null ? 0 : plan.seamPct).toBeLessThanOrEqual(0.2);

  // D2: ~145 candles at default zoom, ~100px right padding
  expect(plan.visibleCandles).toBeGreaterThanOrEqual(120);
  expect(plan.visibleCandles).toBeLessThanOrEqual(160);
  expect(plan.rightPadPx).toBeGreaterThanOrEqual(80);
  expect(plan.rightPadPx).toBeLessThanOrEqual(120);

  // D2: Y range is candle H/L + 8% padding (band >= 70% of panel)
  expect(plan.candleBandPct).toBeGreaterThanOrEqual(0.7);

  // D3: bounded bubbles, capped radius, clustered overlaps
  expect(plan.bubbleCount).toBeLessThanOrEqual(14);
  expect(plan.maxRadius).toBeLessThanOrEqual(38);
  expect(plan.overlapMaxFrac).toBeLessThanOrEqual(0.5);

  // D4: at most 3 whale-action tags
  expect(plan.tagCount).toBeLessThanOrEqual(3);

  // D9: bubble-net header === reading-bar net; solid line ends there
  expect(Math.abs(plan.netHeader - plan.readingNet)).toBeLessThanOrEqual(1);
  expect(plan.solidEnd).not.toBeNull();
  expect(Math.abs((plan.solidEnd ?? 0) - plan.readingNet)).toBeLessThanOrEqual(1);

  // D10: time-axis color + >= 6 labels
  expect(plan.timeLabelColor).toBe('#6b7686');
  expect(plan.timeLabelsGe6).toBe(true);

  // D6: Zones default OFF; olive band thin
  expect(plan.zonesOn).toBe(false);
  expect(plan.bandHeightPx).toBeLessThanOrEqual(60);

  // D7: tooltip stays inside the plot at 10% / 50% / 95% width
  const canvas = page.locator('.whales-canvas-host canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const plotLeft = box!.x + plan.plot.left;
  const plotRight = box!.x + plan.plot.right;
  const plotTop = box!.y + plan.plot.top;
  const plotBottom = box!.y + plan.plot.bottom;
  for (const fx of [0.1, 0.5, 0.95]) {
    const x = plotLeft + (plotRight - plotLeft) * fx;
    const y = (plotTop + plotBottom) / 2;
    await page.mouse.move(x, y);
    await page.waitForTimeout(250);
    const tt = await page.locator('.whales-tooltip').boundingBox();
    expect(tt).not.toBeNull();
    expect(tt!.x).toBeGreaterThanOrEqual(plotLeft - 1);
    expect(tt!.x + tt!.width).toBeLessThanOrEqual(plotRight + 1);
    expect(tt!.y).toBeGreaterThanOrEqual(plotTop - 1);
    expect(tt!.y + tt!.height).toBeLessThanOrEqual(plotBottom + 1);
  }

  // D11: dock shows exactly one verdict
  await expect(page.locator('.whales-dock__lean')).toHaveCount(1);
  await page.locator('.whales-dock__toggle').click();
  await expect(page.locator('.whales-dock.is-open .dock-lean')).toHaveCount(1);
});
