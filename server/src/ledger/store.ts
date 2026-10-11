import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER } from '../config.js';
import type {
  LedgerSignal, LedgerStats, Outcome, SignalSnapshot,
} from '../../../shared/types';
import type { Grade } from '../config.js';

// The resolver is pure and lives in its own module so it can be tested without
// dragging node:sqlite into the module graph. Re-exported here for callers.
export { resolveOutcome } from './resolve.js';
export type { ResolveInput, Resolution } from './resolve.js';
import type { Resolution as ResolutionT } from './resolve.js';

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
}

export function openSignals(): OpenSignalRow[] {
  const rows = open()
    .prepare(`SELECT id, symbol, side, entry_low, entry_high, stop, targets,
                     risk_per_unit, created_at
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

const WINS = new Set<Outcome>(['TP1', 'TP2', 'TP3']);

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

/** The realised R of a resolved signal, or null when it is not measurable. */
function rMultipleOf(s: LedgerSignal): number | null {
  if (s.outcome === 'STOP') return -1;
  if (WINS.has(s.outcome)) {
    const r = s.snapshot.plan;
    return r && r.rr > 0 ? r.rr : null;
  }
  if (s.outcome === 'EXPIRED' && s.priceAtResolve !== null) {
    const risk = Math.abs(s.entryZoneHigh - s.stop) || Math.abs(s.entryZoneLow - s.stop) || 1;
    const dir = s.side === 'bullish' ? 1 : -1;
    return (dir * (s.priceAtResolve - s.entryZoneHigh)) / risk;
  }
  return null;
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

  const populated = calibration.filter((b) => b.winRate !== null);
  let isPredictive: boolean | null = null;
  if (populated.length >= 2) {
    const sorted = [...populated].sort((a, b) => a.lo - b.lo);
    const half = Math.floor(sorted.length / 2);
    const bottomAvg = mean(sorted.slice(0, half).map((b) => b.winRate!));
    const topAvg = mean(sorted.slice(-half).map((b) => b.winRate!));
    isPredictive = topAvg > bottomAvg;
  }

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
      ? 'RED: higher conviction scores are NOT winning more than lower ones. The score is not predictive yet. Do not size off it.'
      : isPredictive === true
        ? `Calibration looks monotone across ${populated.length} populated score buckets, on ${n} signals. Still early.`
        : `Not enough populated score buckets to judge calibration yet (${n} signals).`;

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
    byVeto: group((s) => (s.shadow ? s.vetoReason?.slice(0, 44) ?? 'shadow' : 'real')),
    shadowVsReal: group((s) => (s.shadow ? 'shadow' : 'real')),
    byHour: [...hours.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hour, list]) => ({ hour, n: list.length, avgR: r2(mean(list)) })),
    byComponent,
    calibration,
    isPredictive,
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

export { DB_PATH };
