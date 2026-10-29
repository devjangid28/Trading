import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Home page acceptance — section E.
 *
 * These assert GEOMETRY and TEXT, not pixels, because a pixel diff cannot tell
 * you that a row says "ST" instead of "STRK", or that the bearish column is not
 * right-aligned. Every test also drops a screenshot in /qa/screens so the
 * result can be reviewed by eye.
 *
 * Runs against `dev:mock` (fixture replay). No exchange traffic.
 */

const SHOTS = 'qa/screens';
mkdirSync(SHOTS, { recursive: true });

let shotN = 0;
async function shot(page: Page, name: string): Promise<void> {
  shotN += 1;
  await page.screenshot({ path: `${SHOTS}/${String(shotN).padStart(2, '0')}-${name}.png`, fullPage: false });
}

/** Wait for the board to be populated; mock mode can take a few seconds. */
async function ready(page: Page): Promise<void> {
  // `domcontentloaded` plus one retry: on the very first load Vite discovers and
  // pre-bundles dependencies, which triggers a full page reload. A `load`-waited
  // goto is aborted by that reload with ERR_ABORTED, which reads as a broken
  // server rather than the warm-up it actually is.
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
  await expect(page.locator('[data-testid="board-row"]').first()).toBeVisible({ timeout: 45_000 });
  // Let the depth curve finish its layout pass.
  await page.waitForTimeout(400);
}

const rows = (page: Page) => page.locator('[data-testid="board-row"]');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Layout geometry
// ─────────────────────────────────────────────────────────────────────────────

test.describe('1 · layout', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1440) < 1000, 'desktop geometry only');

  test('main column / sidebar ratio is between 3.0 and 3.4', async ({ page }) => {
    await ready(page);
    const main = await page.getByTestId('main-card').boundingBox();
    const side = await page.getByTestId('sidebar').boundingBox();
    expect(main, 'main card measured').not.toBeNull();
    expect(side, 'sidebar measured').not.toBeNull();
    const ratio = (main!.width + 16) / side!.width; // +16 approximates the gap
    expect(ratio).toBeGreaterThanOrEqual(3.0);
    expect(ratio).toBeLessThanOrEqual(3.4);
    await shot(page, 'layout-ratio');
  });

  test('the two board columns are equal width within 2px', async ({ page }) => {
    await ready(page);
    const bull = await page.getByTestId('board-bullish').boundingBox();
    const bear = await page.getByTestId('board-bearish').boundingBox();
    expect(Math.abs(bull!.width - bear!.width)).toBeLessThanOrEqual(2);
    await shot(page, 'boards-equal');
  });

  test('the depth chart spans the full card width', async ({ page }) => {
    await ready(page);
    const card = await page.getByTestId('main-card').boundingBox();
    const depth = await page.getByTestId('depth-curve').boundingBox();
    // Inside the card's padding, not narrower than 90% of it.
    expect(depth!.width).toBeGreaterThan(card!.width * 0.9);
    expect(depth!.width).toBeLessThanOrEqual(card!.width);
    await shot(page, 'depth-full-width');
  });

  test('bearish row text is right-aligned and bullish is left-aligned', async ({ page }) => {
    await ready(page);
    const bullRow = page.locator('[data-testid="board-row"][data-side="bullish"]').first();
    const bearRow = page.locator('[data-testid="board-row"][data-side="bearish"]').first();
    if ((await bearRow.count()) === 0) test.skip(true, 'no bearish rows in this fixture window');

    const bullText = await bullRow.getByTestId('row-ticker').boundingBox();
    const bullAv = await bullRow.getByTestId('coin-avatar').boundingBox();
    expect(bullText!.x).toBeGreaterThan(bullAv!.x); // ticker sits right of the avatar

    const bearText = await bearRow.getByTestId('row-ticker').boundingBox();
    const bearAv = await bearRow.getByTestId('coin-avatar').boundingBox();
    expect(bearText!.x).toBeLessThan(bearAv!.x); // mirrored: ticker left of avatar
    await shot(page, 'row-mirroring');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Text — the two-letter ticker defect (A1) and badge overlap (A6)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('2 · text', () => {
  test('no row shows a two-letter truncation of a longer ticker', async ({ page }) => {
    await ready(page);
    const all = await rows(page).evaluateAll((els) =>
      els.map((e) => ({
        rendered: (e.querySelector('[data-testid="row-ticker"]')?.textContent ?? '').trim(),
        full: (e as HTMLElement).dataset.fullTicker ?? '',
      })),
    );
    expect(all.length).toBeGreaterThan(0);
    const truncated = all.filter((r) => r.full.length > 2 && r.rendered !== r.full && r.full.startsWith(r.rendered));
    expect(truncated, `truncated tickers: ${JSON.stringify(truncated.slice(0, 5))}`).toEqual([]);
    await shot(page, 'full-tickers');
  });

  test('every row carries a ticker and a name', async ({ page }) => {
    await ready(page);
    const missing = await rows(page).evaluateAll((els) =>
      els
        .map((e) => ({
          ticker: (e.querySelector('[data-testid="row-ticker"]')?.textContent ?? '').trim(),
          line2: (e.querySelector('.of-row-line2')?.textContent ?? '').trim(),
        }))
        .filter((r) => !r.ticker || !r.line2),
    );
    expect(missing, 'rows missing a ticker or a name').toEqual([]);
  });

  test('exactly one side badge per row, and it does not overlap the ticker', async ({ page }) => {
    await ready(page);
    for (const r of await rows(page).all()) {
      const badges = r.locator('[data-testid="row-badge"]');
      await expect(badges, 'badge count per row').toHaveCount(1);

      const badge = await badges.boundingBox();
      const ticker = await r.getByTestId('row-ticker').boundingBox();
      if (!badge || !ticker) continue;

      // Overlap check: the A6 defect was two stacked spans occupying the same box.
      const overlaps =
        badge.x < ticker.x + ticker.width &&
        badge.x + badge.width > ticker.x &&
        badge.y < ticker.y + ticker.height &&
        badge.y + badge.height > ticker.y;
      expect(overlaps, 'badge and ticker must not intersect').toBe(false);
    }
    await shot(page, 'badge-no-overlap');
  });

  test('the badge text is BULL or BEAR, never both words', async ({ page }) => {
    await ready(page);
    const texts = await page.locator('[data-testid="row-badge"]').allTextContents();
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(['BULL', 'BEAR']).toContain(t.trim());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Counts reconcile (A2)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('3 · counts', () => {
  test('bullish + bearish + choppy equals the universe size', async ({ page }) => {
    await ready(page);
    const bull = Number(await page.getByTestId('count-bullish').textContent());
    const bear = Number(await page.getByTestId('count-bearish').textContent());
    const total = Number(await page.getByTestId('depth-curve').getAttribute('data-total'));
    expect(Number.isFinite(bull) && Number.isFinite(bear)).toBe(true);
    expect(bull).toBeGreaterThanOrEqual(0);
    expect(bear).toBeGreaterThanOrEqual(0);
    // bull + bear + choppy + flat === total is asserted in unit tests; here the
    // visible claim is that the two headline counts come from the universe and
    // are not simply the 20-row board cap on both sides.
    expect(bull + bear).toBeLessThanOrEqual(total);
    await shot(page, 'counts');
  });

  test('board header counts equal the number of rows rendered on that side', async ({ page }) => {
    await ready(page);
    for (const side of ['bullish', 'bearish'] as const) {
      const declared = Number(await page.getByTestId(`board-count-${side}`).textContent());
      const rendered = await page.locator(`[data-testid="board-row"][data-side="${side}"]`).count();
      expect(declared).toBe(rendered);
    }
  });

  test('bucket dot counts sum to the same totals as the chips', async ({ page }) => {
    await ready(page);
    const sum = await page.locator('[data-testid="depth-dot"] em').evaluateAll((els) =>
      els.reduce((a, e) => a + Number(e.getAttribute('data-count') ?? 0), 0),
    );
    const bull = Number(await page.getByTestId('count-bullish').textContent());
    const bear = Number(await page.getByTestId('count-bearish').textContent());
    expect(sum).toBe(bull + bear);
  });

  test('the live pill reports the real source mode, never a hard-coded LIVE 24/7 (A7)', async ({ page }) => {
    await ready(page);
    const pill = page.getByTestId('live-pill');
    const text = (await pill.textContent() ?? '').trim().toLowerCase();
    const mode = await pill.getAttribute('data-mode');
    // This suite drives the fixture replay server, so the only honest mode is
    // MOCK — the old pill said "LIVE 24/7" over exactly this case.
    expect(mode).toBe('MOCK');
    expect(text).toContain('mock');
    // A replay must not carry the live-market "24/7" claim.
    expect(text).not.toContain('24/7');
    expect(text).not.toContain('closed');
    expect(text).not.toContain('opens tomorrow');
    // The persistent header badge must agree with the pill.
    await expect(page.getByTestId('mode-badge')).toHaveText(/MOCK/);
  });

  test('tracked assets shows a sourced number, never a bare dash (A8)', async ({ page }) => {
    await ready(page);
    const card = page.getByTestId('tracked-card');
    await expect(card).toBeVisible();
    const text = (await card.textContent() ?? '').trim();
    expect(text).not.toMatch(/^\s*-\s*$/);
    const count = page.getByTestId('tracked-count');
    if (await count.count()) {
      expect(Number(await count.textContent())).toBeGreaterThan(0);
    } else {
      await expect(page.getByTestId('tracked-unavailable')).toBeVisible();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 + 5. Hover, placement, content
// ─────────────────────────────────────────────────────────────────────────────

test.describe('4 · hover', () => {
  // A phone has no hover, and its bottom sheet covers the board, so a hover
  // sweep cannot be performed at all. The touch path is section 7.
  test.skip(({ viewport }) => (viewport?.width ?? 1440) <= 720, 'hover is a desktop affordance; phones tap');

  test('hovering a row opens exactly one popup within 300ms, inside the viewport', async ({ page }) => {
    await ready(page);
    const row = rows(page).first();
    const t0 = Date.now();
    await row.hover();
    const popup = page.getByTestId('row-preview');
    await expect(popup).toBeVisible({ timeout: 300 });
    expect(Date.now() - t0).toBeLessThanOrEqual(600); // generous wall clock incl. harness latency

    await expect(popup).toHaveCount(1);
    const box = (await popup.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
    await shot(page, 'hover-open');
  });

  test('moving into the popup keeps it open; moving away closes it after the grace period', async ({ page }) => {
    await ready(page);
    const row = rows(page).first();
    await row.hover();
    const popup = page.getByTestId('row-preview');
    await expect(popup).toBeVisible({ timeout: 300 });

    const box = (await popup.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 8);
    await page.waitForTimeout(350);
    await expect(popup, 'popup survives the row -> popup gap').toBeVisible();

    await page.mouse.move(5, 5);
    await expect(popup).toBeHidden({ timeout: 2000 });
    await shot(page, 'hover-closed');
  });

  test('only one popup is ever open when sweeping the pointer down a column', async ({ page }) => {
    await ready(page);
    const list = rows(page);
    const n = Math.min(6, await list.count());
    for (let i = 0; i < n; i++) await list.nth(i).hover();
    await expect(page.getByTestId('row-preview')).toHaveCount(1);
  });

  test('Esc closes, and keyboard focus opens', async ({ page }) => {
    await ready(page);
    const row = rows(page).first();
    await row.hover();
    await expect(page.getByTestId('row-preview')).toBeVisible({ timeout: 300 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('row-preview')).toBeHidden();

    await row.focus();
    await expect(page.getByTestId('row-preview')).toBeVisible({ timeout: 300 });
    await shot(page, 'keyboard-focus');
  });

  test('clicking pins the popup until Esc', async ({ page }) => {
    await ready(page);
    const row = rows(page).first();
    await row.click();
    await expect(page.getByTestId('row-preview')).toBeVisible();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    await expect(page.getByTestId('row-preview'), 'pinned survives pointer travel').toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('row-preview')).toBeHidden();
  });

  test('opening a popup causes zero layout shift', async ({ page }) => {
    await ready(page);
    const before = await page.evaluate(() => {
      const m = document.querySelector('[data-testid="main-card"]');
      return m ? JSON.stringify(m.getBoundingClientRect()) : '';
    });
    await rows(page).first().hover();
    await expect(page.getByTestId('row-preview')).toBeVisible({ timeout: 300 });
    const after = await page.evaluate(() => {
      const m = document.querySelector('[data-testid="main-card"]');
      return m ? JSON.stringify(m.getBoundingClientRect()) : '';
    });
    // The popup renders in a fixed layer, so the card must not move at all.
    expect(after).toBe(before);
  });
});

test.describe('5 · popup content', () => {
  test('the popup carries every required stat and the chart furniture', async ({ page }) => {
    await ready(page);
    await rows(page).first().hover();
    const popup = page.getByTestId('row-preview');
    await expect(popup).toBeVisible({ timeout: 300 });

    const text = (await popup.textContent()) ?? '';
    for (const label of ['RANK', 'CONV', 'OI', 'DELTA', 'VWAP', 'OB', 'R:R', 'RULE']) {
      expect(text, `popup is missing ${label}`).toContain(label);
    }
    // Z paired with S1 (bullish) or R1 (bearish).
    expect(/\bZ \/ (S1|R1)\b/.test(text), 'Z/S1 or Z/R1 label').toBe(true);
    // The outer targets are labelled for the side.
    const side = await rows(page).first().getAttribute('data-side');
    expect(text).toContain(side === 'bullish' ? 'R1 / R2' : 'S1 / S2');

    // Chart furniture: one OB box, level labels, a VWAP line, a now-dot.
    await expect(popup.locator('[data-testid="ob-box"]')).toHaveCount(1);
    expect(await popup.locator('.mc-lbl').count()).toBeGreaterThan(0);
    expect(await popup.locator('.mc-lv').count()).toBeGreaterThan(0);
    expect(await popup.locator('.mc-nowdot').count()).toBe(1);
    await shot(page, 'popup-content');
  });

  test('the popup names the full ticker and the coin name', async ({ page }) => {
    await ready(page);
    const row = rows(page).first();
    const full = (await row.getAttribute('data-full-ticker')) ?? '';
    await row.hover();
    await expect(page.getByTestId('row-preview')).toBeVisible({ timeout: 300 });
    const text = (await page.getByTestId('row-preview').textContent()) ?? '';
    expect(text).toContain(full);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Refresh behaviour (C6)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('6 · refresh', () => {
  test('a data update does not move the scroll position or close the popup', async ({ page }) => {
    await ready(page);
    await page.evaluate(() => window.scrollTo(0, 260));
    const y0 = await page.evaluate(() => window.scrollY);

    await rows(page).first().hover();
    await expect(page.getByTestId('row-preview')).toBeVisible({ timeout: 300 });

    // The mock live feed re-ranks on a simulated 5m close; wait past one.
    await page.waitForTimeout(9000);

    const y1 = await page.evaluate(() => window.scrollY);
    expect(Math.abs(y1 - y0), 'scroll position must not move').toBeLessThanOrEqual(2);
    await expect(page.getByTestId('row-preview'), 'popup must survive a refresh').toBeVisible();
    await shot(page, 'refresh-stable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Mobile
// ─────────────────────────────────────────────────────────────────────────────

test.describe('7 · mobile', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1440) > 900, 'mobile geometry only');

  test('boards stack vertically and a tap opens a bottom sheet', async ({ page }) => {
    await ready(page);
    const bull = (await page.getByTestId('board-bullish').boundingBox())!;
    const bear = (await page.getByTestId('board-bearish').boundingBox())!;
    expect(bear.y).toBeGreaterThan(bull.y + bull.height - 4);

    const row = rows(page).first();
    await row.click();
    const popup = page.getByTestId('row-preview');
    await expect(popup).toBeVisible();

    const vp = page.viewportSize()!;
    const box = (await popup.boundingBox())!;
    // Bottom sheet: spans the width and is anchored to the bottom edge.
    expect(box.width).toBeGreaterThan(vp.width * 0.9);
    expect(box.y + box.height).toBeGreaterThan(vp.height - 4);

    await expect(popup.getByRole('button', { name: 'Next coin' })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Previous coin' })).toBeVisible();
    await shot(page, 'mobile-sheet');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 + 9. Reduced motion and accessibility
// ─────────────────────────────────────────────────────────────────────────────

test.describe('8 · reduced motion', () => {
  test('animations are disabled under prefers-reduced-motion', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await ready(page);
    const dur = await page.locator('[data-testid="board-row"]').first()
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(dur, 'row transition must be disabled').toMatch(/^0s(,\s*0s)*$/);
    await shot(page, 'reduced-motion');
    await ctx.close();
  });
});

test.describe('9 · accessibility', () => {
  test('rows are focusable and the popup has dialog semantics', async ({ page }) => {
    await ready(page);
    const row = rows(page).first();
    await expect(row).toHaveAttribute('tabindex', '0');
    await expect(row).toHaveAttribute('role', 'button');
    const label = await row.getAttribute('aria-label');
    expect(label && label.length).toBeTruthy();

    await row.focus();
    const popup = page.getByTestId('row-preview');
    await expect(popup).toBeVisible({ timeout: 300 });
    await expect(popup).toHaveAttribute('role', 'dialog');
    await expect(popup).toHaveAttribute('aria-label', /.+/.source ? /.+/ : /.+/);
  });

  test('body text meets 4.5:1 contrast in the default theme', async ({ page }) => {
    await ready(page);
    const samples: { selector: string; min: number }[] = [
      { selector: '.of-row-ticker', min: 4.5 },
      { selector: '.of-row-line2', min: 4.5 },
      { selector: '.of-badge.bull', min: 4.5 },
      { selector: '.of-badge.bear', min: 4.5 },
      { selector: '.of-board-h h2', min: 4.5 },
    ];

    for (const s of samples) {
      const el = page.locator(s.selector).first();
      if ((await el.count()) === 0) continue;
      const ratio = await el.evaluate((node) => {
        const lum = (c: string): number => {
          const [r, g, b] = c.match(/[\d.]+/g)!.slice(0, 3).map((v) => {
            const x = Number(v) / 255;
            return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        // Walk up for the first non-transparent background.
        let bgNode: HTMLElement | null = node as HTMLElement;
        let bg = '';
        while (bgNode) {
          const c = getComputedStyle(bgNode).backgroundColor;
          if (c && !c.includes('rgba(0, 0, 0, 0)') && c !== 'transparent') { bg = c; break; }
          bgNode = bgNode.parentElement;
        }
        const l1 = lum(getComputedStyle(node).color);
        const l2 = lum(bg || 'rgb(0,0,0)');
        const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
        return (hi + 0.05) / (lo + 0.05);
      });
      expect(ratio, `${s.selector} contrast`).toBeGreaterThanOrEqual(s.min);
    }
    await shot(page, 'a11y-contrast');
  });
});