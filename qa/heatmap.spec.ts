import { expect, test } from '@playwright/test';

test('heatmap fits the mobile shell and keeps the mock provenance visible', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Mobile composition assertion.');
  await page.goto('/?tab=heatmap');
  const view = page.locator('.heatmap-view');
  await expect(view.locator('.heatmap-canvas')).toBeVisible();
  await expect(view.locator('canvas')).toHaveCount(1);
  await expect(page.locator('.feed-badge')).toContainText('MOCK');
  await expect(view.locator('.chart-reading')).toContainText('Nearest walls');
  await page.screenshot({ path: 'qa/screens/heatmap-02-mobile.png', fullPage: true });
});

test('heatmap renders the reference sparse strip, reading line and mock market', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 900, 'Desktop composition assertions.');

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?tab=heatmap');

  const view = page.locator('.heatmap-view');
  await expect(view).toHaveAttribute('data-mock', 'true');
  await expect(view.locator('.heatmap-canvas')).toBeVisible();
  await expect(view.locator('canvas')).toHaveCount(1);
  await expect(page.locator('.feed-badge')).toContainText('MOCK');

  await expect(view.locator('.chart-reading')).toContainText('Nearest walls');
  await expect(view.locator('.chart-reading')).toContainText('standing 39s');
  await expect(view.locator('.chart-reading')).toContainText('standing 2s');
  await expect(view.locator('.chart-reading')).toContainText(/\d+× pulled nearby/);
  await expect(view.locator('.reading-explainer')).toContainText('Price often stalls at walls');
  await expect(view.getByRole('button', { name: /Columns \(3\)/ })).toBeVisible();

  await view.getByRole('button', { name: /Columns \(3\)/ }).click();
  const checklist = view.locator('.column-checklist');
  await expect(checklist).toContainText('Book');
  await expect(checklist).toContainText('Tape');
  await expect(checklist).toContainText('Delta');
  await page.keyboard.press('Escape');

  await page.screenshot({ path: 'qa/screens/heatmap-01-rework.png', fullPage: true });
  expect(errors).toEqual([]);
});
