import { defineConfig, devices } from '@playwright/test';

/**
 * Home-page acceptance suite.
 *
 * Runs against `npm run dev:mock` â€” fixture replay, no exchange traffic â€” so
 * every assertion is deterministic and the suite never needs credentials.
 *
 * Two web servers are started:
 *   - the mock API on :8899
 *   - vite on :5173, proxying /api to the mock API
 *
 * The mock API needs its own lock and database so the suite cannot block, or be
 * blocked by, a real running server.
 */
export default defineConfig({
  testDir: './qa',
  testMatch: '**/*.spec.ts',
  outputDir: './qa/.artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],

  use: {
    baseURL: 'http://127.0.0.1:5199',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Deterministic clock-independent assertions.
    reducedMotion: 'no-preference',
  },

  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],

  webServer: [
    {
      command: 'node node_modules/tsx/dist/cli.mjs server/scripts/dev-mock.ts',
      url: 'http://127.0.0.1:8899/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: '8899',
        ORDERFLOW_LOCK: 'data/qa.lock',
        ORDERFLOW_DB: 'data/qa.db',
        // The Lab keeps its own database. The QA run must never touch the
        // real one, so it gets its own file and is discarded between runs.
        ORDERFLOW_LAB_DB: 'data/qa-lab.db',
      },
    },
    {
      command: 'node node_modules/vite/bin/vite.js --port 5199 --strictPort',
      url: 'http://127.0.0.1:5199',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ORDERFLOW_API_PORT: '8899' },
    },
  ],
});
