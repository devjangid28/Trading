import { test, expect, type Page } from '@playwright/test';

// Cold mock stacks (first Vite dep-optimise + the fixture replay server) can take
// a minute to boot; the global 60s budget is too tight for that plus a search.
test.describe.configure({ timeout: 150_000 });

/**
 * Global coin search — the header tool that finds ANY tracked coin, not only
 * the ones currently on the board.
 *
 * Runs against `dev:mock` (fixture replay), because the search itself is
 * deterministic: `/api/search` searches the static universe, so results do not
 * depend on which coins happened to be trending. The live prices attached to
 * hits are covered by `scripts/verify-truth.ts` against the real feed.
 */

async function ready(page: Page): Promise<void> {
  // Cold Vite discovers and pre-bundles deps on the first request and triggers a
  // full page reload; a `domcontentloaded` goto is aborted by that reload with
  // ERR_ABORTED. That first optimize can take ~30s, so retry with patience
  // rather than reading it as a broken server.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      break;
    } catch {
      if (attempt === 9) throw new Error('could not load the page after retries');
      await page.waitForTimeout(4000);
    }
  }
  await expect(page.getByTestId('global-search')).toBeVisible({ timeout: 30_000 });
}

test.describe('global coin search', () => {

  test('is a labelled combobox in the header', async ({ page }) => {
    await ready(page);
    const input = page.getByTestId('global-search');
    await expect(input).toHaveAttribute('role', 'combobox');
    await expect(input).toHaveAttribute('aria-label', /search/i);
    await expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  test('typing a symbol shows the universe match with ticker and name', async ({ page }) => {
    await ready(page);
    await page.getByTestId('global-search').fill('pep');
    await expect(page.getByTestId('search-results')).toBeVisible();
    const pep = page.locator('[data-testid="search-hit"][data-base="PEPE"]');
    await expect(pep).toHaveCount(1);
    await expect(pep).toContainText('PEPE');
    await expect(pep).toContainText('Pepe');
  });

  test('matches a name, not just a ticker', async ({ page }) => {
    await ready(page);
    await page.getByTestId('global-search').fill('bitcoin');
    await expect(page.locator('[data-testid="search-hit"][data-base="BTC"]')).toBeVisible();
  });

  test('keyboard: ArrowDown then Enter picks a hit and closes the panel', async ({ page }) => {
    await ready(page);
    const input = page.getByTestId('global-search');
    await input.fill('sol');
    // Wait for a real hit, not just the (immediately visible) "Searching…" panel,
    // so Enter has something to select rather than racing the debounce.
    await expect(page.getByTestId('search-hit').first()).toBeVisible();
    await input.press('ArrowDown');
    await input.press('Enter');
    await expect(page.getByTestId('search-results')).toHaveCount(0);
    await expect(input).toHaveValue('');
  });

  test('Escape closes the results without picking anything', async ({ page }) => {
    await ready(page);
    const input = page.getByTestId('global-search');
    await input.fill('eth');
    await expect(page.getByTestId('search-results')).toBeVisible();
    await input.press('Escape');
    await expect(page.getByTestId('search-results')).toHaveCount(0);
    await expect(input).toHaveValue('eth');
  });

  test('a nonsense query says so rather than showing a stale hit', async ({ page }) => {
    await ready(page);
    await page.getByTestId('global-search').fill('zzzzzzzz');
    const results = page.getByTestId('search-results');
    await expect(results).toBeVisible();
    await expect(results).toContainText(/no matches/i);
    await expect(page.getByTestId('search-hit')).toHaveCount(0);
  });
});
