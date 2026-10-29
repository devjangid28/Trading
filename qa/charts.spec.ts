import { expect, test, type Page } from '@playwright/test';

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
