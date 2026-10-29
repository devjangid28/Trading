import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Order Block page — the reference 1920x1200 stage, rebuilt with crypto data.
 *
 * Asserts GEOMETRY and STRUCTURE, not pixels: the fixed scaled stage and every
 * box of the reference layout (crest, sector chips, ladder, nodes + counts,
 * tiles, bridges, tickets, footer) must be present, the 24h fan must render as
 * the plume, and moving the pointer over a thread must raise its tooltip.
 * Drops screenshots in /qa/screens for eyeball review.
 *
 * Runs against `dev:mock` (fixture replay). No exchange traffic.
 */

const SHOTS = 'qa/screens';
mkdirSync(SHOTS, { recursive: true });

async function openOrderBlock(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      break;
    } catch {
      if (attempt === 1) throw new Error('could not load the page after a retry');
      await page.waitForTimeout(1500);
    }
  }
  await expect(page.getByTestId('live-pill')).toBeVisible({ timeout: 30_000 });
  // The nav sits under a sticky header overlay; a real pointer click can be
  // intercepted by the search box / event chip. Dispatch the click directly.
  await page.getByRole('button', { name: 'Order Block' }).dispatchEvent('click');
  await expect(page.locator('.stage-shell')).toBeVisible({ timeout: 30_000 });
}

test('order-block stage renders the reference layout and the fan plume', async ({ page }) => {
  await openOrderBlock(page);

  // The fixed scaled stage and its crest.
  await expect(page.locator('.st-rail')).toContainText('BLOCK SCAN');
  await expect(page.locator('.st-crest')).toBeVisible();
  await expect(page.locator('.st-crest .share.bull')).toContainText('BULLISH');
  await expect(page.locator('.st-crest .share.bear')).toContainText('BEARISH');

  // Sector chips, ladder and the node row with its counts.
  expect(await page.locator('.st-chip').count()).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.st-ladder')).toBeAttached();
  expect(await page.locator('.st-node').count()).toBeGreaterThanOrEqual(3);
  expect(await page.locator('.st-cnt').count()).toBe(3);

  // The board: tiles flow into bridges into detail tickets.
  await expect(page.locator('.st-tiles .st-tile').first()).toBeVisible({ timeout: 15_000 });
  expect(await page.locator('.st-tiles .st-tile').count()).toBeGreaterThanOrEqual(4);
  expect(await page.locator('.st-bridges .st-bridge').count()).toBeGreaterThanOrEqual(2);
  expect(await page.locator('.st-tickets .st-tick').count()).toBeGreaterThanOrEqual(2);

  await expect(page.locator('.st-footer')).toContainText('not investment advice');

  // The 24h fan is the plume: two canvas layers (threads + particles).
  await expect(page.locator('.st-fan .fan-plot')).toBeVisible();
  expect(await page.locator('.st-fan canvas.fan-cv').count()).toBe(2);

  await page.screenshot({ path: `${SHOTS}/ob-01-layout.png` });
});

test('hovering a thread raises its tooltip', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'thread hit-testing is desktop-scale');

  await openOrderBlock(page);

  const plot = page.locator('.st-fan .fan-plot');
  await expect(plot).toBeVisible();
  const box = await plot.boundingBox();
  if (!box) throw new Error('the fan plot has no bounding box');

  // Sweep a vertical line through the threads; the first one within the grab
  // radius wins and raises the tooltip.
  let hit = false;
  for (let f = 0.05; f <= 0.62 && !hit; f += 0.03) {
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * f);
    await page.waitForTimeout(50);
    hit = (await page.locator('.fan-tip').count()) > 0;
  }
  expect(hit, 'no thread was found along the swept column').toBe(true);
  await expect(page.locator('.fan-tip')).toBeVisible();

  await page.screenshot({ path: `${SHOTS}/ob-02-hover.png` });
});
