/**
 * The Engine Lab's own store.
 *
 * ## Why this is a SEPARATE database
 *
 * The signal ledger is evidence about the ENGINE: what it decided, what it saw
 * and what happened. The Lab's store is evidence about the LEARNING LOOP: which
 * model was champion, which trades were reviewed, what the account did.
 *
 * Keeping them apart means a Lab experiment can never be mistaken for a
 * ledger signal, and a corrupt Lab table can never take the signal ledger with
 * it. The two are joined by `signal_id` and nothing else.
 *
 * ## The reviews are EVIDENCE, not state
 *
 * `lab_reviews` rows are written once and never edited by the learning loop.
 * They are the record of what happened, and the retrainer reads them. A review
 * that could be edited by the thing that reads it would not be evidence.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  LabFailureClass,
  LabFill,
  LabModelVersion,
  LabReview,
  LabTierRow,
  LabReliabilityRow,
  LabFoldRow,
} from '../../../../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Where the Lab's database lives.
 *
 * Read at OPEN time, not at import time, so a test can point the Lab at a
 * throwaway database by setting `ORDERFLOW_LAB_DB` before the first call.
 */
export function labDbPath(): string {
  return process.env.ORDERFLOW_LAB_DB ?? resolve(__dirname, '../../../data/lab.db');
}

/** The Lab database's path, for a message that names it. */
export const LAB_DB_PATH = labDbPath();

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  const path = labDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const d = new DatabaseSync(path);
  d.exec(`
    PRAGMA journal_mode = WAL;

    -- The Lab's knobs: mode, kill switch, shadow-only, running.
    CREATE TABLE IF NOT EXISTS lab_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- A model version. Weights travel with it, so a version IS an artefact.
    CREATE TABLE IF NOT EXISTS lab_models (
      version            TEXT PRIMARY KEY,
      role               TEXT NOT NULL,
      created_at         INTEGER NOT NULL,
      trained_at         INTEGER,
      trained_on_trades  INTEGER,
      feature_schema     TEXT NOT NULL,
      fit                TEXT NOT NULL,
      model              TEXT NOT NULL,
      oos_expectancy_r   REAL,
      oos_brier          REAL,
      oos_log_loss       REAL,
      oos_trades         INTEGER,
      verdict            TEXT
    );

    -- Every promotion, rejection, rollback and retrain, with its reason.
    CREATE TABLE IF NOT EXISTS lab_model_decisions (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      at                     INTEGER NOT NULL,
      version                TEXT NOT NULL,
      kind                   TEXT NOT NULL,
      reason                 TEXT NOT NULL,
      champion_expectancy_r  REAL,
      challenger_expectancy_r REAL,
      champion_brier         REAL,
      challenger_brier       REAL
    );

    -- A position the Lab's broker holds.
    CREATE TABLE IF NOT EXISTS lab_positions (
      id              TEXT PRIMARY KEY,
      signal_id       TEXT NOT NULL,
      symbol          TEXT NOT NULL,
      side            TEXT NOT NULL,
      sector          TEXT,
      opened_at       INTEGER NOT NULL,
      filled_at       INTEGER,
      reference_entry REAL,
      entry_price     REAL,
      qty             REAL NOT NULL,
      risk_per_unit   REAL NOT NULL,
      risk_usd        REAL NOT NULL,
      stop            REAL NOT NULL,
      targets         TEXT NOT NULL,
      p_win           REAL,
      expected_net_r  REAL,
      venue           TEXT NOT NULL,
      status          TEXT NOT NULL,
      closed_at       INTEGER,
      close_reason    TEXT,
      reference_exit  REAL,
      exit_price      REAL,
      gross_r         REAL,
      net_r           REAL,
      cost_r          REAL,
      fee_usd         REAL,
      slippage_usd    REAL,
      funding_usd     REAL,
      ambiguous       INTEGER NOT NULL DEFAULT 0,
      feature_snapshot TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lab_positions_status ON lab_positions(status);

    -- The equity curve, one row per closed trade.
    CREATE TABLE IF NOT EXISTS lab_equity (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      at               INTEGER NOT NULL,
      equity_usd       REAL NOT NULL,
      net_r            REAL NOT NULL,
      realised_pnl_usd REAL NOT NULL
    );

    -- Post-trade reviews. Written once, never edited by the learning loop.
    CREATE TABLE IF NOT EXISTS lab_reviews (
      id                TEXT PRIMARY KEY,
      signal_id         TEXT NOT NULL,
      position_id       TEXT,
      symbol            TEXT NOT NULL,
      side              TEXT NOT NULL,
      opened_at         INTEGER NOT NULL,
      closed_at         INTEGER NOT NULL,
      predicted_p_win   REAL,
      outcome           INTEGER,
      outcome_label     TEXT NOT NULL,
      gross_r           REAL,
      net_r             REAL,
      cost_r            REAL,
      failure_class     TEXT NOT NULL,
      failure_note      TEXT NOT NULL,
      no_fault          INTEGER NOT NULL DEFAULT 0,
      feature_snapshot  TEXT,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lab_reviews_closed ON lab_reviews(closed_at DESC);

    -- Every fill, with the modelled costs labelled.
    CREATE TABLE IF NOT EXISTS lab_fills (
      id            TEXT PRIMARY KEY,
      at            INTEGER NOT NULL,
      position_id   TEXT NOT NULL,
      symbol        TEXT NOT NULL,
      side          TEXT NOT NULL,
      price         REAL NOT NULL,
      qty           REAL NOT NULL,
      fee_usd       REAL NOT NULL,
      slippage_usd  REAL NOT NULL,
      venue         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lab_fills_at ON lab_fills(at DESC);
  `);
  db = d;
  return d;
}

/** Close the Lab's database. Used by tests and by the shutdown path. */
export function closeLab(): void {
  db?.close();
  db = null;
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** Read one setting, or `fallback` when it has never been written. */
export function labSetting(key: string, fallback: string): string {
  const row = open().prepare('SELECT value FROM lab_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

/** Write one setting. */
export function setLabSetting(key: string, value: string): void {
  open()
    .prepare('INSERT INTO lab_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/** All the settings, as a plain object. */
export function labSettings(): Record<string, string> {
  const rows = open().prepare('SELECT key, value FROM lab_settings').all() as Array<{ key: string; value: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// ─── The Lab's knobs ─────────────────────────────────────────────────────────
//
// These live here, next to the table they are stored in, so there is exactly
// one definition of each key and one place that knows how to read it.

/** The settings keys. */
export const SETTING_KEYS = {
  mode: 'mode',
  running: 'running',
  killSwitch: 'killSwitch',
  shadowOnly: 'shadowOnly',
  equityUsd: 'equityUsd',
  lastRetrainAt: 'lastRetrainAt',
} as const;

/** The Lab's execution mode. LIVE is not a member: it is not available. */
export function labMode(): 'SHADOW' | 'PAPER' | 'TESTNET' {
  const raw = labSetting(SETTING_KEYS.mode, 'SHADOW');
  return raw === 'PAPER' || raw === 'TESTNET' ? raw : 'SHADOW';
}

/** Is the Lab running? */
export function labRunning(): boolean {
  return labSetting(SETTING_KEYS.running, 'true') === 'true';
}

/** The kill switch. True means nothing is opened, in any mode. */
export function labKillSwitch(): boolean {
  return labSetting(SETTING_KEYS.killSwitch, 'false') === 'true';
}

/** Shadow-only mode: decisions are recorded, nothing is executed. */
export function labShadowOnly(): boolean {
  return labSetting(SETTING_KEYS.shadowOnly, 'false') === 'true';
}

/** The paper account's equity, in USD. */
export function labEquity(defaultUsd: number): number {
  const raw = Number(labSetting(SETTING_KEYS.equityUsd, String(defaultUsd)));
  return Number.isFinite(raw) && raw > 0 ? raw : defaultUsd;
}

/** Write one of the knobs. */
export function setLabSettingValue(key: string, value: string): void {
  setLabSetting(key, value);
}

// ─── Models ──────────────────────────────────────────────────────────────────

export interface StoredModel extends LabModelVersion {
  /** The fitted weights, as JSON. Null for a model that was never fitted. */
  model: unknown;
}

/** Save a model version. */
export function saveModel(m: {
  version: string;
  role: 'CHAMPION' | 'CHALLENGER' | 'RETIRED';
  createdAt: number;
  trainedAt: number | null;
  trainedOnTrades: number | null;
  featureSchema: string;
  fit: unknown;
  model: unknown;
  oosExpectancyR: number | null;
  oosBrier: number | null;
  oosLogLoss: number | null;
  oosTrades: number | null;
  verdict: string | null;
}): void {
  open()
    .prepare(
      `INSERT INTO lab_models
         (version, role, created_at, trained_at, trained_on_trades, feature_schema, fit, model,
          oos_expectancy_r, oos_brier, oos_log_loss, oos_trades, verdict)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(version) DO UPDATE SET
         role = excluded.role,
         trained_at = excluded.trained_at,
         trained_on_trades = excluded.trained_on_trades,
         feature_schema = excluded.feature_schema,
         fit = excluded.fit,
         model = excluded.model,
         oos_expectancy_r = excluded.oos_expectancy_r,
         oos_brier = excluded.oos_brier,
         oos_log_loss = excluded.oos_log_loss,
         oos_trades = excluded.oos_trades,
         verdict = excluded.verdict`,
    )
    .run(
      m.version,
      m.role,
      m.createdAt,
      m.trainedAt,
      m.trainedOnTrades,
      m.featureSchema,
      JSON.stringify(m.fit),
      JSON.stringify(m.model),
      m.oosExpectancyR,
      m.oosBrier,
      m.oosLogLoss,
      m.oosTrades,
      m.verdict,
    );
}

/** Every model version, newest first. */
export function listModels(): StoredModel[] {
  const rows = open().prepare('SELECT * FROM lab_models ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map(modelRow);
}

function modelRow(r: Record<string, unknown>): StoredModel {
  return {
    version: String(r.version),
    role: r.role as 'CHAMPION' | 'CHALLENGER' | 'RETIRED',
    createdAt: Number(r.created_at),
    trainedAt: r.trained_at === null ? null : Number(r.trained_at),
    trainedOnTrades: r.trained_on_trades === null ? null : Number(r.trained_on_trades),
    featureSchema: String(r.feature_schema),
    fit: r.fit ? JSON.parse(String(r.fit)) : null,
    model: r.model ? JSON.parse(String(r.model)) : null,
    oosExpectancyR: r.oos_expectancy_r === null ? null : Number(r.oos_expectancy_r),
    oosBrier: r.oos_brier === null ? null : Number(r.oos_brier),
    oosLogLoss: r.oos_log_loss === null ? null : Number(r.oos_log_loss),
    oosTrades: r.oos_trades === null ? null : Number(r.oos_trades),
    verdict: r.verdict === null ? null : String(r.verdict),
  };
}

/** The model currently in a given role. */
export function modelInRole(role: 'CHAMPION' | 'CHALLENGER'): StoredModel | null {
  const rows = open()
    .prepare('SELECT * FROM lab_models WHERE role = ? ORDER BY created_at DESC LIMIT 1')
    .all(role) as Array<Record<string, unknown>>;
  const r = rows[0];
  return r ? modelRow(r) : null;
}

/** Retire every model in a role, so only one holds it. */
export function clearRole(role: 'CHAMPION' | 'CHALLENGER'): void {
  open().prepare('UPDATE lab_models SET role = ? WHERE role = ?').run('RETIRED', role);
}

// ─── The decision log ────────────────────────────────────────────────────────

export interface ModelDecisionRow {
  at: number;
  version: string;
  kind: 'PROMOTED' | 'REJECTED' | 'ROLLED_BACK' | 'RETRAINED';
  reason: string;
  championExpectancyR: number | null;
  challengerExpectancyR: number | null;
  championBrier: number | null;
  challengerBrier: number | null;
}

/** Record a promotion, a rejection, a rollback or a retrain. */
export function recordModelDecision(d: ModelDecisionRow): void {
  open()
    .prepare(
      `INSERT INTO lab_model_decisions
         (at, version, kind, reason, champion_expectancy_r, challenger_expectancy_r, champion_brier, challenger_brier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.at,
      d.version,
      d.kind,
      d.reason,
      d.championExpectancyR,
      d.challengerExpectancyR,
      d.championBrier,
      d.challengerBrier,
    );
}

/** The decision log, newest first. */
export function listModelDecisions(limit = 50): ModelDecisionRow[] {
  const rows = open()
    .prepare('SELECT * FROM lab_model_decisions ORDER BY at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    at: Number(r.at),
    version: String(r.version),
    kind: r.kind as ModelDecisionRow['kind'],
    reason: String(r.reason),
    championExpectancyR: r.champion_expectancy_r === null ? null : Number(r.champion_expectancy_r),
    challengerExpectancyR: r.challenger_expectancy_r === null ? null : Number(r.challenger_expectancy_r),
    championBrier: r.champion_brier === null ? null : Number(r.champion_brier),
    challengerBrier: r.challenger_brier === null ? null : Number(r.challenger_brier),
  }));
}

// ─── Positions ───────────────────────────────────────────────────────────────

export interface StoredPosition {
  id: string;
  signalId: string;
  symbol: string;
  side: 'bullish' | 'bearish';
  sector: string | null;
  openedAt: number;
  filledAt: number | null;
  referenceEntry: number | null;
  entryPrice: number | null;
  qty: number;
  riskPerUnit: number;
  riskUsd: number;
  stop: number;
  targets: number[];
  pWin: number | null;
  expectedNetR: number | null;
  venue: 'PAPER' | 'TESTNET';
  status: 'PENDING' | 'OPEN' | 'CLOSED';
  closedAt: number | null;
  closeReason: string | null;
  referenceExit: number | null;
  exitPrice: number | null;
  grossR: number | null;
  netR: number | null;
  costR: number | null;
  feeUsd: number | null;
  slippageUsd: number | null;
  fundingUsd: number | null;
  ambiguous: boolean;
  /** The feature vector frozen at entry. Null when the decision carried none. */
  featureSnapshot: unknown | null;
}

/** Insert or update a position. */
export function savePosition(p: StoredPosition): void {
  open()
    .prepare(
      `INSERT INTO lab_positions
         (id, signal_id, symbol, side, sector, opened_at, filled_at, reference_entry, entry_price,
          qty, risk_per_unit, risk_usd, stop, targets, p_win, expected_net_r, venue, status,
          closed_at, close_reason, reference_exit, exit_price, gross_r, net_r, cost_r,
          fee_usd, slippage_usd, funding_usd, ambiguous, feature_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         filled_at = excluded.filled_at,
         reference_entry = excluded.reference_entry,
         entry_price = excluded.entry_price,
         status = excluded.status,
         closed_at = excluded.closed_at,
         close_reason = excluded.close_reason,
         reference_exit = excluded.reference_exit,
         exit_price = excluded.exit_price,
         gross_r = excluded.gross_r,
         net_r = excluded.net_r,
         cost_r = excluded.cost_r,
         fee_usd = excluded.fee_usd,
         slippage_usd = excluded.slippage_usd,
         funding_usd = excluded.funding_usd,
         ambiguous = excluded.ambiguous,
         feature_snapshot = excluded.feature_snapshot`,
    )
    .run(
      p.id,
      p.signalId,
      p.symbol,
      p.side,
      p.sector,
      p.openedAt,
      p.filledAt,
      p.referenceEntry,
      p.entryPrice,
      p.qty,
      p.riskPerUnit,
      p.riskUsd,
      p.stop,
      JSON.stringify(p.targets),
      p.pWin,
      p.expectedNetR,
      p.venue,
      p.status,
      p.closedAt,
      p.closeReason,
      p.referenceExit,
      p.exitPrice,
      p.grossR,
      p.netR,
      p.costR,
      p.feeUsd,
      p.slippageUsd,
      p.fundingUsd,
      p.ambiguous ? 1 : 0,
      p.featureSnapshot ? JSON.stringify(p.featureSnapshot) : null,
    );
}

/** The positions, newest first. */
export function listPositions(limit = 500): StoredPosition[] {
  const rows = open()
    .prepare('SELECT * FROM lab_positions ORDER BY opened_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(positionRow);
}

/** The positions that are still open or pending. */
export function openPositions(): StoredPosition[] {
  const rows = open()
    .prepare("SELECT * FROM lab_positions WHERE status IN ('PENDING','OPEN') ORDER BY opened_at ASC")
    .all() as Array<Record<string, unknown>>;
  return rows.map(positionRow);
}

function positionRow(r: Record<string, unknown>): StoredPosition {
  return {
    id: String(r.id),
    signalId: String(r.signal_id),
    symbol: String(r.symbol),
    side: r.side as 'bullish' | 'bearish',
    sector: r.sector === null ? null : String(r.sector),
    openedAt: Number(r.opened_at),
    filledAt: r.filled_at === null ? null : Number(r.filled_at),
    referenceEntry: r.reference_entry === null ? null : Number(r.reference_entry),
    entryPrice: r.entry_price === null ? null : Number(r.entry_price),
    qty: Number(r.qty),
    riskPerUnit: Number(r.risk_per_unit),
    riskUsd: Number(r.risk_usd),
    stop: Number(r.stop),
    targets: JSON.parse(String(r.targets ?? '[]')),
    pWin: r.p_win === null ? null : Number(r.p_win),
    expectedNetR: r.expected_net_r === null ? null : Number(r.expected_net_r),
    venue: r.venue as 'PAPER' | 'TESTNET',
    status: r.status as 'PENDING' | 'OPEN' | 'CLOSED',
    closedAt: r.closed_at === null ? null : Number(r.closed_at),
    closeReason: r.close_reason === null ? null : String(r.close_reason),
    referenceExit: r.reference_exit === null ? null : Number(r.reference_exit),
    exitPrice: r.exit_price === null ? null : Number(r.exit_price),
    grossR: r.gross_r === null ? null : Number(r.gross_r),
    netR: r.net_r === null ? null : Number(r.net_r),
    costR: r.cost_r === null ? null : Number(r.cost_r),
    feeUsd: r.fee_usd === null ? null : Number(r.fee_usd),
    slippageUsd: r.slippage_usd === null ? null : Number(r.slippage_usd),
    fundingUsd: r.funding_usd === null ? null : Number(r.funding_usd),
    ambiguous: Number(r.ambiguous) === 1,
    featureSnapshot: r.feature_snapshot ? JSON.parse(String(r.feature_snapshot)) : null,
  };
}

// ─── Equity ──────────────────────────────────────────────────────────────────

/** Append a point to the equity curve. */
export function appendEquity(at: number, equityUsd: number, netR: number, realisedPnlUsd: number): void {
  open()
    .prepare('INSERT INTO lab_equity (at, equity_usd, net_r, realised_pnl_usd) VALUES (?, ?, ?, ?)')
    .run(at, equityUsd, netR, realisedPnlUsd);
}

/** The equity curve, oldest first. */
export function equityCurve(limit = 500): Array<{ at: number; equityUsd: number; netR: number }> {
  const rows = open()
    .prepare('SELECT at, equity_usd, net_r FROM lab_equity ORDER BY at ASC LIMIT ?')
    .all(limit) as Array<{ at: number; equity_usd: number; net_r: number }>;
  return rows.map((r) => ({ at: Number(r.at), equityUsd: Number(r.equity_usd), netR: Number(r.net_r) }));
}

// ─── Reviews ─────────────────────────────────────────────────────────────────

/** Write a review. The first write wins: a review is evidence, not state. */
export function saveReview(r: LabReview & { createdAt: number }): void {
  open()
    .prepare(
      `INSERT OR IGNORE INTO lab_reviews
         (id, signal_id, position_id, symbol, side, opened_at, closed_at, predicted_p_win,
          outcome, outcome_label, gross_r, net_r, cost_r, failure_class, failure_note,
          no_fault, feature_snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.id,
      r.signalId,
      r.positionId ?? null,
      r.symbol,
      r.side,
      r.openedAt,
      r.closedAt,
      r.predictedPWin,
      r.outcome,
      r.outcomeLabel,
      r.grossR,
      r.netR,
      r.costR,
      r.failureClass,
      r.failureNote,
      r.noFault ? 1 : 0,
      r.featureSnapshot ? JSON.stringify(r.featureSnapshot) : null,
      r.createdAt,
    );
}

/** The reviews, newest first. */
export function listReviews(limit = 200): LabReview[] {
  const rows = open()
    .prepare('SELECT * FROM lab_reviews ORDER BY closed_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(reviewRow);
}

/** Every review, for the training set. */
export function allReviews(): LabReview[] {
  const rows = open().prepare('SELECT * FROM lab_reviews ORDER BY closed_at ASC').all() as Array<Record<string, unknown>>;
  return rows.map(reviewRow);
}

/** How many reviews exist. */
export function reviewCount(): number {
  const row = open().prepare('SELECT COUNT(*) AS n FROM lab_reviews').get() as { n: number };
  return Number(row.n);
}

function reviewRow(r: Record<string, unknown>): LabReview {
  return {
    id: String(r.id),
    signalId: String(r.signal_id),
    positionId: r.position_id === null ? null : String(r.position_id),
    symbol: String(r.symbol),
    side: r.side as 'bullish' | 'bearish',
    openedAt: Number(r.opened_at),
    closedAt: Number(r.closed_at),
    predictedPWin: r.predicted_p_win === null ? null : Number(r.predicted_p_win),
    outcome: r.outcome === null ? null : (Number(r.outcome) === 1 ? 1 : 0),
    outcomeLabel: String(r.outcome_label),
    grossR: r.gross_r === null ? null : Number(r.gross_r),
    netR: r.net_r === null ? null : Number(r.net_r),
    costR: r.cost_r === null ? null : Number(r.cost_r),
    failureClass: String(r.failure_class) as LabFailureClass,
    failureNote: String(r.failure_note),
    noFault: Number(r.no_fault) === 1,
    featureSnapshot: r.feature_snapshot ? JSON.parse(String(r.feature_snapshot)) : null,
    snapshotUrl: null,
  };
}

// ─── Fills ───────────────────────────────────────────────────────────────────

/** Record a fill. */
export function saveFill(f: LabFill & { positionId: string }): void {
  open()
    .prepare(
      `INSERT OR IGNORE INTO lab_fills
         (id, at, position_id, symbol, side, price, qty, fee_usd, slippage_usd, venue)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(f.id, f.at, f.positionId, f.symbol, f.side, f.price, f.qty, f.feeUsd, f.slippageUsd, f.venue);
}

/** The fills, newest first. */
export function listFills(limit = 200): LabFill[] {
  const rows = open()
    .prepare('SELECT * FROM lab_fills ORDER BY at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    at: Number(r.at),
    symbol: String(r.symbol),
    side: r.side as 'buy' | 'sell',
    price: Number(r.price),
    qty: Number(r.qty),
    feeUsd: Number(r.fee_usd),
    slippageUsd: Number(r.slippage_usd),
    venue: r.venue as 'PAPER' | 'TESTNET',
    costNote: 'Costs are MODELLED from LAB/RISK, not measured from a venue.',
  }));
}

// ─── The fold table and the tier table are derived, not stored ──────────────
//
// They are computed from the reviews on every read, so a stored copy could
// never disagree with the rows it was computed from. The types live here only
// so the report module and the store agree on their shape.

export type { LabFoldRow, LabTierRow, LabReliabilityRow };
