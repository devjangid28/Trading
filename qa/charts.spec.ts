import { expect, test, type Page } from '@playwright/test';

/**
 * The S/R engine renders a status panel on the chart and a full S/R Engine tab
 * in the sidebar. The engine may be working on live candles (which can be
 * empty or errored offline), so the assertions pin the honesty contract: the
 * panel exists, never fabricates a number (dash when there is no level), and
 * re-mounts with the selected timeframe after a switch.
 */
test('S/R engine panel and sidebar tab render honest levels', async ({ page }, testInfo) => {
  await page.goto('/?tab=charts');
  await expect(page.locator('.charts-shell')).toBeVisible();

  const panel = page.locator('.charts-sr-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.charts-sr-panel-title')).toHaveText('S/R ENGINE');
  await expect(panel.locator('.charts-sr-panel-live')).toHaveText('LIVE');
  await expect(panel.locator('.charts-sr-hm')).toBeVisible();
  await expect(panel.locator('.charts-sr-hm')).toHaveText(/^HM (LIVE|FALLBACK|OFFLINE)$/);

  // Wait for either candles or a terminal empty/error state so the panel has
  // settled on the engine's answer before we read it.
  await expect
    .poll(async () => {
      const els = await page.locator('.charts-canvas canvas, .charts-overlay').count();
      return els;
    }, { timeout: 20_000 })
    .toBeGreaterThan(0);

  const cellText = async (cell: ReturnType<typeof page.locator>) => {
    const text = await cell.innerText();
    const hasPrice = /\d/.test(text);
    const hasBreak = text.includes('% break');
    if (hasPrice && !hasBreak) return 'pending';
    return text;
  };
  const resistance = panel.locator('.charts-sr-panel-cell.is-resistance');
  const support = panel.locator('.charts-sr-panel-cell.is-support');
  await expect.poll(async () => cellText(resistance), { timeout: 20_000 }).not.toBe('pending');
  await expect.poll(async () => cellText(support), { timeout: 20_000 }).not.toBe('pending');

  // Sidebar: open the S/R Engine tab.
  await page.getByRole('tab', { name: 'S/R Engine' }).click();
  await expect(page.getByRole('tab', { name: 'S/R Engine' })).toHaveAttribute('aria-selected', 'true');
  const stack = page.locator('.charts-sidebar-stack').first();
  await expect(stack).toBeVisible();
  await expect(stack.locator('.charts-sidebar-card-head').first()).toContainText('S/R ENGINE');
  await expect(stack.locator('.charts-sr-hm')).toBeVisible();
  await expect(stack.locator('.charts-sr-hm')).toHaveText(/^HM (LIVE|FALLBACK|OFFLINE)$/);

  const secondaryToggle = stack.getByRole('checkbox', { name: 'Alert on secondary break' });
  await expect(secondaryToggle).toBeChecked();
  await secondaryToggle.uncheck();
  await expect(secondaryToggle).not.toBeChecked();
  await secondaryToggle.check();
  await expect(secondaryToggle).toBeChecked();

  // Switch timeframe; the engine must recompute and the sidebar header must
  // reflect the switch. (Click, not the keyboard shortcut: focus sits on the
  // toggle we just used, and the shortcut ignores inputs.)
  await page.locator('.charts-timeframe').filter({ hasText: '1m' }).first().click();
  await expect(page.locator('.charts-timeframe.is-active')).toHaveText('1m');
  await expect(stack.locator('.charts-sidebar-card-head').first()).toContainText('1m', { timeout: 20_000 });

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: `qa/screens/charts-03-sr-${testInfo.project.name}.png` });
});

async function overlayState(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __ofOverlayIds?: string[];
      __ofChart?: { getOverlayById: (id: string) => { name: string; points: unknown[]; currentStep: number; totalStep: number } | null };
    };
    const id = (w.__ofOverlayIds ?? []).at(-1);
    if (!id) return null;
    const overlay = w.__ofChart?.getOverlayById(id);
    return overlay ? { name: overlay.name, points: overlay.points.length, currentStep: overlay.currentStep, totalStep: overlay.totalStep } : { missing: id };
  });
}

test('charts terminal renders the live chart workspace and controls', async ({ page }, testInfo) => {
  await page.goto('/?tab=charts');
  await expect(page.locator('.charts-shell')).toBeVisible();
  await expect(page.locator('.charts-topbar')).toBeVisible();
  await expect(page.locator('.charts-timeframes')).toBeVisible();
  await expect(page.locator('.charts-toolbar')).toBeVisible();
  await expect(page.locator('.charts-pane')).toBeVisible();
  await expect(page.locator('.charts-sidebar')).toBeVisible();
  await expect(page.locator('.charts-footer')).toBeVisible();
  await expect(page.locator('.terminal-views')).toHaveCount(0);
  await expect(page.locator('.heatmap-canvas')).toHaveCount(0);
  await expect(page.getByTestId('decision-rail')).toBeVisible();

  await expect(page.locator('.charts-timeframe.is-active')).toHaveText('15m');
  await page.getByRole('button', { name: '1h', exact: true }).click();
  await expect(page.locator('.charts-timeframe.is-active')).toHaveText('1h');
  await page.getByRole('button', { name: '15m', exact: true }).click();

  const ema = page.locator('.charts-indicator').filter({ hasText: 'EMA' });
  await ema.locator('.charts-indicator-main').click();
  await expect(ema).toHaveClass(/is-off/);
  await ema.locator('.charts-indicator-main').click();
  await expect(ema).not.toHaveClass(/is-off/);

  await page.getByRole('button', { name: 'Trend line' }).click();
  await expect(page.getByRole('button', { name: 'Trend line' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Cursor' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Full', exact: true }).click();
  await expect(page.locator('.charts-shell')).toHaveClass(/is-fullscreen/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.charts-shell')).not.toHaveClass(/is-fullscreen/);

  await page.getByRole('tab', { name: 'News' }).click();
  await expect(page.getByRole('tab', { name: 'News' })).toHaveAttribute('aria-selected', 'true');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: `qa/screens/charts-01-terminal-${testInfo.project.name}.png` });
});

test('chart drawing overlays complete', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Drawing smoke runs on desktop');
  await page.goto('/?tab=charts');
  await expect(page.locator('.charts-canvas canvas').first()).toBeVisible();
  await page.waitForTimeout(1_500);

  const canvas = await page.locator('.charts-canvas').boundingBox();
  expect(canvas).not.toBeNull();
  if (!canvas) return;

  await page.getByRole('button', { name: 'Rectangle' }).click();
  await page.mouse.click(canvas.x + canvas.width * 0.28, canvas.y + canvas.height * 0.22);
  await page.waitForTimeout(600);
  await page.mouse.click(canvas.x + canvas.width * 0.48, canvas.y + canvas.height * 0.38);
  await page.waitForTimeout(300);
  await expect.poll(() => overlayState(page)).toMatchObject({
    name: 'rectZone',
    points: 2,
    currentStep: -1,
    totalStep: 3,
  });
  await page.screenshot({ path: 'qa/screens/charts-02-drawings-desktop.png' });

  await page.getByRole('button', { name: 'Long position' }).click();
  await page.mouse.click(canvas.x + canvas.width * 0.2, canvas.y + canvas.height * 0.15);
  await page.waitForTimeout(600);
  await page.mouse.click(canvas.x + canvas.width * 0.4, canvas.y + canvas.height * 0.1);
  await page.waitForTimeout(600);
  await page.mouse.click(canvas.x + canvas.width * 0.4, canvas.y + canvas.height * 0.2);
  await page.waitForTimeout(300);
  await expect.poll(() => overlayState(page)).toMatchObject({
    name: 'longPosition',
    points: 3,
    currentStep: -1,
    totalStep: 4,
  });
});
