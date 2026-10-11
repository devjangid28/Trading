import { describe, it, expect } from 'vitest';
import { forceScan } from '../src/engine/scanner.js';

/**
 * Integration guard against the silent-zero bug.
 *
 * Derivatives were once computed but never fed into the scan context. Two of
 * seven conviction components scored 0 instead of "missing", the board looked
 * completely normal, and grades came out low for the wrong reason. Nothing in
 * the unit tests caught it because each component was individually correct.
 *
 * This test runs a REAL scan against live Binance data and asserts that no
 * component is missing on any coin that produced a trade plan. If a data feed
 * silently stops returning, this fails instead of quietly degrading grades.
 *
 * It is excluded from the default run because it needs network. Run with:
 *   npm run test:integration
 */

const UNIVERSE_MIN = 5;

describe('integration: live scan produces no missing components', () => {
  it(
    'every scored coin has all seven conviction components populated',
    async () => {
      const scan = await forceScan();
      const rows = [...scan.bullish, ...scan.bearish].filter((r) => r.conviction);

      expect(rows.length).toBeGreaterThanOrEqual(UNIVERSE_MIN);

      const withMissing: string[] = [];
      for (const r of rows) {
        const c = r.conviction!;
        if (c.missing.length > 0) {
          withMissing.push(`${r.base}: missing [${c.missing.join(', ')}]`);
        }
      }

      expect(
        withMissing,
        `these coins had missing conviction components, which means a feed silently returned nothing:\n  ${withMissing.join('\n  ')}`,
      ).toEqual([]);
    },
    180_000,
  );

  it(
    'every coin with a trade plan has a derivatives row attached',
    async () => {
      const scan = await forceScan();
      const withPlan = [...scan.bullish, ...scan.bearish].filter((r) => r.plan);
      expect(withPlan.length).toBeGreaterThan(0);

      const missingDeriv = withPlan.filter((r) => r.derivatives === null).map((r) => r.base);
      expect(
        missingDeriv,
        `these coins had a plan but no derivatives row: ${missingDeriv.join(', ')}`,
      ).toEqual([]);
    },
    180_000,
  );

  it(
    'no coin reaches grade A or B while a component is missing',
    async () => {
      const scan = await forceScan();
      const bad = [...scan.bullish, ...scan.bearish].filter(
        (r) => r.conviction && r.conviction.missing.length > 0 &&
          (r.conviction.grade === 'A' || r.conviction.grade === 'B'),
      );
      expect(bad.map((r) => `${r.base}=${r.conviction!.grade}`)).toEqual([]);
    },
    180_000,
  );
});
