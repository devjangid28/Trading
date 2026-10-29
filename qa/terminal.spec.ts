import { expect, test } from '@playwright/test';

test('heatmap is a standalone terminal shell with no nested view tabs', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?tab=heatmap');

  await expect(page.locator('.tradfye-brand')).toBeVisible();
  await expect(page.locator('.tradfye-topbar')).toBeVisible();
  await expect(page.locator('.tradfye-viewbar')).toHaveCount(0);
  await expect(page.locator('.tradfye-tab')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Footprint' })).toHaveCount(0);
  await expect(page.locator('.heatmap-canvas')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(page.locator('.feed-badge')).toContainText('MOCK');
  await expect(page.getByTestId('decision-rail')).toBeVisible();

  await page.goto('/');
  await expect(page.getByTestId('decision-rail')).toBeVisible();
  await page.keyboard.press('p');
  await expect(page.locator('.rail-panel')).toBeVisible();
  await expect(page.locator('.decision-hero')).toContainText('WAIT');
  await page.keyboard.press('p');
  await expect(page.locator('.rail-panel')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('mobile keeps the global decision rail and the separate pages', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=heatmap');
  await expect(page.locator('.terminal-shell')).toBeVisible();
  await expect(page.getByTestId('decision-rail')).toBeVisible();
  await page.getByTestId('decision-rail').locator('.rail-collapsed').click();
  await expect(page.locator('.rail-panel')).toBeVisible();
});
