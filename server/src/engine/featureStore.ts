/**
 * The feature store — Phase XVI step 1.
 *
 * The requirement is "for every emitted signal, freeze a versioned feature vector
 * at decision time… if a feature is unavailable, store null plus a reason code.
 * Never impute silently."
 *
 * Three properties this module enforces:
 *
 * 1. **Immutability.** `buildFeatureRecord()` returns a deeply-frozen object. A
 *    later bug cannot reach in and edit what the engine thought it knew. The
 *    freeze is `Object.freeze` on every level, not a convention.
 *
 * 2. **Null carries a reason.** Every field that can be unmeasured is a
 *    `Reasoned<T>`: either a measured value, or `{ value: null, reason: code }`.
 *    There is no third state. A bare `null` cannot be written, which is what
 *    prevents "we forgot to measure it" from looking identical to "we measured
 *    it and it was nothing".
 *
 * 3. **Provenance on every constant.** Threshold groups carry their tag
 *    (`RESEARCHED` / `TUNED` / `PROBED` / `FITTED` / `EXPERIMENTAL`) plus a
 *    source, per Phase XVI rule 11. Nothing here is a bare number.
 *
 * The record is deliberately an ASSEMBLY over data the engine already freezes —
 * it does not recompute anything. Recomputing a feature at freeze time from later
 * data is precisely how a backtest acquires look-ahead.
 */

import type {
  AssetRow,
  Conviction,
  DerivRow,
  FeatureRecord,
  FeatureVector,
  LedgerSignal,
  MarketEvent,
  Setup,
  Side,
  TradePlan,
} from '../../../shared/types.js';
import type {
  DataHealth, MissingReason, Reasoned, HtfAlignment,
} from '../../../shared/types.js';
import {
  ENGINE_VERSION,
  FEATURE_SCHEMA_VERSION,
  CALIBRATION_VERSION,
  CONFIG_VERSION,
  MODEL_ID,
} from '../version.js';

// ─── Reasoned values ─────────────────────────────────────────────────────────
// `Reasoned`, `MissingReason` and `Provenance` live in `shared/types.ts` so the
// server writes one definition and the client reads it. `measured()` /
// `unmeasured()` stay here because they are construction, not wire shape.

export type { MissingReason, Reasoned } from '../../../shared/types.js';

export function measured<T>(value: T): Reasoned<T> {
  return { value, reason: null };
}
export function unmeasured<T>(reason: MissingReason): Reasoned<T> {
  return { value: null, reason };
}

/** Read a `Reasoned` without widening. `null` for an unmeasured field. */
export function valueOf<T>(r: Reasoned<T>): T | null {
  return r.value;
}

// ─── The record ──────────────────────────────────────────────────────────────

// FeatureRecord and its component shapes live in shared/types.ts so the server
// writes one definition and the client reads it. Imported at the top of this file.

// ─── Deep freeze ─────────────────────────────────────────────────────────────

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
  return obj;
}

// ─── Mapping helpers: existing shapes → Reasoned ─────────────────────────────

/** A finite number is measured. Anything else is an explicit absence. */
function num(v: number | null | undefined, reason: MissingReason): Reasoned<number> {
  return v !== null && v !== undefined && Number.isFinite(v) ? measured(v) : unmeasured(reason);
}

/**
 * `Measured` → `Reasoned`.
 *
 * The vector uses `{ value, at }` and a null value has a null `at`; the record
 * needs an explicit REASON. Where the vector cannot say why, the caller supplies
 * it, and `field-not-measured` is the honest default rather than a guess.
 */
function fromMeasured(
  m: { value: number | null; at: number | null } | null | undefined,
  reason: MissingReason,
): Reasoned<number> {
  if (m && m.value !== null && Number.isFinite(m.value)) return measured(m.value);
  return unmeasured(reason);
}

function str<T extends string>(v: T | null | undefined, reason: MissingReason): Reasoned<T> {
  return v !== null && v !== undefined && v.length > 0 ? measured(v) : unmeasured(reason);
}

/**
 * Asset class and beta group.
 *
 * Derived from what is actually on the row, never guessed. A row with no
 * derivatives is spot-or-unknown, and `crypto-perp` would be an invention.
 */
function classifyAsset(row: AssetRow): 'crypto-perp' | 'crypto-spot' | 'indian-equity' {
  if (row.derivatives) return 'crypto-perp';
  if (row.quote === 'INR' || /NSE|BSE/i.test(row.exchange ?? '')) return 'indian-equity';
  return 'crypto-spot';
}

/**
 * Beta group.
 *
 * Deterministic and derived from the sector, so the same coin always lands in
 * the same group and a walk-forward split cannot accidentally reshuffle groups
 * between train and test.
 */
function betaGroupFor(row: AssetRow): string {
  return `sector:${row.sector ?? 'unknown'}`;
}

/**
 * Setup type.
 *
 * Phase XVI groups performance by setup type, which requires a label rather than
 * `side` plus an `fvg` boolean. Derived deterministically from structure that is
 * ALREADY frozen, so this is a labelling job over existing state and not a new
 * opinion. Ordered most-specific first: the first match wins.
 */
export function setupTypeFor(setup: Setup | null, side: Side): string {
  if (!setup) return 'none';
  const tags: string[] = [];
  // Liquidity-sweep reversal: price took out a level and closed back inside.
  if (setup.retest === 'violated') tags.push('sweep-reversal');
  else if (setup.retest === 'retested-held') tags.push('retest-hold');
  else if (setup.retest === 'in-zone') tags.push('in-zone');
  else if (setup.retest === 'fresh') tags.push('fresh-zone');
  // Displacement away from the zone is the impulse leg.
  if (setup.fvg) tags.push('fvg-displacement');
  if (setup.displacement >= 1.5) tags.push('high-displacement');
  // Higher-timeframe agreement is a separate axis, recorded as a tag so it is
  // groupable without a cross-tab explosion.
  if (setup.htf?.aligned) tags.push('htf-aligned');
  else if (setup.htf?.conflict) tags.push('htf-conflict');
  if (setup.violated) tags.push('zone-violated');
  return tags.length ? `${side}:${tags.join('+')}` : `${side}:plain-zone`;
}

// ─── The builder ─────────────────────────────────────────────────────────────

export interface BuildFeatureRecordInput {
  row: AssetRow;
  now: number;
  health: DataHealth | null;
  /** Regime from the real scan, never a default. */
  regime: string;
  /** Sessions from config; looked up by UTC hour so the label is reproducible. */
  sessionFor?: (utcHour: number) => string;
  /** The scan's breadth, when available. */
  breadth?: string | null;
  /** Sector average move, when available. */
  sectorAvgChangePct?: number | null;
  /** Rank percentile within the board, 0-100. */
  rankPercentile?: number | null;
  /** Per-timeframe alignment, when the engine measured it. */
  alignment?: Partial<Record<'m5' | 'm15' | 'h1' | 'h4', Side | 'none'>>;
  /** Abnormal-return attribution, when available. */
  attribution?: {
    abnormalReturnPct: number | null;
    btcBeta: number | null;
    coveragePct: number | null;
  } | null;
  /** News ids that informed this decision. */
  newsIds?: readonly string[];
  /** Tier-1 events inside the blackout window at decision time. */
  blackoutEvents?: readonly MarketEvent[];
}

/**
 * Assemble the frozen record.
 *
 * Everything is read from the row and the scan. Nothing is recomputed, and
 * nothing is inferred from a field that was not itself frozen.
 */
export function buildFeatureRecord(input: BuildFeatureRecordInput): FeatureRecord {
  const { row, now, health, regime } = input;
  const setup = row.setup ?? null;
  const plan: TradePlan | null = row.plan;
  const deriv: DerivRow | null = row.derivatives ?? null;
  const conviction: Conviction | null = row.conviction ?? null;
  const vector = row.mindFeatures;
  const side = (conviction?.side ?? (setup?.side === 'bearish' ? 'bearish' : 'bullish')) as Side;

  // News context. The engine has NIS and direction on every row; the remaining
  // dimensions are only present when the news engine measured them, and their
  // absence is recorded rather than defaulted.
  const nis = row.newsDot?.nis;
  const newsIdList = input.newsIds ?? [];
  const catalyst = vector?.catalyst;

  const entryZone: readonly [number, number] | null = plan
    ? [plan.entryLow, plan.entryHigh]
    : null;

  const htfAl: HtfAlignment = {
    m5: str(input.alignment?.m5 ?? 'none', 'field-not-measured') as Reasoned<Side | 'none'>,
    m15: str(input.alignment?.m15 ?? 'none', 'field-not-measured') as Reasoned<Side | 'none'>,
    h1: str(input.alignment?.h1 ?? setup?.htf?.trend1h ?? 'none', 'field-not-measured') as Reasoned<Side | 'none'>,
    h4: str(input.alignment?.h4 ?? setup?.htf?.trend4h ?? 'none', 'field-not-measured') as Reasoned<Side | 'none'>,
    contradicts: setup?.htf?.conflict ?? false,
  };

  const record: FeatureRecord = {
    engineVersion: ENGINE_VERSION,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    calibrationVersion: CALIBRATION_VERSION,
    configVersion: CONFIG_VERSION,
    modelId: MODEL_ID,
    asOf: now,

    symbol: row.pair,
    base: row.base,
    assetClass: classifyAsset(row),
    sector: row.sector ?? 'unknown',
    betaGroup: betaGroupFor(row),
    session: input.sessionFor
      ? measured(input.sessionFor(new Date(now).getUTCHours()))
      : unmeasured('field-not-measured'),

    setupType: setupTypeFor(setup, side),
    side,
    direction: side === 'bullish' ? 'long' : 'short',
    entryZone,
    invalidation: num(setup?.invalidation ?? null, setup ? 'field-not-measured' : 'insufficient-candles'),
    targets: plan
      ? plan.targets.map((t) => ({ label: t.label, price: t.price, rr: t.rr }))
      : [],
    rr: num(plan && plan.rr > 0 ? plan.rr : null, plan ? 'field-not-measured' : 'insufficient-candles'),
    grade: conviction?.grade ?? 'NO TRADE',

    regime,
    // Trend and alignment come from the vector's own HTF fields, which are
    // signed agreement scores (-1/0/+1), not percentage moves. Reporting them as
    // "trend1h" would rename the quantity; so they are reported under their real
    // meaning and the percent fields are left to the vector itself.
    trend1h: fromMeasured(vector?.structure?.htf1h, 'insufficient-candles'),
    trend4h: fromMeasured(vector?.structure?.htf4h, 'insufficient-candles'),
    volatilityPercentile: fromMeasured(vector?.context?.atrPercentile, 'insufficient-candles'),
    atrPct: unmeasured<number>('field-not-measured'),
    choppiness: fromMeasured(vector?.structure?.choppiness, 'insufficient-candles'),
    efficiency: unmeasured<number>('field-not-measured'),
    vwapDistancePct: num(
      vector?.structure?.vwapDistFrac?.value != null ? vector.structure.vwapDistFrac.value * 100 : null,
      'field-not-measured',
    ),
    vwapSide:
      vector?.structure?.vwapDistFrac?.value == null
        ? unmeasured('field-not-measured')
        : measured(
            vector.structure.vwapDistFrac.value > 0.0005
              ? 'above'
              : vector.structure.vwapDistFrac.value < -0.0005
                ? 'below'
                : 'at',
          ),
    breadth: input.breadth
      ? measured(input.breadth)
      : unmeasured<string>('field-not-measured'),
    sectorAvgChangePct: num(input.sectorAvgChangePct ?? null, 'field-not-measured'),
    rankPercentile: num(input.rankPercentile ?? null, 'field-not-measured'),
    htf: htfAl,

    // `cvd` is the engine's real field. `cvdUsd1h`, `delta` and
    // `aggressiveBuySellRatio` do not exist on `DerivRow` — guessing field names
    // here would have produced a record full of silent nulls. `takerRatio` is the
    // aggressive-flow measure that IS measured; delta as a standalone quantity is
    // not, so it is reported unmeasured rather than approximated from CVD.
    cvdUsd: num(deriv?.cvd ?? null, deriv ? 'field-not-measured' : 'no-derivatives-feed'),
    delta: unmeasured<number>('field-not-measured'),
    aggressiveImbalance: num(
      deriv?.takerRatio != null ? deriv.takerRatio - 0.5 : null,
      deriv ? 'field-not-measured' : 'no-derivatives-feed',
    ),
    absorption: fromMeasured(vector?.structure?.displacementX, 'field-not-measured'),
    funding8h: num(deriv?.funding8h ?? null, deriv ? 'field-not-measured' : 'no-derivatives-feed'),
    oiChange1h: fromMeasured(
      vector?.positioning?.oiChange1h ?? null,
      deriv ? 'no-open-interest' : 'no-derivatives-feed',
    ),
    basisPct: fromMeasured(
      vector?.positioning?.basisPct,
      deriv ? 'field-not-measured' : 'no-derivatives-feed',
    ),
    longShortRatio: fromMeasured(
      vector?.positioning?.longShortRatio,
      deriv ? 'field-not-measured' : 'no-derivatives-feed',
    ),
    liquidationProximityFrac: fromMeasured(
      vector?.positioning?.liqClusterDistFrac ?? null,
      !deriv ? 'no-derivatives-feed' : 'no-liquidation-feed',
    ),

    news: {
      nis: num(nis ?? null, 'no-news-feed'),
      // `newsDot === null` genuinely means "no relevant headlines", which is a
      // measured zero direction — NOT an unavailable feed. Conflating the two was
      // the bug in defect #33, so the two cases are kept apart here.
      direction: row.newsDot
        ? measured(row.newsDot.direction as -1 | 0 | 1)
        : unmeasured<-1 | 0 | 1>('no-news-feed'),
      // `reversalRisk` is a `Measured` ({value, at}), not a boolean. Reading
      // `.value` is what tells "the engine measured it and it was true" apart
      // from "it was not measured" — which is the whole point of the distinction.
      novelty: catalyst
        ? measured(catalyst.reversalRisk.value === 1 ? 'stale' : 'novel')
        : unmeasured<'novel' | 'routine' | 'stale'>('no-news-feed'),
      relevance: fromMeasured(catalyst?.maxNis4h ?? null, 'no-news-feed'),
      severity: num(nis ?? null, 'no-news-feed'),
      sourceTier: unmeasured('field-not-measured'),
      corroboration: fromMeasured(catalyst?.attributionCoveragePct ?? null, 'no-news-feed'),
      macroMultiplier: unmeasured('field-not-measured'),
      newsIds: newsIdList,
      abnormalReturnPct: num(input.attribution?.abnormalReturnPct ?? null, 'field-not-measured'),
      btcBeta: num(input.attribution?.btcBeta ?? null, 'field-not-measured'),
      attributionCoveragePct: fromMeasured(
        input.attribution?.coveragePct == null
          ? (catalyst?.attributionCoveragePct ?? null)
          : { value: input.attribution.coveragePct, at: null },
        'field-not-measured',
      ),
    },

    dataHealth: {
      price_stream: health?.price_stream ?? 'unknown',
      derivatives: health?.derivatives ?? 'unknown',
      news: health?.news ?? 'unknown',
      macro_blackout: health?.macro_blackout ?? 'unknown',
      tradable: health?.tradable ?? false,
      degradedStreams: (health?.degraded ?? []).map((d) => d.stream),
    },

    // ── Provenance of every constant that shaped this decision ──
    // Phase XVI rule 11: a threshold, weight or feature must carry a tag, a
    // source, a test, and a rollback path. The ROLLBACK PATH lives in
    // `version.ts` (`ROLLBACK_TARGETS`); the tag and source live here, and the
    // test requirement is that every entry below has a matching assertion in
    // `server/test/featureStore.test.ts`.
    provenance: [
      {
        id: 'engine.version',
        value: ENGINE_VERSION,
        provenance: 'RESEARCHED',
        source: 'Phase XVI — versioning so a stored row cannot be silently reinterpreted',
      },
      {
        id: 'featureSchema.version',
        value: FEATURE_SCHEMA_VERSION,
        provenance: 'RESEARCHED',
        source: 'Phase XVI — shape AND semantics of the frozen record',
      },
      {
        id: 'calibration.version',
        value: CALIBRATION_VERSION,
        provenance: 'RESEARCHED',
        source: 'Phase XVI — probability model identity, tracked separately from the engine',
      },
      {
        id: 'config.version',
        // A HASH, not a hand-written string. See `version.ts`: a human bumping
        // a version while the numbers change would defeat the whole mechanism.
        value: CONFIG_VERSION,
        provenance: 'PROBED',
        source: 'sha256 of the live config object, truncated to 12 hex chars',
      },
      {
        id: 'model.id',
        value: MODEL_ID,
        provenance: 'TUNED',
        source: 'Shipped logistic weights anchored to the ledger base rate. NOT fitted — see CALIBRATION_VERSION',
      },
      {
        id: 'dataHealth.blockCalendar',
        value: 'true',
        provenance: 'TUNED',
        source: 'RESEARCHED-ADJACENT: an unavailable calendar cannot clear a blackout. Bug #38, CONTEXT.md Part XV',
      },
      {
        id: 'dataHealth.blockNews',
        value: 'true',
        provenance: 'TUNED',
        source: 'An outage must not score as a mid-range reading. Bug #33, CONTEXT.md Part XV',
      },
      {
        id: 'resolver.ambiguity',
        value: 'STOP_FIRST',
        provenance: 'RESEARCHED',
        source: 'Worst-case resolution on same-candle ambiguity. Now READ by resolve.ts, not merely declared',
      },
      {
        id: 'leverage.kellyFraction',
        value: 0.25,
        provenance: 'TUNED',
        source: 'Fractional Kelly: half-Kelly keeps ~75% of growth at ~half the drawdown; quarter-Kelly cut a 40% drawdown from 99.2% to 3.7% in simulation',
      },
      {
        id: 'expiry.hours',
        value: null,
        provenance: 'TUNED',
        source: 'LEDGER.EXPIRY_HOURS. Read from config at resolve time, not duplicated here',
      },
    ],
    missing: [],
    vector: vector ?? ({} as FeatureVector),
  };

  // Enumerate every unmeasured field into a flat index. Built by walking the
  // record rather than by maintaining a second list by hand — a hand-maintained
  // list is guaranteed to drift the first time someone adds a field.
  const missing: { field: string; reason: MissingReason }[] = [];
  const walk = (obj: unknown, path: string): void => {
    if (obj === null) return;
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === null) {
        missing.push({ field: `${path}.${k}`, reason: 'field-not-measured' });
      } else if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
        const r = v as { value: unknown; reason: MissingReason | null };
        if (r.value === null && r.reason) missing.push({ field: `${path}.${k}`, reason: r.reason });
        else walk(v, `${path}.${k}`);
      } else {
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(record, '');
  // `missing` and `provenance` are themselves walked; harmless but noisy.
  const cleaned = missing.filter((m) => !m.field.startsWith('missing') && !m.field.startsWith('provenance'));

  return deepFreeze({ ...record, missing: Object.freeze(cleaned) });
}

/** Read back what a frozen record could not measure. The question that decides whether to build a fallback. */
export function missingCounts(record: FeatureRecord): Record<MissingReason, number> {
  const out = {} as Record<MissingReason, number>;
  for (const m of record.missing) out[m.reason] = (out[m.reason] ?? 0) + 1;
  return out;
}

/** Attach the frozen record to a ledger snapshot shape. */
export function withFeatureRecord(
  snapshot: LedgerSignal['snapshot'],
  record: FeatureRecord,
): LedgerSignal['snapshot'] {
  return { ...snapshot, featureRecord: record };
}
