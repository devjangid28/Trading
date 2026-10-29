import type { AssetRow, Candle, DataHealth, FeatureRecord, SignalSnapshot } from '../../../shared/types';
import { LEDGER, SESSIONS_UTC } from '../config.js';
import { buildFeatureRecord } from '../engine/featureStore.js';
import {
  freezeSignal, markResolved, openSignals, resolveOutcome, saveOutcome, touchChecked, signalCount,
} from './store.js';
import { buildOutcomeRecord } from './outcomes.js';
import { ENGINE_VERSION, FEATURE_SCHEMA_VERSION } from '../version.js';
import { fetchKlines } from '../data/binance.js';

/**
 * The ledger worker.
 *
 * Two jobs:
 *   1. After each scan, freeze a signal for anything worth tracking.
 *   2. After each 5m candle close, resolve open signals.
 *
 * Which coins get recorded is the important decision. Recording only A/B would
 * produce almost nothing, because A/B rarely fires. So:
 *
 *   real   — grade A or B. These are the trades the system would actually take.
 *   shadow — grade C, and EVERY vetoed coin. These are tracked as if taken.
 *
 * The shadow set is a controlled experiment on the vetoes. The 14% event-risk
 * veto fired on LUMIA (+38%) and STRK (+19%) in one session. If those coins
 * kept running, the veto was too strict. If they reversed, it earned its keep.
 * Only the ledger can answer that, and only if those coins are recorded.
 */

export interface FreezeReport {
  frozen: number;
  skippedExisting: number;
  real: number;
  shadow: number;
}

const MAX_FREEZE_PER_SCAN = 12;

/**
 * Assemble the Phase XVI feature record, or `null` if that fails.
 *
 * Never throws out of the freeze path. A builder bug must not be able to stop the
 * ledger recording a signal: the signal is the scarce artefact, the audit trail
 * is reproducible from it.
 */
function safeFeatureRecord(
  row: AssetRow,
  now: number,
  regime: SignalSnapshot['regime'],
  mindRegime: string | undefined,
  health: DataHealth | null = null,
  breadth: string | null = null,
): { featureRecord?: FeatureRecord } | null {
  try {
    const record = buildFeatureRecord({
      row,
      now,
      health,
      // The Mind classifier's six-state label when the pass ran, falling back to
      // the engine's five-state regime. Both are real market state; the string
      // `'unknown'` would only appear if neither existed, and then it is the
      // truth rather than a default.
      regime: mindRegime ?? String(regime),
      sessionFor: sessionForUtcHour,
      // Breadth is a scan-level property, not a per-row one, so it is threaded in
      // via extras rather than invented here.
      breadth,
    });
    return { featureRecord: record };
  } catch (err) {
    console.warn(`[ledger] feature record unavailable for ${row.base}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * UTC hour → session label.
 *
 * Ordered by start and the FIRST match wins, because the windows overlap on
 * purpose (Asia runs 0-8, Europe 7-16, US 13-22): those are the real trading
 * sessions and a candle at 07:30 genuinely belongs to both. Assigning one is a
 * labelling convenience, so the earliest-starting session wins deterministically
 * and a reader can reproduce it.
 */
function sessionForUtcHour(hour: number): string {
  const windows = [
    { name: 'asia', range: SESSIONS_UTC.asia },
    { name: 'europe', range: SESSIONS_UTC.europe },
    { name: 'us', range: SESSIONS_UTC.us },
  ];
  for (const w of windows) {
    if (hour >= w.range[0] && hour < w.range[1]) return w.name;
  }
  return 'off';
}

/**
 * @param regime The market regime the signal was emitted under. **Required**,
 *   and there is deliberately no default.
 *
 *   It used to be read as `(row as any).regime ?? 'range'`. `AssetRow` has no
 *   `regime` field, so that expression was ALWAYS `'range'` for every signal ever
 *   frozen. `ledgerStats().byRegime` therefore returned one bucket that described
 *   nothing, while the docs described it as regime performance. A default here
 *   is worse than a compile error: it manufactures a plausible-looking grouping.
 */
export function freezeFromScan(
  rows: AssetRow[],
  now: number,
  regime: SignalSnapshot['regime'],
  /**
   * Optional extras the row does not carry: the Mind regime label and the
   * data-health verdict at scan time. Both are threaded through so the frozen
   * record holds real market state instead of a placeholder — which is the whole
   * point of freezing it. Absent them the record says `unknown`, which is the
   * truth for a caller that genuinely did not supply them.
   */
  extras: { mindRegime?: string | undefined; health?: DataHealth | null; breadth?: string | null } = {},
): FreezeReport {
  const report: FreezeReport = { frozen: 0, skippedExisting: 0, real: 0, shadow: 0 };

  // Real signals first: A then B.
  const real = [
    ...rows.filter((r) => r.conviction?.grade === 'A'),
    ...rows.filter((r) => r.conviction?.grade === 'B'),
  ];

  // Shadows: grade C, then every vetoed coin (whatever its grade).
  const shadow = [
    ...rows.filter((r) => r.conviction?.grade === 'C'),
    ...rows.filter((r) => (r.conviction?.vetoes.length ?? 0) > 0),
  ];

  // De-duplicate: a vetoed A already appears in `real`.
  const seen = new Set<string>();
  const ordered = [...real, ...shadow].filter((r) => {
    const key = `${r.base}_${r.side}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let budget = MAX_FREEZE_PER_SCAN;
  for (const row of ordered) {
    if (budget <= 0) break;
    const c = row.conviction;
    const plan = row.plan;
    if (!c || !plan || !row.setup) continue;
    if (plan.riskPerUnit <= 0) continue;

    // No real targets means no measurable outcome, so nothing to learn from it.
    const targets = plan.targets.map((t) => t.price).filter((p) => Number.isFinite(p) && p > 0);
    if (!targets.length && !c.vetoes.length) continue;

    const isShadow = !(c.grade === 'A' || c.grade === 'B');
    const snapshot: SignalSnapshot = {
      score: c.score,
      grade: c.grade,
      side: row.side,
      components: c.components,
      checklist: c.checklist,
      // Required, never defaulted. See the signature note: this used to be a
      // `(row as any).regime ?? 'range'` that was always `'range'`, which made
      // `byRegime` a single meaningless bucket for every signal ever frozen.
      regime,
      setup: row.setup,
      plan,
      deriv: row.derivatives,
      sector: row.sector,
      breadth: 'two-way',
      vwap: row.vwap,
      newsNis: row.newsDot?.nis ?? 0,
      newsDirection: row.newsDot?.direction ?? 0,
      vetoes: c.vetoes,
      // The Mind verdict and the frozen feature vector, when the scanner ran the
      // pass. Stored, never recomputed on read: a feature re-derived from later
      // data is a different feature, and that is how a backtest quietly acquires
      // look-ahead.
      //
      // The A/B freeze grades above are deliberately UNCHANGED. The Mind layer
      // reports alongside them and does not decide what gets recorded — changing
      // what the ledger collects before there is calibration data to justify it
      // would destroy the very dataset the layer is being built to gather.
      //
      // Both halves are required. A verdict without its vector would be a
      // number nobody can audit, and a vector without a verdict is just a pile of
      // measurements — so a partial pair is stored as neither.
      ...(row.mind && row.mindFeatures
        ? {
            mind: {
              probability: row.mind.probability,
              netExpectedR: row.mind.netExpectedR,
              regime: row.mind.regime,
              confidenceBand: row.mind.confidenceBand,
              drivers: row.mind.drivers,
              vetoCodes: row.mind.vetoes.map((v) => v.code),
              rank: row.mind.rank,
              features: row.mindFeatures,
            },
          }
        : {}),
      // ── The Phase XVI feature record ──
      // Frozen alongside the vector. `mind.features` is what the scorer read;
      // this is the auditable record of what the engine knew — versions, missing
      // reasons, data-health state, and the setup/asset identity needed to group
      // performance later. Assembled from already-frozen row state and never
      // recomputed, so it cannot disagree with the decision.
      //
      // A builder failure must not stop a signal being recorded: losing the audit
      // trail is bad, losing the observation is worse, because the observation is
      // what the calibration set is made of. So it degrades to no record.
      ...(safeFeatureRecord(row, now, regime, extras.mindRegime, extras.health ?? null, extras.breadth ?? null) ?? {}),
    };

    const id = freezeSignal(
      {
        symbol: row.base,
        side: row.side,
        grade: c.grade,
        score: c.score,
        shadow: isShadow,
        vetoReason: c.vetoes[0] ?? null,
        rule: c.rule,
        entryLow: plan.entryLow,
        entryHigh: plan.entryHigh,
        stop: plan.stop,
        targets,
        riskPerUnit: plan.riskPerUnit,
        snapshot,
      },
      now,
    );

    if (id) {
      report.frozen++;
      budget--;
      if (isShadow) report.shadow++; else report.real++;
    } else {
      report.skippedExisting++;
    }
  }

  return report;
}

export interface ResolveReport {
  checked: number;
  resolved: number;
  outcomes: Record<string, number>;
}

/**
 * Resolve every open signal against the candles since it was created.
 *
 * Re-fetches a bounded window per symbol rather than per signal, so N open
 * signals on the same coin cost one request.
 */
export async function resolveOpenSignals(now = Date.now()): Promise<ResolveReport> {
  const report: ResolveReport = { checked: 0, resolved: 0, outcomes: {} };
  const open = openSignals();
  if (!open.length) return report;

  const bySymbol = new Map<string, typeof open>();
  for (const row of open) {
    const arr = bySymbol.get(row.symbol);
    if (arr) arr.push(row); else bySymbol.set(row.symbol, [row]);
  }

  const earliest = Math.min(...open.map((r) => r.created_at));
  // 5m candles covering the age of the oldest open signal, capped at 1000 rows
  // because the endpoint silently truncates above that.
  const wantedCandles = Math.min(1000, Math.max(120, Math.ceil((now - earliest) / (5 * 60_000)) + 20));

  for (const [symbol, rows] of bySymbol) {
    let candles: Candle[] = [];
    try {
      candles = await fetchKlines(`${symbol}USDT`, '5m', wantedCandles);
    } catch {
      continue;
    }
    const bars = candles.filter((c) => c.closed);

    for (const row of rows) {
      report.checked++;
      const res = resolveOutcome({
        side: row.side,
        entry: (row.entry_low + row.entry_high) / 2,
        stop: row.stop,
        targets: row.targets,
        riskPerUnit: row.risk_per_unit,
        candles: bars.map((c) => ({ h: c.h, l: c.l, c: c.c, t: c.t, o: c.o })),
        createdAt: row.created_at,
        now,
      });

      if (res.outcome === 'OPEN') {
        touchChecked(row.id, now, res.index + 1);
        continue;
      }

      markResolved(row.id, res, now);
      report.resolved++;
      report.outcomes[res.outcome] = (report.outcomes[res.outcome] ?? 0) + 1;

      // ── The Phase XVI outcome row ──
      // Written here, next to the resolution, so the cost breakdown is computed
      // from the same candle set that produced the outcome. Best-effort: a failure
      // here must not roll back a resolution that already happened, so the signal
      // row stands and the outcome row is simply absent — which the reports treat
      // as "no cost-honest record", never as zero cost.
      try {
        const snap = row.snapshot as { plan?: { entryLow?: number; entryHigh?: number } | null; deriv?: { funding8h?: number; depth?: { spreadBps?: number } | null } | null } | null;
        const entry =
          snap?.plan && typeof snap.plan.entryLow === 'number' && typeof snap.plan.entryHigh === 'number'
            ? (snap.plan.entryLow + snap.plan.entryHigh) / 2
            : (row.entry_low + row.entry_high) / 2;
        saveOutcome(
          buildOutcomeRecord({
            signalId: row.id,
            outcome: res.outcome,
            createdAt: row.created_at,
            resolvedAt: now,
            entry,
            stop: row.stop,
            riskPerUnit: row.risk_per_unit,
            side: row.side,
            bars: bars.filter((c) => c.t >= row.created_at),
            priceAtResolve: res.price,
            grossR: res.rMultiple ?? 0,
            mfeR: res.mfeR,
            maeR: res.maeR,
            funding8h: snap?.deriv?.funding8h ?? null,
            spreadBps: snap?.deriv?.depth?.spreadBps ?? null,
            ambiguous: res.ambiguous,
            engineVersion: ENGINE_VERSION,
            featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          }),
        );
      } catch (err) {
        console.warn(
          `[ledger] outcome record failed for ${row.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  return report;
}

let workerTimer: ReturnType<typeof setInterval> | null = null;

/** Start the resolver. Runs every 5 minutes, offset to just after a close. */
export function startLedgerWorker(onLog?: (r: ResolveReport) => void): void {
  if (workerTimer) return;
  const run = () => {
    resolveOpenSignals()
      .then((r) => {
        if (r.resolved > 0) onLog?.(r);
      })
      .catch((err) => console.error('[ledger] resolve failed:', (err as Error).message));
  };
  workerTimer = setInterval(run, 5 * 60_000);
  // Give the first scan a moment to populate before the first resolve.
  setTimeout(run, 20_000);
}

export function stopLedgerWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

export { signalCount, LEDGER };
