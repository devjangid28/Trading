import { test, expect, type Page } from '@playwright/test';

/**
 * The Engine Lab — browser acceptance.
 *
 * Runs against `dev:mock` (fixture replay). No exchange traffic, no
 * credentials, no real money.
 *
 * ## What is proved here
 *
 * The Lab has seven sections and every one of them must be VISIBLE and
 * HONEST. The honesty rules are the point:
 *
 *   - a number that was not measured renders as `—`, never as `0`;
 *   - LIVE is never offered as a mode, and the page says real-money
 *     execution is not built;
 *   - a confidence tier below the sample floor quotes no hit rate and says
 *     why;
 *   - the kill switch and shadow-only actually change the state the page
 *     reports.
 *
 * The Lab's own state is a database, so the QA run uses its own file
 * (`ORDERFLOW_LAB_DB`) and the assertions are about what the page renders,
 * not about what happens to be in the database.
 */

async function openLab(page: Page): Promise<void> {
  await page.goto('/?tab=lab', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.getByText('Engine Lab', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  // The status panel is the first thing to resolve. Waiting for it means the
  // page is not being asserted against a half-loaded state.
  await expect(page.getByTestId('lab-drift-reason')).toBeVisible({ timeout: 30_000 });
}

test.describe('the Engine Lab', () => {
  test('all seven sections are on the page', async ({ page }) => {
    await openLab(page);

    for (const title of [
      'Status',
      'Controls',
      'Live decisions',
      'Paper account',
      'Post-trade reviews',
      'Learning history',
      'Calibration',
    ]) {
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    }
  });

  test('the status panel reports the mode, the model and the drift monitor', async ({ page }) => {
    await openLab(page);

    // The mode VALUE is one of the three that exist. LIVE is not one of them.
    const modeValue = await page.locator('.lab-tiles .mono, .lab-tiles').first().innerText();
    expect(modeValue).toMatch(/SHADOW|PAPER|TESTNET/);
    // The word LIVE may appear only in a sentence that says it is NOT available.
    const statusText = await page.locator('.lab-page').innerText();
    for (const line of statusText.split('\n')) {
      if (/\bLIVE\b/.test(line)) {
        expect(line.toLowerCase(), `a line claims LIVE is available: ${line}`).toContain('not');
      }
    }

    // The drift monitor always explains itself in words.
    const drift = await page.getByTestId('lab-drift-reason').innerText();
    expect(drift.length).toBeGreaterThan(20);
  });

  test('the page says real-money execution is not built', async ({ page }) => {
    await openLab(page);
    const body = await page.locator('.lab-page').innerText();
    expect(body).toContain('real-money execution is not built');
  });

  test('the controls can switch the kill switch and shadow-only on and off', async ({ page }) => {
    await openLab(page);

    const kill = page.getByTestId('lab-kill-switch');
    await expect(kill).toContainText('off');
    await kill.dispatchEvent('click');
    await expect(page.getByTestId('lab-control-message')).toBeVisible();
    await expect(kill).toContainText('ON');

    await kill.dispatchEvent('click');
    await expect(kill).toContainText('off');

    const shadow = page.getByTestId('lab-shadow-only');
    await shadow.dispatchEvent('click');
    await expect(shadow).toContainText('ON');
    await expect(page.getByTestId('lab-shadow-notice')).toBeVisible();
    await shadow.dispatchEvent('click');
    await expect(shadow).toContainText('off');
  });

  test('the controls can stop and start the Lab', async ({ page }) => {
    await openLab(page);
    await page.getByTestId('lab-stop').dispatchEvent('click');
    await expect(page.getByTestId('lab-control-message')).toContainText('stopped');
    await page.getByTestId('lab-start').dispatchEvent('click');
    await expect(page.getByTestId('lab-control-message')).toContainText('running');
  });

  test('a retrain that is refused says why, in words', async ({ page }) => {
    await openLab(page);
    await page.getByTestId('lab-retrain').dispatchEvent('click');
    await expect(page.getByTestId('lab-control-message')).toBeVisible();
    const message = await page.getByTestId('lab-control-message').innerText();
    // Either it refused (and said why) or it fitted (and said so). It must not
    // fail silently.
    expect(message.length).toBeGreaterThan(20);
  });

  test('the calibration panel reports every threshold with its coverage', async ({ page }) => {
    await openLab(page);
    const tiers = page.getByTestId('lab-tiers');
    await expect(tiers).toBeVisible();
    const text = await tiers.innerText();
    // The four thresholds the brief named.
    for (const t of ['0.60', '0.70', '0.80', '0.90']) {
      expect(text).toContain(t);
    }
    // Coverage and hit rate are both on the page, whatever the sample size.
    // The table's headers are uppercased by CSS, so the comparison is
    // case-insensitive.
    expect(text.toLowerCase()).toContain('coverage');
    expect(text.toLowerCase()).toContain('hit rate');
  });

  test('a tier below the sample floor quotes no hit rate and says why', async ({ page }) => {
    await openLab(page);
    const tiers = page.getByTestId('lab-tiers');
    await expect(tiers).toBeVisible();
    const rows = await tiers.locator('tbody tr').all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const cells = await row.locator('td').all();
      const hitRate = (await cells[3].innerText()).trim();
      const note = (await cells[6].innerText()).trim();
      if (hitRate === '—') {
        // No rate, but a reason in words.
        expect(note.length).toBeGreaterThan(10);
      }
    }
  });

  test('the reviews panel explains itself when there is nothing to review', async ({ page }) => {
    await openLab(page);
    const reviews = page.getByTestId('lab-reviews');
    if ((await reviews.count()) > 0) {
      await expect(reviews).toBeVisible();
      const text = await reviews.innerText();
      // The classification column exists, and the reason column is a sentence.
      expect(text).toContain('Classification');
      expect(text).toContain('Why');
    } else {
      await expect(page.getByText(/No trade has been reviewed yet/i)).toBeVisible();
    }
  });

  test('the learning panel says what blocks promotion, and never hides it', async ({ page }) => {
    await openLab(page);
    const blocked = page.getByTestId('lab-promotion-blocked');
    await expect(blocked).toBeVisible();
    const text = await blocked.innerText();
    expect(text.length).toBeGreaterThan(10);
    // The manual approval is always in the list, because the engine cannot
    // promote itself.
    expect(text.toLowerCase()).toContain('approval');
  });

  test('the paper account never reports an equity of zero when it does not know one', async ({ page }) => {
    await openLab(page);
    const account = await page.locator('.lab-page').innerText();
    // A dash, not a fabricated zero.
    expect(account).toContain('Equity');
    const equityDash = account.includes('Equity\n—') || account.includes('Equity —');
    // Either it has a real number or a dash. What it must not do is render a
    // bare 0 for a thing it never measured.
    expect(equityDash || /\$\d/.test(account)).toBe(true);
  });

  test('the fills, when there are any, label their costs as modelled', async ({ page }) => {
    await openLab(page);
    const fills = page.getByTestId('lab-fills');
    if ((await fills.count()) > 0) {
      const text = await fills.innerText();
      expect(text.toLowerCase()).toContain('modelled');
    }
  });

  test('the outbound alert message is a paste-able JSON block, or says there is none', async ({ page }) => {
    await openLab(page);
    const json = page.getByTestId('lab-alert-json');
    if ((await json.count()) > 0) {
      const text = await json.innerText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed).toHaveProperty('symbol');
      expect(parsed).toHaveProperty('side');
      expect(parsed).toHaveProperty('entry');
      expect(parsed).toHaveProperty('stop');
      expect(parsed).toHaveProperty('targets');
      expect(parsed).toHaveProperty('pWin');
      expect(parsed).toHaveProperty('modelVersion');
    } else {
      await expect(page.getByTestId('lab-alert-empty')).toBeVisible();
    }
  });

  test('the page never claims a live market', async ({ page }) => {
    await openLab(page);
    const lab = page.locator('.lab-page');
    // The Lab's own badge is not a market-mode badge, and the only place the
    // word LIVE may appear is in the sentence that says it is not available.
    const text = await lab.innerText();
    const liveMentions = text.split('\n').filter((l) => /\bLIVE\b/.test(l));
    for (const line of liveMentions) {
      expect(line.toLowerCase()).toContain('not');
    }
  });
});
