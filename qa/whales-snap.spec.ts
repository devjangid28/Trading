import { test } from '@playwright/test';

const SHOTS = 'qa/screens/whales-ref';

test('whales reference snapshot set (desktop web only)', async ({ page }) => {
  await page.goto('/?tab=whales');
  await page.waitForTimeout(2800);

  await page.screenshot({ path: `${SHOTS}-01-full-layout.png` });

  await page.locator('.whales-insight').screenshot({ path: `${SHOTS}-02-reading-line.png` });
  await page.locator('.whales-topbar').screenshot({ path: `${SHOTS}-03-toolbar.png` });
  await page.locator('.whales-canvas-host canvas').screenshot({ path: `${SHOTS}-04-canvas.png` });

  await page.locator('.whales-dock__toggle').click();
  await page.waitForTimeout(400);
  await page.locator('.whales-dock').screenshot({ path: `${SHOTS}-05-dock-expanded.png` });
  await page.locator('.whales-dock__toggle').click();
  await page.waitForTimeout(300);
  await page.locator('.whales-dock').screenshot({ path: `${SHOTS}-06-dock-collapsed.png` });

  await page.locator('.whales-toggle', { hasText: 'Legend' }).click();
  await page.locator('.whales-legend').screenshot({ path: `${SHOTS}-07-legend.png` });
  await page.locator('.whales-toggle', { hasText: 'Legend' }).click();

  await page.locator('.whales-gearbtn').click();
  await page.locator('.whales-detect').screenshot({ path: `${SHOTS}-08-settings.png` });
  await page.locator('.whales-gearbtn').click();

  await page.locator('.whales-helpbtn').click();
  await page.locator('.whales-help').screenshot({ path: `${SHOTS}-09-help.png` });
  await page.locator('.whales-helpbtn').click();

  const canvas = page.locator('.whales-canvas-host canvas');
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.4);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}-10-crosshair-tooltip.png` });
  }

  await page.mouse.dblclick(box ? box.x + box.width * 0.5 : 0, box ? box.y + box.height * 0.5 : 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}-11-zoomed.png` });
});
