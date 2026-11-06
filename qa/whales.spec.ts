import { expect, test } from '@playwright/test';

test('whales view renders the full spec layout in one viewport', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 900, 'Desktop shell assertions.');

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?tab=whales');

  await expect(page.locator('.whales-view')).toBeVisible();
  await expect(page.locator('.whales-topbar')).toBeVisible();
  await expect(page.locator('.whales-canvas-host canvas')).toBeVisible();
  await expect(page.locator('.whales-insight')).toBeVisible();
  await expect(page.locator('.whales-insight')).toContainText('In view');
  await expect(page.locator('.whales-insight')).toContainText('Context, not a signal.');
  await expect(page.locator('.whales-insight')).toContainText('whales');

  await expect(page.locator('.whales-dock')).toBeVisible();
  await expect(page.locator('.whales-dock__lean')).toBeVisible();
  const leanText = await page.locator('.whales-dock__lean').innerText();
  expect(['WAIT', 'BUY LEAN', 'SELL LEAN']).toContain(leanText.trim());

  await page.locator('.whales-dock__toggle').click();
  await expect(page.locator('.whales-dock.is-open')).toBeVisible();
  await expect(page.locator('.whales-dock__panel')).toContainText('whale net');

  const noScroll = await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1);
  expect(noScroll).toBe(true);

  await page.screenshot({ path: 'qa/screens/whales-01-spec-layout.png', fullPage: false });
  expect(errors).toEqual([]);
});

test('whales legend and detect panels expose the spec toggles', async ({ page }) => {
  await page.goto('/?tab=whales');
  await expect(page.locator('.whales-view')).toBeVisible();

  await expect(page.locator('.whales-toggles button', { hasText: 'Whale avg' })).toBeVisible();
  await expect(page.locator('.whales-toggles button', { hasText: 'Zones' })).toBeVisible();
  await expect(page.locator('.whales-toggles button', { hasText: 'Vol profile' })).toBeVisible();

  await page.locator('.whales-toggle', { hasText: 'Legend' }).click();
  await expect(page.locator('.whales-legend')).toBeVisible();
  await expect(page.locator('.whales-legend')).toContainText('Whale avg lines');
  await expect(page.locator('.whales-legend')).toContainText('Zones');
  await expect(page.locator('.whales-legend')).toContainText('Vol profile strip');
  await expect(page.locator('.whales-legend')).toContainText('Bubble-net panel');
  await expect(page.locator('.whales-legend')).toContainText('Insight strip');
  await page.locator('.whales-legend .whales-popover__head button').click();

  await page.locator('.whales-gearbtn').click();
  await expect(page.locator('.whales-detect')).toBeVisible();
  await expect(page.locator('.whales-detect')).toContainText('Mode');
  await expect(page.locator('.whales-detect')).toContainText('Size ≥');
  await expect(page.locator('.whales-detect')).toContainText('Aggressor');
  await expect(page.locator('.whales-detect')).toContainText('Bubble at');
  await expect(page.locator('.whales-detect')).toContainText('Sweep window');
  await page.locator('.whales-detect .whales-popover__head button').click();

  await page.locator('.whales-helpbtn').click();
  await expect(page.locator('.whales-help')).toBeVisible();
  await expect(page.locator('.whales-help')).toContainText('Sweep');
  await expect(page.locator('.whales-help')).toContainText('bubble net');
});
