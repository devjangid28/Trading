/**
 * The signal JSON contract — Phase XVI step 8 / section I.
 *
 * Three rules the whole file exists to enforce:
 *
 * 1. **`null`, never `0`, for unknown.** A missing probability displayed as `0%`
 *    reads as "certainly a loss", which is the most dangerous possible reading of
 *    an unknown. An absent position size shows as `null`, never as `0` — a zero
 *    size is a real position decision (do not trade), while null is "we do not
 *    know".
 *
 * 2. **A missing position size must not erase net R.** These are two unrelated
 *    facts. Phase XV found them collapsed into one (`netR` was gated on `qty`),
 *    which meant the engine lost its expectancy figure on every board row.
 *
 * 3. **An unknown probability is never displayed as 0%.** Same reason as (1).
 *
 * The field names are the spec's literal snake_case, so a consumer can rely on
 * them. That is deliberate even though the rest of this codebase is camelCase:
 * this object crosses a contract boundary and the contract is not ours to
 * rename.
 */

import type { AssetRow, FeatureRecord, Grade, TradePlan } from '../../../shared/types.js';
import type { MindSignal } from '../../../shared/types.js';
import { LEDGER, MIND } from '../config.js';
import { valueOf } from './featureStore.js';

export interface SignalContract {
  symbol: string;
  direction: 'long' | 'short';
  setup_type: string;
  entry_zone: number[] | null;
  invalidation: number | null;
  targets: Array<{ label: string; price: number; rr: number }>;
  rr: number | null;
  conviction: number;
  grade: Grade;
  /**
   * Fraction of the account at risk. `null` when no account size has been
   * configured — which is the board's normal state, because the engine refuses to
   * size against an account nobody chose.
   */
  position_size_pct: number | null;
  /**
   * Kelly-derived RISK FRACTION, not a share of the account. Account-independent,
   * so it is available even when `position_size_pct` is null — they are different
   * questions and conflating them is exactly the bug above.
   */
  kelly_risk_fraction: number | null;
  /** Net expectancy after costs. Independent of position size, by design. */
  net_expected_r: number | null;
  /** Probability the nearest target is reached. Null when no probability exists. */
  probability_target1: number | null;
  evidence: {
    historical_sample_size: number;
    similar_setup_win_rate: number | null;
    similar_setup_median_r: number | null;
    regime: string;
    news_ids: string[];
    data_health: Record<string, string> | null;
    feature_schema_version: string;
    engine_version: string;
    calibration_version: string;
  };
  reasoning: {
    structure: string;
    order_flow: string;
    momentum: string;
    positioning: string;
    news: string;
    macro: string;
    tradability: string;
  };
  veto_reason: string;
  /** When this signal stops being valid. Expiry is a real condition, not a guess. */
  valid_until: string | null;
}

/**
 * Similar-setup statistics.
 *
 * `null` unless a real cohort exists AND it clears the floor. A win rate from six
 * comparable signals is not a base rate, and Phase XVI rule 9 forbids presenting
 * a metric below its declared minimum sample size.
 */
export interface SimilarSetupStats {
  n: number;
  winRate: number | null;
  medianR: number | null;
  floor: number;
  /** Why it is null, when it is. */
  reason: string | null;
}

export interface BuildContractInput {
  row: AssetRow;
  plan: TradePlan | null;
  mind: MindSignal | null;
  record: FeatureRecord | null;
  now: number;
  /** Cohort statistics for similar setups, from the calibration layer. */
  similar?: SimilarSetupStats | null;
  /** Which signals produced the reasoning strings, for evidence. */
  newsIds?: readonly string[];
}

/** Minimum comparable setups before a similar-setup rate may be quoted. */
export const SIMILAR_SETUP_FLOOR = 30;

export function buildSignalContract(i: BuildContractInput): SignalContract {
  const { row, plan, mind, record, now } = i;
  const grade = row.conviction?.grade ?? 'NO TRADE';

  const entryZone =
    plan && Number.isFinite(plan.entryLow) && Number.isFinite(plan.entryHigh)
      ? [plan.entryLow, plan.entryHigh]
      : null;

  const invalidation = record ? valueOf(record.invalidation) : (row.setup?.invalidation ?? null);

  const targets = plan
    ? plan.targets.map((t) => ({ label: t.label, price: t.price, rr: t.rr }))
    : [];

  // Net R and probability are INDEPENDENT of position size. Net R comes from the
  // plan's cost-adjusted figure; probability from the Mind verdict. Neither is
  // gated on an account size.
  const netExpectedR =
    mind?.netExpectedR ??
    (plan && typeof plan.netR === 'number' ? plan.netR : null);

  const probability = mind?.probability ?? null;

  const kelly =
    probability !== null && typeof netExpectedR === 'number' && netExpectedR > 0
      ? round4((probability * MIND.KELLY_FRACTION) - ((1 - probability) / netExpectedR) / MIND.KELLY_FRACTION)
      : null;

  const similar = i.similar ?? null;
  const similarCleared = similar !== null && similar.n >= SIMILAR_SETUP_FLOOR;

  const vetoes = row.conviction?.vetoes ?? [];
  const mindVetoes = mind?.vetoes ?? [];

  return {
    symbol: row.pair,
    direction: (row.conviction?.side ?? (row.setup?.side === 'bearish' ? 'bearish' : 'bullish')) === 'bearish'
      ? 'short'
      : 'long',
    setup_type: record?.setupType ?? 'unknown',
    entry_zone: entryZone,
    invalidation: invalidation ?? null,
    targets,
    rr: record ? valueOf(record.rr) : (plan && plan.rr > 0 ? plan.rr : null),
    conviction: row.conviction?.score ?? 0,
    grade,

    // Null, not 0: a zero size is a decision, null is an absence.
    position_size_pct: plan?.riskAmount != null && plan.qty != null && plan.entryMid > 0
      ? round4(((plan.riskAmount / plan.entryMid) * 100) / plan.qty / 100)
      : null,
    kelly_risk_fraction: kelly !== null && Number.isFinite(kelly) ? round4(kelly) : null,
    net_expected_r: netExpectedR,
    probability_target1: probability,

    evidence: {
      historical_sample_size: similar?.n ?? 0,
      similar_setup_win_rate: similarCleared ? similar?.winRate ?? null : null,
      similar_setup_median_r: similarCleared ? similar?.medianR ?? null : null,
      regime: record?.regime ?? 'unknown',
      news_ids: [...(i.newsIds ?? record?.news.newsIds ?? [])],
      data_health: record
        ? {
            price_stream: record.dataHealth.price_stream,
            derivatives: record.dataHealth.derivatives,
            news: record.dataHealth.news,
            macro_blackout: record.dataHealth.macro_blackout,
            tradable: String(record.dataHealth.tradable),
          }
        : null,
      feature_schema_version: record?.featureSchemaVersion ?? 'unknown',
      engine_version: record?.engineVersion ?? 'unknown',
      calibration_version: record?.calibrationVersion ?? 'unknown',
    },

    // Every string says what was MEASURED, including "not measured". A blank
    // reason would be indistinguishable from "nothing to say".
    reasoning: {
      structure: reasonFrom(record !== null && record.htf.contradicts, record
        ? `HTF contradiction: ${record.htf.contradicts ? 'yes' : 'no'}`
        : null),
      order_flow: reasonFrom(
        record !== null && (valueOf(record.cvdUsd) !== null || valueOf(record.aggressiveImbalance) !== null),
        record
          ? `CVD ${fmtVal(valueOf(record.cvdUsd))}, aggressive imbalance ${fmtVal(valueOf(record.aggressiveImbalance))}`
          : null,
      ),
      momentum: reasonFrom(
        record !== null && valueOf(record.volatilityPercentile) !== null,
        record
          ? `volatility percentile ${fmtVal(valueOf(record.volatilityPercentile))}, displacement ${fmtVal(valueOf(record.absorption))}`
          : null,
      ),
      positioning: reasonFrom(
        record !== null && valueOf(record.funding8h) !== null,
        record
          ? `funding(8h) ${fmtVal(valueOf(record.funding8h))}, OI 1h ${fmtVal(valueOf(record.oiChange1h))}`
          : null,
      ),
      news: reasonFrom(
        record !== null && valueOf(record.news.nis) !== null,
        record
          ? `NIS ${fmtVal(valueOf(record.news.nis))}, direction ${fmtVal(valueOf(record.news.direction) as number | null)}, ${record.news.newsIds.length} item(s)`
          : null,
      ),
      macro: reasonFrom(
        record !== null,
        record ? `regime ${record.regime}` : null,
      ),
      tradability: reasonFrom(
        record !== null,
        record
          ? `data health ${record.dataHealth.tradable ? 'tradable' : 'BLOCKED'}${record.dataHealth.degradedStreams.length ? ` (degraded: ${record.dataHealth.degradedStreams.join(', ')})` : ''}`
          : null,
      ),
    },

    // Both sources, joined. An empty string means "no veto", which is a fact; a
    // null would mean "we did not check", which is not true.
    veto_reason: [...vetoes, ...mindVetoes.map((v) => `${v.code}: ${v.reason}`)].join('; '),

    // Expiry is a REAL condition from config, so it is computed rather than
    // guessed. Null only if the caller passed no `now`.
    valid_until: Number.isFinite(now)
      ? new Date(now + LEDGER.EXPIRY_HOURS * 3600_000).toISOString()
      : null,
  };
}

function reasonFrom(measuredIt: boolean, detail: string | null): string {
  if (detail === null) return 'not measured — no frozen feature record';
  return measuredIt ? detail : `${detail} (not all inputs available)`;
}

function fmtVal(v: number | string | null): string {
  if (v === null) return 'n/a';
  if (typeof v === 'string') return v;
  return Number.isInteger(v) ? String(v) : v.toFixed(4);
}

function round4(v: number): number {
  const r = Math.round(v * 10_000) / 10_000;
  return r === 0 ? 0 : r;
}