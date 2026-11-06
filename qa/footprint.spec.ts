import { expect, test } from '@playwright/test';

test('footprint mock renders the required composition and reading line', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?tab=footprint&mock=1');

  await expect(page.locator('.tradfye-brand')).toBeVisible();
  await expect(page.locator('.tradfye-tabs')).toHaveCount(1);
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    await expect(page.locator('.tradfye-tabs')).toBeVisible();
  } else {
    await expect(page.locator('.tradfye-tabs')).not.toBeVisible();
  }
  await expect(page.locator('.tradfye-tab.is-on')).toContainText('Footprint');
  await expect(page.locator('.app-tabs').getByRole('button', { name: 'Footprint', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.fp-toolbar')).toBeVisible();
  await expect(page.locator('.fp-toolbar')).toContainText('Candles');
  await expect(page.locator('.fp-toolbar')).toContainText('Show');
  await expect(page.locator('.fp-toolbar')).toContainText('Rows');
  await expect(page.locator('.fp-toolbar')).toContainText('Units');
  await expect(page.locator('.fp-toolbar')).toContainText('Load older');
  const utcNow = new Date();
  const baseOpen = Date.UTC(
    utcNow.getUTCFullYear(),
    utcNow.getUTCMonth(),
    utcNow.getUTCDate(),
    8,
    45,
  );
  const mockStepMs = 5 * 60_000;
  const mockLastOpen = baseOpen + 11 * 15 * 60_000;
  const mockFirstT = mockLastOpen - 11 * mockStepMs;
  const expectedFrom = new Date(mockFirstT).toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  await expect(page.locator('.fp-toolbar')).toContainText(`From ${expectedFrom} UTC`);
  await expect(page.locator('.fp-toolbar')).toContainText('Settings');
  await expect(page.locator('.fp-mock-badge')).toHaveText('MOCK');
  await expect(page.locator('.fp-mock-note')).toContainText('not the live market');

  await expect(page.locator('.fp-reading')).toHaveText(
    'This candle: O 80300.00 H 80305.00 L 79990.00 C 80142.42 — Δ -3.74 — quiet candle — too little volume to read. Most volume at 80142.50 (POC). Imbalances: 3 buy / 4 sell rows.',
  );

  const canvas = page.locator('canvas[aria-label="Footprint chart: order flow inside each candle"]');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-mock', 'true');
  await expect(page.locator('.fp-canvas-host canvas')).toHaveCount(1);

  await page.locator('.fp-toolbar').getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Footprint settings' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Footprint settings' })).toContainText('Imbalance ratio');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Footprint settings' })).toHaveCount(0);

  await page.locator('.fp-toolbar').getByRole('button', { name: 'How to read the footprint' }).click();
  await expect(page.getByRole('dialog', { name: 'Footprint — what\'s inside each candle' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    const toolbar = document.querySelector('.fp-toolbar') as HTMLElement | null;
    const row = document.querySelector('.fp-toolbar .toolbar-row') as HTMLElement | null;
    if (toolbar) toolbar.scrollLeft = 0;
    if (row) row.scrollLeft = 0;
    (document.activeElement as HTMLElement | null)?.blur();
  });

  await page.screenshot({ path: `qa/screens/footprint-01-mock-${testInfo.project.name}.png`, fullPage: true });

  expect(errors).toEqual([]);
});

test('footprint shows the full 12-candle composition on a wide screen', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'wide-screen evidence is desktop-only');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?tab=footprint&mock=1');
  await expect(page.locator('.fp-toolbar')).toContainText('12 candles');
  await expect(page.locator('canvas[aria-label="Footprint chart: order flow inside each candle"]')).toBeVisible();
  await page.screenshot({ path: 'qa/screens/footprint-02-wide.png', fullPage: true });
});

test('footprint loads older candles and shows the row tooltip', async ({ page }, testInfo) => {
  await page.goto('/?tab=footprint&mock=1');
  const canvas = page.locator('canvas[aria-label="Footprint chart: order flow inside each candle"]');
  await expect(page.locator('.fp-toolbar')).toContainText('12 candles');

  if (testInfo.project.name === 'desktop') {
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.45);
    await expect(page.locator('.fp-tooltip')).toBeVisible();
    await expect(page.locator('.fp-tooltip')).toContainText('bid');
  }

  await page.locator('.fp-toolbar').getByRole('button', { name: 'Load older' }).click();
  await expect(page.locator('.fp-toolbar')).toContainText('62 candles');
});
