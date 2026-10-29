import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER } from '../config.js';
import { realisedR, TARGET_WINS } from './resolve.js';
import { testMonotonicity } from './monotonicity.js';
import { vetoKindOf } from '../engine/vetoKind.js';
import type {
  LedgerSignal, LedgerStats, Outcome, SignalSnapshot,
} from '../../../shared/types';
import type { Grade } from '../config.js';

// The resolver is pure and lives in its own module so it can be tested without
// dragging node:sqlite into the module graph. Re-exported here for callers.
export { resolveOutcome } from './resolve.js';
export type { ResolveInput, Resolution } from './resolve.js';
import type { Resolution as ResolutionT } from './resolve.js';
import type { OutcomeRecord } from './outcomes.js';

/**
 * Phase 9 - the signal ledger.
 *
 * This is the component that makes the conviction weights defensible. Until it
 * exists, CONVICTION.WEIGHTS are hand-tuned opinions.
 *
 * Design decisions that matter:
 *
 *  1. SHADOW SIGNALS. Grade C and vetoed coins are recorded too, tracked as if
 *     they had been taken. With only A/B recorded and A/B rarely firing, there
 *     would be almost no data. The shadow set is what answers whether the 14%
 *     event-risk veto was correct: if vetoed coins keep running, the veto is too
 *     strict; if they reverse, it was worth it.
 *
 *  2. MFE AND MAE IN R for every record, not just win/loss. Average R describes
 *     the resolved outcome; MFE/MAE describe the trade you actually held, which
 *     is a different and more useful question.
 *
 *  3. STOP-FIRST on same-candle ambiguity. If one candle's range contains both
 *     the stop and a target we cannot know which came first. Assuming the target
 *     is the optimistic choice and biases the ledger upward.
 *
 *  4. NOTHING HERE TOUCHES THE WEIGHTS. This module records and summarises
 *     only. Fitting is a separate, offline, human-approved step.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Overrideable so tests can use their own database. Without this, store tests
 * write fake "ZZTEST" signals into the production ledger, which then pollutes
 * the calibration statistics with rows that describe no real trade.
 */
const DB_PATH = process.env.ORDERFLOW_DB ?? resolve(__dirname, '../../data/orderflow.db');

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS signals (
      id            TEXT PRIMARY KEY,
      symbol        TEXT NOT NULL,
      side          TEXT NOT NULL,
      grade         TEXT NOT NULL,
      score         REAL NOT NULL,
      shadow        INTEGER NOT NULL DEFAULT 0,
      veto_reason   TEXT,
      rule          TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      entry_low     REAL NOT NULL,
      entry_high    REAL NOT NULL,
      stop          REAL NOT NULL,
      targets       TEXT NOT NULL,
      risk_per_unit REAL NOT NULL,
      snapshot      TEXT NOT NULL,
      outcome       TEXT NOT NULL DEFAULT 'OPEN',
      resolved_at   INTEGER,
      mfe_r         REAL,
      mae_r         REAL,
      price_at_resolve REAL,
      candles_seen  INTEGER NOT NULL DEFAULT 0,
      last_checked  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_signals_open   ON signals(outcome, created_at);
    CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol, created_at);
    CREATE INDEX IF NOT EXISTS idx_signals_shadow ON signals(shadow);

    -- ── The outcome store (Phase XVI step 2) ──
    --
    -- A separate table, not more columns on signals, because the outcome is a
    -- different artefact with a different lifetime: the signal row is written once
    -- and never touched again, while the outcome is written once when it resolves
    -- and carries its own costs, ambiguity policy and versions.
    --
    -- A gross-R column does not exist on signals and still must not: gross R is
    -- recomputed on read from the outcome and the frozen plan, because storing it
    -- would be a second source of truth. THIS table stores it deliberately,
    -- together with the cost breakdown that makes net_r reproducible.
    CREATE TABLE IF NOT EXISTS outcomes (
      signal_id        TEXT PRIMARY KEY,
      outcome          TEXT NOT NULL,
      outcome_class    TEXT NOT NULL,          -- win | loss | censored
      resolved_at      INTEGER NOT NULL,
      bars_to_resolve  INTEGER NOT NULL DEFAULT 0,
      time_to_resolve_min REAL NOT NULL DEFAULT 0,
      price_at_resolve REAL,
      gross_r          REAL NOT NULL,
      net_r            REAL,
      fee_r            REAL NOT NULL DEFAULT 0,
      slippage_r       REAL NOT NULL DEFAULT 0,
      funding_r        REAL NOT NULL DEFAULT 0,
      total_cost_r     REAL NOT NULL DEFAULT 0,
      funding_measured INTEGER NOT NULL DEFAULT 0,  -- 0 = a zero COST, not a zero rate
      mfe_r            REAL NOT NULL DEFAULT 0,
      mae_r            REAL NOT NULL DEFAULT 0,
      ambiguous        INTEGER NOT NULL DEFAULT 0,
      ambiguity_policy TEXT,
      resolution_note  TEXT,
      expired_policy   TEXT,
      engine_version     TEXT,
      feature_schema_version TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outcomes_class ON outcomes(outcome_class);
    CREATE INDEX IF NOT EXISTS idx_outcomes_resolved ON outcomes(resolved_at);

    -- One open signal per symbol+side, so a setup is not re-frozen on every scan.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_open_unique
      ON signals(symbol, side) WHERE outcome = 'OPEN';

    CREATE TABLE IF NOT EXISTS news (
      id           TEXT PRIMARY KEY,
      headline     TEXT NOT NULL,
      source       TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      nis          REAL NOT NULL,
      direction    INTEGER NOT NULL,
      categories   TEXT NOT NULL,
      tags         TEXT NOT NULL,
      assets       TEXT NOT NULL,
      routine      INTEGER NOT NULL DEFAULT 0,
      cluster_id   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_news_pub ON news(published_at);

    CREATE TABLE IF NOT EXISTS news_reactions (
      news_id     TEXT NOT NULL,
      horizon_min INTEGER NOT NULL,
      abnormal_r  REAL,
      measured_at INTEGER,
      PRIMARY KEY (news_id, horizon_min)
    );

    -- Downtime is recorded rather than left implicit. A signal whose candles
    -- were never seen would otherwise silently understate MFE/MAE, and there
    -- would be no way to know which records were affected.
    CREATE TABLE IF NOT EXISTS gaps (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol       TEXT NOT NULL,
      from_ts      INTEGER NOT NULL,
      to_ts        INTEGER NOT NULL,
      minutes      INTEGER NOT NULL,
      detected_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gaps_symbol ON gaps(symbol, detected_at);

    -- Migration: Fix 1 — ban-aware rate limiting.
    --
    -- A restart must never re-hit a banned host, and an in-memory flag cannot
    -- survive a restart. This table is the durable record; the limiter reads it
    -- BEFORE issuing its first request. Added to the existing schema block so
    -- it is a migration of the current DB rather than a second database.
    CREATE TABLE IF NOT EXISTS host_bans (
      host        TEXT PRIMARY KEY,
      banned_until INTEGER NOT NULL,
      source      TEXT NOT NULL,
      raw         TEXT,
      strikes     INTEGER NOT NULL DEFAULT 1,
      updated_at  INTEGER NOT NULL
    );

    -- Migration: Fix 1 — restart-safe candle persistence.
    --
    -- The scanner pulls 5m klines for ~56 symbols every startup. Re-downloading
    -- all of that on every restart is both slow and a large share of the
    -- request weight that produced the original 418. Storing candles means a
    -- restart only fetches what is genuinely missing.
    CREATE TABLE IF NOT EXISTS klines (
      symbol          TEXT NOT NULL,
      interval        TEXT NOT NULL,
      open_time       INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
      v REAL NOT NULL, qv REAL NOT NULL,
      trades          INTEGER NOT NULL DEFAULT 0,
      taker_buy_base  REAL NOT NULL DEFAULT 0,
      taker_buy_quote REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (symbol, interval, open_time)
    );
    CREATE INDEX IF NOT EXISTS idx_klines_lookup ON klines(symbol, interval, open_time DESC);

    -- Migration: Fix 2 — supervised runs.
    --
    -- "Restarts in the last 24h" has to be a measured fact, not a guess. Each
    -- supervised launch appends a row here, so a crash loop is visible in the
    -- data rather than only in a scrollback buffer nobody will read.
    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pid         INTEGER NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      end_reason  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

    -- Migration: coin identity + local logos (home page rebuild, D1-D3).
    --
    -- A ticker truncated to two letters is the single worst thing that can
    -- happen to a board row, and the fix has to survive a restart, so the
    -- resolver's output is cached rather than refetched per render.
    CREATE TABLE IF NOT EXISTS coin_identities (
      base          TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      display_ticker TEXT NOT NULL,
      logo_url      TEXT,
      source        TEXT NOT NULL,
      market_cap    REAL NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_coin_identities_cap ON coin_identities(market_cap DESC);

    CREATE TABLE IF NOT EXISTS coin_logos (
      coin_id   TEXT PRIMARY KEY,
      symbol    TEXT NOT NULL,
      file      TEXT NOT NULL,
      saved_at  INTEGER NOT NULL
    );
  `);
  db = d;
  return d;
}

export function closeLedger(): void {
  db?.close();
  db = null;
}

/** Record a hole in a candle series so downtime is visible, not implicit. */
export function recordGap(symbol: string, fromTs: number, toTs: number, minutes: number): void {
  open().prepare(`
    INSERT INTO gaps (symbol, from_ts, to_ts, minutes, detected_at) VALUES (?,?,?,?,?)
  `).run(symbol, fromTs, toTs, minutes, Date.now());
}

export interface GapRecord {
  symbol: string;
  fromTs: number;
  toTs: number;
  minutes: number;
  detectedAt: number;
}

export function recentGaps(limit = 50): GapRecord[] {
  const rows = open()
    .prepare(`SELECT symbol, from_ts, to_ts, minutes, detected_at FROM gaps ORDER BY detected_at DESC LIMIT ?`)
    .all(limit) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    symbol: String(r.symbol),
    fromTs: Number(r.from_ts),
    toTs: Number(r.to_ts),
    minutes: Number(r.minutes),
    detectedAt: Number(r.detected_at),
  }));
}

export function gapSummary(): { count: number; totalMinutes: number; lastAt: number | null } {
  const d = open();
  const row = d.prepare(`SELECT COUNT(*) c, COALESCE(SUM(minutes),0) m, MAX(detected_at) t FROM gaps`)
    .get() as unknown as { c: number; m: number; t: number | null };
  return { count: Number(row.c), totalMinutes: Number(row.m), lastAt: row.t === null ? null : Number(row.t) };
}


// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface FreezeInput {
  symbol: string;
  side: 'bullish' | 'bearish';
  grade: Grade;
  score: number;
  shadow: boolean;
  vetoReason: string | null;
  rule: string;
  entryLow: number;
  entryHigh: number;
  stop: number;
  targets: number[];
  riskPerUnit: number;
  snapshot: SignalSnapshot;
}

/** Freeze a signal unless one is already open for this symbol+side. */
export function freezeSignal(i: FreezeInput, createdAt = Date.now()): string | null {
  const d = open();
  const existing = d
    .prepare(`SELECT id FROM signals WHERE symbol = ? AND side = ? AND outcome = 'OPEN' LIMIT 1`)
    .get(i.symbol, i.side);
  if (existing) return null;

  const id = `${i.symbol}_${i.side}_${createdAt}`;
  const targets = i.targets.filter((t) => Number.isFinite(t) && t > 0);

  d.prepare(`
    INSERT INTO signals (
      id, symbol, side, grade, score, shadow, veto_reason, rule, created_at,
      entry_low, entry_high, stop, targets, risk_per_unit, snapshot, outcome
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'OPEN')
  `).run(
    id, i.symbol, i.side, i.grade, i.score, i.shadow ? 1 : 0,
    i.vetoReason, i.rule, createdAt,
    i.entryLow, i.entryHigh, i.stop,
    JSON.stringify(targets), i.riskPerUnit, JSON.stringify(i.snapshot),
  );
  return id;
}

export interface OpenSignalRow {
  id: string;
  symbol: string;
  side: 'bullish' | 'bearish';
  entry_low: number;
  entry_high: number;
  stop: number;
  targets: number[];
risk_per_unit: number;
  created_at: number;
  /**
   * The frozen snapshot, so outcome costs use the funding rate and spread that
   * were live AT THE TIME rather than whatever the feed says now. Without it the
   * cost model silently substitutes a missing rate, and a signal frozen in a
   * cheap-funding regime gets charged today's rate instead of the one it faced.
   */
  snapshot: SignalSnapshot | null;
}

/** A malformed snapshot must not stop resolution — costs degrade, resolution does not. */
function safeSnapshot(raw: unknown): SignalSnapshot | null {
  try {
    return JSON.parse(String(raw)) as SignalSnapshot;
  } catch {
    return null;
  }
}

export function openSignals(): OpenSignalRow[] {
  const rows = open()
    .prepare(`SELECT id, symbol, side, entry_low, entry_high, stop, targets,
                     risk_per_unit, created_at, snapshot
              FROM signals WHERE outcome = 'OPEN'`)
    .all() as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    symbol: String(r.symbol),
    side: r.side as 'bullish' | 'bearish',
    entry_low: Number(r.entry_low),
    entry_high: Number(r.entry_high),
    stop: Number(r.stop),
    targets: JSON.parse(String(r.targets)) as number[],
    risk_per_unit: Number(r.risk_per_unit),
    created_at: Number(r.created_at),
    snapshot: safeSnapshot(r.snapshot),
  }));
}

export function markResolved(id: string, res: ResolutionT, now: number): void {
  // Placeholder order: outcome, resolved_at, price_at_resolve, mfe_r, mae_r,
  // last_checked, then id in the WHERE clause. Seven values, seven `?`.
  // `rMultiple` is NOT a column — it is recomputed on read from the outcome
  // and the frozen plan, so storing it here would be a second source of truth.
  open().prepare(`
    UPDATE signals
    SET outcome = ?, resolved_at = ?, price_at_resolve = ?, mfe_r = ?, mae_r = ?,
        last_checked = ?
    WHERE id = ?
  `).run(res.outcome, now, res.price, res.mfeR, res.maeR, now, id);
}

export function touchChecked(id: string, now: number, candlesSeen: number): void {
  open().prepare(`UPDATE signals SET last_checked = ?, candles_seen = ? WHERE id = ?`)
    .run(now, candlesSeen, id);
}

/**
 * Write the Phase XVI outcome row. Idempotent per signal: the first resolution is
 * kept and a later re-check cannot overwrite it.
 *
 * `INSERT OR IGNORE` rather than an upsert on purpose. The resolver is
 * deterministic given the same candles, so a differing second answer means
 * something changed upstream — and silently overwriting the first record would
 * destroy the evidence of that change. The first write wins, as with the signal.
 */
export function saveOutcome(rec: OutcomeRecord): void {
  open().prepare(`
    INSERT OR IGNORE INTO outcomes (
      signal_id, outcome, outcome_class, resolved_at, bars_to_resolve,
      time_to_resolve_min, price_at_resolve, gross_r, net_r, fee_r, slippage_r,
      funding_r, total_cost_r, funding_measured, mfe_r, mae_r, ambiguous,
      ambiguity_policy, resolution_note, expired_policy, engine_version,
      feature_schema_version
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    rec.signalId, rec.outcome, rec.outcomeClass, rec.resolvedAt, rec.barsToResolve,
    rec.timeToResolveMin, rec.priceAtResolve, rec.grossR, rec.netR, rec.feeR,
    rec.slippageR, rec.fundingR, rec.totalCostR, rec.fundingMeasured ? 1 : 0,
    rec.mfeR, rec.maeR, rec.ambiguous ? 1 : 0, rec.ambiguityPolicy,
    rec.resolutionNote, rec.expiredPolicy, rec.engineVersion, rec.featureSchemaVersion,
  );
}

/** Every stored outcome, oldest first. */
export function listOutcomes(limit = 50_000): OutcomeRow[] {
  return (open().prepare(
    `SELECT * FROM outcomes ORDER BY resolved_at ASC LIMIT ?`,
  ).all(limit) as Record<string, unknown>[]).map(outcomeRow);
}

export interface OutcomeRow {
  signalId: string;
  outcome: string;
  outcomeClass: string;
  resolvedAt: number;
  barsToResolve: number;
  timeToResolveMin: number;
  priceAtResolve: number | null;
  grossR: number;
  netR: number | null;
  feeR: number;
  slippageR: number;
  fundingR: number;
  totalCostR: number;
  fundingMeasured: boolean;
  mfeR: number;
  maeR: number;
  ambiguous: boolean;
  ambiguityPolicy: string | null;
  resolutionNote: string | null;
  expiredPolicy: string | null;
  engineVersion: string | null;
  featureSchemaVersion: string | null;
}

function outcomeRow(r: Record<string, unknown>): OutcomeRow {
  return {
    signalId: r.signal_id as string,
    outcome: r.outcome as string,
    outcomeClass: r.outcome_class as string,
    resolvedAt: Number(r.resolved_at),
    barsToResolve: Number(r.bars_to_resolve),
    timeToResolveMin: Number(r.time_to_resolve_min),
    priceAtResolve: r.price_at_resolve === null ? null : Number(r.price_at_resolve),
    grossR: Number(r.gross_r),
    netR: r.net_r === null ? null : Number(r.net_r),
    feeR: Number(r.fee_r),
    slippageR: Number(r.slippage_r),
    fundingR: Number(r.funding_r),
    totalCostR: Number(r.total_cost_r),
    fundingMeasured: Number(r.funding_measured) === 1,
    mfeR: Number(r.mfe_r),
    maeR: Number(r.mae_r),
    ambiguous: Number(r.ambiguous) === 1,
    ambiguityPolicy: (r.ambiguity_policy as string) ?? null,
    resolutionNote: (r.resolution_note as string) ?? null,
    expiredPolicy: (r.expired_policy as string) ?? null,
    engineVersion: (r.engine_version as string) ?? null,
    featureSchemaVersion: (r.feature_schema_version as string) ?? null,
  };
}

export function signalCount(): { total: number; open: number; resolved: number; shadow: number } {
  const d = open();
  const one = (sql: string): number =>
    Number((d.prepare(sql).get() as { c: number }).c);
  const total = one(`SELECT COUNT(*) c FROM signals`);
  return {
    total,
    open: one(`SELECT COUNT(*) c FROM signals WHERE outcome='OPEN'`),
    resolved: total - one(`SELECT COUNT(*) c FROM signals WHERE outcome='OPEN'`),
    shadow: one(`SELECT COUNT(*) c FROM signals WHERE shadow=1`),
  };
}

/**
 * Size of the database on disk, in bytes.
 *
 * With WAL enabled the main file alone understates the footprint, so the
 * sidecar files are added in. Reported by /api/health because an unbounded
 * ledger that silently grows past the disk is the one failure mode here that
 * takes the whole app down rather than degrading a panel.
 */
export function dbSizeBytes(): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += statSync(`${DB_PATH}${suffix}`).size;
    } catch {
      // Sidecar files may not exist yet; the main file is what matters.
    }
  }
  return total;
}

/**
 * Newest candle the resolver has actually looked at, across all open signals.
 *
 * This is the honest "is the ledger keeping up" number. If it is older than a
 * couple of 5m bars, the resolver is stuck even though the process is alive.
 */
export function lastProcessedCandleAt(): number | null {
  const row = open().prepare(
    `SELECT MAX(last_checked) AS at FROM signals WHERE outcome = 'OPEN'`,
  ).get() as { at: number | null };
  return row?.at ?? null;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

// One definition of "a win", exported from the resolver's module so the
// ledger's statistics and the calibration report cannot disagree about it.
const WINS = TARGET_WINS;

interface Row {
  id: string; symbol: string; side: string; grade: string; score: number;
  shadow: number; veto_reason: string | null; rule: string; created_at: number;
  entry_low: number; entry_high: number; stop: number; targets: string;
  risk_per_unit: number; snapshot: string; outcome: Outcome;
  resolved_at: number | null; mfe_r: number | null; mae_r: number | null;
  price_at_resolve: number | null;
}

function toLedgerSignal(r: Row): LedgerSignal {
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side as 'bullish' | 'bearish',
    grade: r.grade as Grade,
    score: r.score,
    createdAt: r.created_at,
    entryZoneLow: r.entry_low,
    entryZoneHigh: r.entry_high,
    stop: r.stop,
    targets: JSON.parse(r.targets) as number[],
    riskPerUnit: r.risk_per_unit,
    snapshot: JSON.parse(r.snapshot) as SignalSnapshot,
    outcome: r.outcome,
    resolvedAt: r.resolved_at,
    mfeR: r.mfe_r,
    maeR: r.mae_r,
    priceAtResolve: r.price_at_resolve,
    shadow: r.shadow === 1,
    vetoReason: r.veto_reason,
    rule: r.rule,
  };
}

export function listSignals(limit = 200, shadow: boolean | 'all' = 'all'): LedgerSignal[] {
  const where = shadow === 'all' ? '' : shadow ? 'WHERE shadow = 1' : 'WHERE shadow = 0';
  const rows = open()
    .prepare(`SELECT * FROM signals ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as unknown as Row[];
  return rows.map(toLedgerSignal);
}

/**
 * The realised R of a resolved signal, or null when it is not measurable.
 *
 * Delegates to `realisedR()` in `./resolve.js` — the M3.2 fix.
 *
 * It used to read `snapshot.plan.rr`, which is the R of the plan's FURTHEST
 * target, so every winner was credited with a level it never reached. The
 * ledger reported `avgR 3.50` and `profitFactor 9.15` on 337 TP1 winners
 * that each banked one R. The R now comes from the target that actually
 * resolved the signal.
 */
function rMultipleOf(s: LedgerSignal): number | null {
  return realisedR(s);
}

/**
 * Statistics with an explicit sample-size floor.
 *
 * Below LEDGER.MIN_SAMPLE_FOR_RATE every rate is null rather than a number. A
 * win rate computed from four signals is not a win rate, and showing one is
 * worse than showing nothing.
 */
export function ledgerStats(shadow: boolean | 'all' = 'all'): LedgerStats {
  const signals = listSignals(10_000, shadow);
  const resolved = signals.filter((s) => s.outcome !== 'OPEN');

  const n = resolved.length;
  const enough = n >= LEDGER.MIN_SAMPLE_FOR_RATE;

  const rr = resolved.map((s) => rMultipleOf(s)).filter((v): v is number => v !== null);
  const wins = resolved.filter((s) => WINS.has(s.outcome));
  const grossWin = rr.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rr.filter((r) => r < 0).reduce((a, b) => a + b, 0));

  const group = (key: (s: LedgerSignal) => string) => {
    const out: Record<string, { n: number; winRate: number | null; avgR: number | null }> = {};
    const buckets = new Map<string, LedgerSignal[]>();
    for (const s of resolved) {
      const k = key(s);
      const arr = buckets.get(k);
      if (arr) arr.push(s);
      else buckets.set(k, [s]);
    }
    for (const [k, list] of buckets) {
      const listEnough = list.length >= LEDGER.MIN_SAMPLE_FOR_RATE;
      const w = list.filter((s) => WINS.has(s.outcome)).length;
      const avg = mean(list.map((s) => rMultipleOf(s)).filter((v): v is number => v !== null));
      out[k] = {
        n: list.length,
        winRate: listEnough ? r2((w / list.length) * 100) : null,
        avgR: listEnough ? r2(avg) : null,
      };
    }
    return out;
  };

  // Calibration: does a higher score actually win more?
  const bucketDefs: [string, number, number][] = [
    ['0-20', 0, 20], ['20-35', 20, 35], ['35-50', 35, 50],
    ['50-65', 50, 65], ['65-80', 65, 80], ['80-100', 80, 100],
  ];
  const calibration = bucketDefs.map(([bucket, lo, hi]) => {
    const list = resolved.filter((s) => s.score >= lo && (hi === 100 ? s.score <= hi : s.score < hi));
    const w = list.filter((s) => WINS.has(s.outcome)).length;
    const listEnough = list.length >= LEDGER.MIN_SAMPLE_FOR_RATE;
    return {
      bucket, lo, hi,
      n: list.length,
      winRate: list.length > 0 && listEnough ? r2((w / list.length) * 100) : null,
    };
  });

  /**
   * Is the score actually predictive? The M1.5 test.
   *
   * This used to be `topAvg > bottomAvg` over the populated buckets: the mean
   * win rate of the bottom half against the mean win rate of the top half.
   * It had no null hypothesis and no interval, so with two populated buckets
   * it was a coin flip — and it reported `isPredictive: true` on a ladder
   * that read 63.41 / 36.14 / 62.30 / 44.19.
   *
   * It is now a rank-correlation test with a bootstrap interval and a
   * permutation p-value, and the verdict is three-state: a ladder whose
   * interval straddles zero is NOT predictive — it is unproven.
   */
  const monotonicity = testMonotonicity(
    calibration.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, winRate: b.winRate === null ? null : b.winRate / 100 })),
    {
      minBucketN: LEDGER.MIN_SAMPLE_FOR_RATE,
      minBuckets: LEDGER.MONOTONICITY_MIN_BUCKETS,
      resamples: LEDGER.MONOTONICITY_BOOTSTRAP,
      permutations: LEDGER.MONOTONICITY_PERMUTATIONS,
      alpha: LEDGER.MONOTONICITY_ALPHA,
      seed: LEDGER.MONOTONICITY_SEED,
    },
  );
  const populated = calibration.filter((b) => b.winRate !== null);
  const isPredictive =
    monotonicity.verdict === 'MONOTONE' ? true : monotonicity.verdict === 'NOT_MONOTONE' ? false : null;

  const hours = new Map<number, number[]>();
  for (const s of resolved) {
    const h = new Date(s.createdAt).getUTCHours();
    const r = rMultipleOf(s);
    if (r === null) continue;
    const arr = hours.get(h) ?? [];
    arr.push(r);
    hours.set(h, arr);
  }

  const componentNames = [
    'structure', 'orderFlow', 'momentum', 'positioning',
    'newsEvents', 'macroRegime', 'tradability',
  ];
  const byComponent = componentNames.map((component) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const s of resolved) {
      const v = (s.snapshot.components as unknown as Record<string, number>)[component];
      const r = rMultipleOf(s);
      if (typeof v === 'number' && Number.isFinite(v) && r !== null) {
        xs.push(v);
        ys.push(r > 0 ? 1 : 0);
      }
    }
    return { component, correlation: correlation(xs, ys), n: xs.length };
  });

  const message = !enough
    ? `Only ${n} resolved signal${n === 1 ? '' : 's'}. Stats are suppressed below ${LEDGER.MIN_SAMPLE_FOR_RATE} samples - a win rate from a handful of trades is noise, not evidence.`
    : isPredictive === false
      ? `RED: higher conviction scores are NOT winning more than lower ones. ${monotonicity.reason}. Do not size off the score.`
      : isPredictive === true
        ? `Calibration is monotone across ${populated.length} populated score buckets, on ${n} signals. ${monotonicity.reason}.`
        : `Calibration is not yet established. ${monotonicity.reason}.`;

  return {
    total: signals.length,
    resolved: n,
    winRate: enough ? r2((wins.length / n) * 100) : null,
    avgR: enough ? r2(mean(rr)) : null,
    expectancy: enough ? r2(mean(rr)) : null,
    profitFactor: enough && grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    byGrade: group((s) => s.grade),
    bySide: group((s) => s.side),
    byRegime: group((s) => s.snapshot.regime),
    /**
     * Grouped by the VETO KIND, not by the rendered reason.
     *
     * The M1.6 fix. The reason string embeds the number that triggered the
     * veto — "already moved 14.2% today — event risk" — so keying on it turned
     * ONE policy decision into 102 categories on this ledger, every one of
     * them below the sample floor where a rate may be quoted. The kind is the
     * rule; the number is the subject.
     */
    byVeto: group((s) => (s.shadow ? vetoKindOf(s.vetoReason) : 'real')),
    shadowVsReal: group((s) => (s.shadow ? 'shadow' : 'real')),
    byHour: [...hours.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hour, list]) => ({ hour, n: list.length, avgR: r2(mean(list)) })),
    byComponent,
    calibration,
    isPredictive,
    monotonicity,
    message,
    sampleFloor: LEDGER.MIN_SAMPLE_FOR_RATE,
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function correlation(xs: number[], ys: number[]): number | null {
  if (xs.length < LEDGER.MIN_SAMPLE_FOR_RATE || xs.length !== ys.length) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  const den = Math.sqrt(vx * vy);
  return den > 0 ? r3(cov / den) : null;
}

function r2(v: number): number { return Math.round(v * 100) / 100; }
function r3(v: number): number { return Math.round(v * 1000) / 1000; }

// ---------------------------------------------------------------------------
// Ban state (Fix 1) — durable so a restart cannot re-hit a banned host
// ---------------------------------------------------------------------------

// Type-only import: erased at compile time, so this creates no runtime cycle
// between the SQLite layer and the pure limiter.
import type { BanRecord } from '../lib/banGuard.js';

export type StoredBan = BanRecord;

export function loadBans(): StoredBan[] {
  const rows = open()
    .prepare(`SELECT host, banned_until, source, raw, strikes, updated_at FROM host_bans`)
    .all() as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    host: String(r.host),
    bannedUntil: Number(r.banned_until),
    source: String(r.source) as BanRecord['source'],
    raw: r.raw === null ? null : String(r.raw),
    strikes: Number(r.strikes),
    updatedAt: Number(r.updated_at),
  }));
}

export function saveBan(b: StoredBan): void {
  open().prepare(`
    INSERT INTO host_bans (host, banned_until, source, raw, strikes, updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(host) DO UPDATE SET
      banned_until = excluded.banned_until,
      source       = excluded.source,
      raw          = excluded.raw,
      strikes      = excluded.strikes,
      updated_at   = excluded.updated_at
  `).run(b.host, b.bannedUntil, b.source, b.raw, b.strikes, b.updatedAt);
}

export function clearBan(host: string): void {
  open().prepare(`DELETE FROM host_bans WHERE host = ?`).run(host);
}

/**
 * Write-then-read round trip against the live database.
 *
 * Used by the startup self-check. A ledger that cannot be written loses every
 * signal without raising anything, which is the single worst failure mode here:
 * the app looks completely healthy and records nothing.
 */
export function dbSelfTest(): { ok: boolean; error?: string } {
  const probe = '__orderflow_selfcheck__';
  try {
    saveBan({ host: probe, bannedUntil: 0, source: 'escalating', raw: 'selfcheck', strikes: 0, updatedAt: Date.now() });
    const rows = loadBans().filter((b) => b.host === probe);
    clearBan(probe);
    if (!rows.length) return { ok: false, error: 'row did not read back' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Record a process-level hole in observation (sleep, crash, long event-loop
 * stall). `gaps.symbol` is NOT NULL, so these use a reserved symbol rather
 * than loosening the column, which keeps the per-symbol gap index valid.
 */
export const PROCESS_GAP_SYMBOL = '__process__';

export function recordProcessGap(
  fromTs: number,
  toTs: number,
  minutes: number,
  reason: string,
): void {
  const d = open();
  d.prepare(`
    INSERT INTO gaps (symbol, from_ts, to_ts, minutes, detected_at) VALUES (?,?,?,?,?)
  `).run(`${PROCESS_GAP_SYMBOL}:${reason}`, fromTs, toTs, minutes, Date.now());
}

/** Process-level gaps only, newest first. */
export function processGaps(limit = 20): (GapRecord & { reason: string })[] {
  const rows = open()
    .prepare(`
      SELECT symbol, from_ts, to_ts, minutes, detected_at FROM gaps
      WHERE symbol LIKE '__process__:%' ORDER BY detected_at DESC LIMIT ?
    `)
    .all(limit) as unknown as Record<string, unknown>[];
  return rows.map((r) => {
    const symbol = String(r.symbol);
    return {
      symbol: PROCESS_GAP_SYMBOL,
      reason: symbol.slice(PROCESS_GAP_SYMBOL.length + 1),
      fromTs: Number(r.from_ts),
      toTs: Number(r.to_ts),
      minutes: Number(r.minutes),
      detectedAt: Number(r.detected_at),
    };
  });
}

/** Gap count and total minutes within a trailing window. */
export function gapSummarySince(sinceMs: number): { count: number; totalMinutes: number } {
  const row = open()
    .prepare(`SELECT COUNT(*) c, COALESCE(SUM(minutes),0) m FROM gaps WHERE detected_at >= ?`)
    .get(sinceMs) as unknown as { c: number; m: number };
  return { count: Number(row.c), totalMinutes: Number(row.m) };
}

// ---------------------------------------------------------------------------
// Supervised runs (Fix 2)
// ---------------------------------------------------------------------------

export function recordRunStart(pid: number, now = Date.now()): number {
  const d = open();
  const res = d.prepare(`INSERT INTO runs (pid, started_at) VALUES (?,?)`).run(pid, now);
  return Number(res.lastInsertRowid ?? 0);
}

export function recordRunEnd(id: number, reason: string, now = Date.now()): void {
  if (!id) return;
  open().prepare(`UPDATE runs SET ended_at = ?, end_reason = ? WHERE id = ?`).run(now, reason, id);
}

/** How many runs started in a trailing window. `includeCurrent` counts this one. */
export function restartsSince(sinceMs: number, includeCurrent = true): number {
  const row = open()
    .prepare(`SELECT COUNT(*) c FROM runs WHERE started_at >= ?`)
    .get(sinceMs) as { c: number };
  const n = Number(row.c);
  return includeCurrent ? n : Math.max(0, n - 1);
}

/** Total minutes of recorded process-level downtime within a trailing window. */
export function downtimeSince(sinceMs: number): number {
  const rows = open()
    .prepare(`SELECT from_ts, to_ts FROM gaps WHERE symbol LIKE '__process__:%' AND detected_at >= ?`)
    .all(sinceMs) as unknown as { from_ts: number; to_ts: number }[];
  return rows.reduce((a, r) => a + Math.max(0, Math.round((r.to_ts - r.from_ts) / 60_000)), 0);
}

// ---------------------------------------------------------------------------
// Coin identity + logos (home page D1-D3)
// ---------------------------------------------------------------------------

/** Directory logos are written to, served at /static/logos. */
export function logoDir(): string {
  return resolve(dirname(DB_PATH), '../data/logos');
}

export function logoPath(fileName: string, ext = '.png'): string {
  return `static/logos/${fileName}${ext.startsWith('.') ? ext : `.${ext}`}`;
}

export interface CoinIdentityRow {
  base: string;
  displayName: string;
  displayTicker: string;
  logoUrl: string | null;
  source: string;
  marketCap: number;
  updatedAt: number;
}

function toIdentity(r: Record<string, unknown>): CoinIdentityRow {
  return {
    base: String(r.base),
    displayName: String(r.display_name),
    displayTicker: String(r.display_ticker),
    logoUrl: r.logo_url === null ? null : String(r.logo_url),
    source: String(r.source),
    marketCap: Number(r.market_cap),
    updatedAt: Number(r.updated_at),
  };
}

export function coinIdentity(base: string): CoinIdentityRow | null {
  const r = open()
    .prepare(`SELECT * FROM coin_identities WHERE base = ?`)
    .get(base.toUpperCase()) as Record<string, unknown> | undefined;
  return r ? toIdentity(r) : null;
}

export function upsertCoinIdentity(i: CoinIdentityRow): void {
  open().prepare(`
    INSERT INTO coin_identities (base, display_name, display_ticker, logo_url, source, market_cap, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(base) DO UPDATE SET
      display_name   = excluded.display_name,
      display_ticker = excluded.display_ticker,
      logo_url       = COALESCE(excluded.logo_url, coin_identities.logo_url),
      source         = excluded.source,
      market_cap     = excluded.market_cap,
      updated_at     = excluded.updated_at
  `).run(i.base.toUpperCase(), i.displayName, i.displayTicker, i.logoUrl, i.source, i.marketCap, i.updatedAt);
}

export function allCoinIdentities(): CoinIdentityRow[] {
  const rows = open()
    .prepare(`SELECT * FROM coin_identities ORDER BY market_cap DESC`)
    .all() as unknown as Record<string, unknown>[];
  return rows.map(toIdentity);
}

export function saveLogoMeta(l: { coinId: string; symbol: string; file: string }): void {
  open().prepare(`
    INSERT INTO coin_logos (coin_id, symbol, file, saved_at) VALUES (?,?,?,?)
    ON CONFLICT(coin_id) DO UPDATE SET symbol = excluded.symbol, file = excluded.file, saved_at = excluded.saved_at
  `).run(l.coinId, l.symbol, l.file, Date.now());
}

export function getLogoMeta(coinId: string): string | null {
  const r = open().prepare(`SELECT file FROM coin_logos WHERE coin_id = ?`).get(coinId) as
    { file: string } | undefined;
  return r?.file ?? null;
}

/** Absolute on-disk location for a stored logo file. */
export function logoFilePath(url: string): string {
  const name = url.replace(/^static\/logos\//, '');
  return resolve(logoDir(), name);
}

/**
 * Fix 2 — what downtime costs, stated as a number.
 *
 * Two very different things happen while the app is off, and only one of them
 * is recoverable:
 *
 *   RECOVERABLE — signals that already existed and hit their stop or target
 *   during the hole. Backfill replays the missed candles through the resolver,
 *   so these resolve correctly, MFE/MAE included.
 *
 *   PERMANENTLY LOST — signals that would have been CREATED during the hole
 *   (any A/B pick, any grade-C shadow, any vetoed coin), and shadow signals for
 *   coins that moved while the app was off. Nothing was watching, so nothing
 *   was recorded. Backfill cannot reconstruct a signal that never had a row.
 *
 * The second figure is the honest denominator for any statistic computed from
 * the ledger: a 70% win rate over 30 signals recorded across 400 minutes of
 * running does not mean what the same 30 signals across 4000 minutes of
 * runtime would mean.
 *
 * Returns the lost minutes since the ledger's first run, so a review can state
 * its real sample coverage rather than implying it is complete.
 */
export function ledgerCoverage(): {
  since: number | null;
  runtimeMinutes: number;
  downtimeMinutes: number;
  coveragePct: number | null;
  recoverable: string;
  lost: string;
} {
  const first = open()
    .prepare(`SELECT MIN(started_at) AS t FROM runs`)
    .get() as { t: number | null };
  const since = first?.t ?? null;
  if (since === null) {
    return {
      since: null, runtimeMinutes: 0, downtimeMinutes: 0, coveragePct: null,
      recoverable: 'No runs recorded yet.',
      lost: 'Unknown until the app has run at least once.',
    };
  }

  const span = Date.now() - since;
  const downtimeMs = downtimeSince(0);
  const downtime = Math.max(0, Math.round(downtimeMs / 60_000));
  const runtime = Math.max(0, Math.round(span / 60_000));
  const coverage = span > 0 ? Math.max(0, Math.min(100, ((span - downtimeMs) / span) * 100)) : null;

  return {
    since,
    runtimeMinutes: runtime,
    downtimeMinutes: downtime,
    coveragePct: coverage === null ? null : Math.round(coverage * 10) / 10,
    recoverable:
      'Signals already open when the app stopped, whose stop or target fired during the hole. ' +
      'Backfill replays the missed candles, so these resolve with correct outcome and MFE/MAE.',
    lost:
      'Signals that would have been CREATED during the hole (A/B picks, grade-C shadows, and every ' +
      'vetoed coin), plus shadow signals for coins that moved while the app was off. These have no row ' +
      'to recover and are permanently absent. Sample coverage must account for them.',
  };
}

// ---------------------------------------------------------------------------
// Candle store (Fix 1 restart safety)
// ---------------------------------------------------------------------------

export interface StoredKlineRow {
  t: number; o: number; h: number; l: number; c: number; v: number; qv: number;
  trades: number; takerBuyBase: number; takerBuyQuote: number;
}

/** Newest stored candle per (symbol, interval) — the resume point. */
export function latestCandleTime(symbol: string, interval: string): number | null {
  const row = open()
    .prepare(`SELECT MAX(open_time) AS t FROM klines WHERE symbol = ? AND interval = ?`)
    .get(symbol, interval) as { t: number | null };
  return row?.t ?? null;
}

export function countStoredCandles(): number {
  const row = open().prepare(`SELECT COUNT(*) c FROM klines`).get() as { c: number };
  return Number(row.c);
}

/** The most recent `limit` stored candles for a series, oldest-first. */
export function readStoredCandles(
  symbol: string,
  interval: string,
  limit: number,
): StoredKlineRow[] {
  const rows = open().prepare(`
    SELECT open_time, o, h, l, c, v, qv, trades, taker_buy_base, taker_buy_quote
    FROM klines WHERE symbol = ? AND interval = ?
    ORDER BY open_time DESC LIMIT ?
  `).all(symbol, interval, limit) as unknown as Record<string, unknown>[];

  return rows
    .map((r) => ({
      t: Number(r.open_time),
      o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c),
      v: Number(r.v), qv: Number(r.qv), trades: Number(r.trades),
      takerBuyBase: Number(r.taker_buy_base),
      takerBuyQuote: Number(r.taker_buy_quote),
    }))
    .reverse();
}

export function storeCandles(
  symbol: string,
  interval: string,
  rows: StoredKlineRow[],
): number {
  if (!rows.length) return 0;
  const d = open();
  const stmt = d.prepare(`
    INSERT INTO klines (symbol, interval, open_time, o, h, l, c, v, qv, trades,
                        taker_buy_base, taker_buy_quote)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(symbol, interval, open_time) DO NOTHING
  `);
  let n = 0;
  // One transaction per batch: a 300-row page is 300 statements otherwise.
  d.exec('BEGIN');
  try {
    for (const r of rows) {
      const res = stmt.run(
        symbol, interval, r.t, r.o, r.h, r.l, r.c, r.v, r.qv,
        r.trades, r.takerBuyBase, r.takerBuyQuote,
      );
      // changes() is 0 on a conflict-ignored insert, which is how we count
      // genuinely new candles rather than re-storing what we already had.
      n += Number(res.changes ?? 0);
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return n;
}

/**
 * Trim the candle store to the most recent `keep` candles per series.
 *
 * Bounded on purpose: an unbounded candle table grows forever and is the one
 * growth path that eventually takes the whole app down. 5m candles are ~288 a
 * day per symbol, so 2000 rows is roughly a week of history.
 */
export function pruneCandles(keep = 2000): number {
  const d = open();
  const series = d.prepare(
    `SELECT DISTINCT symbol, interval FROM klines`,
  ).all() as unknown as { symbol: string; interval: string }[];
  let deleted = 0;
  for (const s of series) {
    deleted += Number(d.prepare(`
      DELETE FROM klines WHERE symbol = ? AND interval = ? AND open_time NOT IN (
        SELECT open_time FROM klines WHERE symbol = ? AND interval = ?
        ORDER BY open_time DESC LIMIT ?
      )
    `).run(s.symbol, s.interval, s.symbol, s.interval, keep).changes ?? 0);
  }
  return deleted;
}

export { DB_PATH };
