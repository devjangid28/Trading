import { test, expect } from '@playwright/test';

/** Diagnostic: what is actually on screen in QA mode. */
test('diagnostic', async ({ page }) => {
  page.on('console', (m) => console.log(`[console:${m.type()}] ${m.text().slice(0, 300)}`));
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto('/');
  await page.waitForTimeout(9000);
  console.log('URL:', page.url());
  console.log('title:', await page.title());
  console.log('body text (first 900):', (await page.locator('body').innerText()).slice(0, 900));
  console.log('live-pill count:', await page.getByTestId('live-pill').count());
  console.log('board-row count:', await page.locator('[data-testid="board-row"]').count());
  console.log('main-card count:', await page.getByTestId('main-card').count());
  await page.screenshot({ path: 'qa/screens/diag.png', fullPage: false });
  expect(true).toBe(true);
});