import { expect, test } from '@playwright/test';

test('heatmap opens below the app navigation with terminal view tabs', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 900, 'Desktop shell assertions.');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?tab=heatmap');

  await expect(page.locator('.app-tabs')).toBeVisible();
  await expect(page.locator('.app-tabs').getByRole('button', { name: 'Heatmap', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.tradfye-brand')).toBeVisible();
  await expect(page.locator('.tradfye-topbar')).toBeVisible();
  await expect(page.locator('.tradfye-viewbar')).toBeVisible();
  await expect(page.locator('.tradfye-tabs')).toBeVisible();
  await expect(page.locator('.tradfye-tab')).toHaveCount(12);
  await expect(page.locator('.tradfye-tab.is-on')).toContainText('Heatmap');
  await expect(page.getByRole('tablist')).toHaveCount(1);
  await expect(page.locator('.tradfye-view-select')).not.toBeVisible();
  await expect(page.locator('.terminal-view-stats')).toContainText('CVD');
  await expect(page.locator('.heatmap-canvas')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(page.locator('.feed-badge')).toContainText('MOCK');
  await expect(page.getByTestId('decision-rail')).toBeVisible();

  await page.keyboard.press('3');
  await expect(page.locator('.tradfye-tab.is-on')).toContainText('Footprint');
  await page.keyboard.press('0');
  await expect(page.locator('.tradfye-tab.is-on')).toContainText('Sentiment');
  await page.keyboard.press('2');
  await expect(page.locator('.tradfye-tab.is-on')).toContainText('Heatmap');
  await expect(page.locator('.heatmap-canvas')).toBeVisible();
  await page.locator('.tradfye-tab--help').click();
  await expect(page.locator('.tradfye-tab.is-on')).toContainText('Guide');

  const navBox = await page.locator('.app-navbar').boundingBox();
  const shellBox = await page.locator('.terminal-shell').boundingBox();
  expect(navBox).not.toBeNull();
  expect(shellBox).not.toBeNull();
  if (navBox && shellBox) expect(shellBox.y).toBeGreaterThan(navBox.y + navBox.height);

  await page.goto('/');
  await expect(page.getByTestId('decision-rail')).toBeVisible();
  await page.keyboard.press('p');
  await expect(page.locator('.rail-panel')).toBeVisible();
  await expect(page.locator('.decision-hero')).toContainText('WAIT');
  await page.keyboard.press('p');
  await expect(page.locator('.rail-panel')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('footprint opens below the app navigation with terminal view tabs', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 900, 'Desktop shell assertions.');

  await page.goto('/?tab=footprint&mock=1');

  await expect(page.locator('.app-tabs')).toBeVisible();
  await expect(page.locator('.app-tabs').getByRole('button', { name: 'Footprint', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.tradfye-brand')).toBeVisible();
  await expect(page.locator('.tradfye-viewbar')).toBeVisible();
  await expect(page.locator('.tradfye-tabs')).toBeVisible();
  await expect(page.locator('.tradfye-tab')).toHaveCount(12);
  await expect(page.locator('.tradfye-tab.is-on')).toContainText('Footprint');
  await expect(page.getByRole('tablist')).toHaveCount(1);
  await expect(page.locator('.tradfye-view-select')).not.toBeVisible();
  await expect(page.locator('.fp-view')).toBeVisible();
  await expect(page.locator('.fp-canvas-host')).toBeVisible();

  const navBox = await page.locator('.app-navbar').boundingBox();
  const shellBox = await page.locator('.terminal-shell').boundingBox();
  expect(navBox).not.toBeNull();
  expect(shellBox).not.toBeNull();
  if (navBox && shellBox) expect(shellBox.y).toBeGreaterThan(navBox.y + navBox.height);
});

test('mobile keeps the global decision rail and the separate pages', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=heatmap');
  await expect(page.locator('.terminal-shell')).toBeVisible();
  await expect(page.locator('.tradfye-view-select')).toBeVisible();
  await expect(page.locator('.tradfye-tabs')).toHaveCount(1);
  await expect(page.locator('.tradfye-tabs')).not.toBeVisible();
  await expect(page.getByTestId('decision-rail')).toBeVisible();
  await page.getByTestId('decision-rail').locator('.rail-collapsed').click();
  await expect(page.locator('.rail-panel')).toBeVisible();
});
