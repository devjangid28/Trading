import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TerminalBook, TerminalHistory, TerminalTrade } from '../../../shared/types.js';
import { TERMINAL } from '../config.js';
import {
  historyFrame, pruneBefore, selectEvenly, tradeBucketMs,
} from './history.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.TERMINAL_DB ?? resolve(__dirname, '../../data/terminal-history.db');

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS terminal_frames (
      symbol          TEXT NOT NULL,
      as_of           INTEGER NOT NULL,
      last_update_id  INTEGER NOT NULL,
      mid             REAL NOT NULL,
      best_bid        REAL NOT NULL,
      best_ask        REAL NOT NULL,
      bid_usd         REAL NOT NULL,
      ask_usd         REAL NOT NULL,
      bin_bps         REAL NOT NULL,
      range_pct       REAL NOT NULL,
      bids            BLOB NOT NULL,
      asks            BLOB NOT NULL,
      PRIMARY KEY (symbol, as_of)
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_frames_symbol
      ON terminal_frames(symbol, as_of DESC);

    CREATE TABLE IF NOT EXISTS terminal_trades (
      symbol  TEXT NOT NULL,
      id      INTEGER NOT NULL,
      t       INTEGER NOT NULL,
      price   REAL NOT NULL,
      qty     REAL NOT NULL,
      usd     REAL NOT NULL,
      side    TEXT NOT NULL,
      PRIMARY KEY (symbol, id)
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_trades_symbol
      ON terminal_trades(symbol, t DESC);
  `);
  db = d;
  return d;
}

export function closeTerminalHistory(): void {
  db?.close();
  db = null;
}

function floats(values: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

function decodeFloats(blob: unknown): number[] {
  if (!(blob instanceof Uint8Array)) return [];
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return Array.from(new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4));
}

export function recordTerminalBook(book: TerminalBook): number {
  const frame = historyFrame(book);
  const d = open();
  d.prepare(`
    INSERT OR REPLACE INTO terminal_frames (
      symbol, as_of, last_update_id, mid, best_bid, best_ask,
      bid_usd, ask_usd, bin_bps, range_pct, bids, asks
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    book.symbol, frame.asOf, frame.lastUpdateId, frame.mid,
    frame.bestBid, frame.bestAsk, frame.bidUsd, frame.askUsd,
    frame.binBps, frame.rangePct, floats(frame.bids), floats(frame.asks),
  );

  if (book.trades.length) {
    const stmt = d.prepare(`
      INSERT OR IGNORE INTO terminal_trades (symbol, id, t, price, qty, usd, side)
      VALUES (?,?,?,?,?,?,?)
    `);
    d.exec('BEGIN');
    try {
      for (const trade of book.trades) {
        stmt.run(book.symbol, trade.id, trade.t, trade.price, trade.qty, trade.usd, trade.side);
      }
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
  }
  return frame.asOf;
}

function exactTrades(symbol: string, from: number, to: number): TerminalTrade[] {
  const rows = open().prepare(`
    SELECT id, t, price, qty, usd, side
    FROM terminal_trades
    WHERE symbol = ? AND t >= ? AND t <= ?
    ORDER BY t ASC, id ASC
  `).all(symbol, from, to) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    t: Number(r.t),
    price: Number(r.price),
    qty: Number(r.qty),
    usd: Number(r.usd),
    side: r.side === 'buy' ? 'buy' : 'sell',
  }));
}

function bucketedTrades(symbol: string, from: number, to: number): TerminalTrade[] {
  const bucketMs = tradeBucketMs(to - from);
  const rows = open().prepare(`
    SELECT (t / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket,
           SUM(usd) AS usd,
           SUM(qty) AS qty,
           SUM(CASE WHEN side = 'buy' THEN usd ELSE 0 END) AS buy_usd,
           COUNT(*) AS count
    FROM terminal_trades
    WHERE symbol = ? AND t >= ? AND t <= ?
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(bucketMs, bucketMs, symbol, from, to) as unknown as Record<string, unknown>[];
  return rows.map((r) => {
    const usd = Number(r.usd);
    const qty = Number(r.qty);
    const buyUsd = Number(r.buy_usd);
    const bucket = Number(r.bucket);
    return {
      id: -bucket - 1,
      t: bucket,
      price: qty > 0 ? usd / qty : 0,
      qty,
      usd,
      side: buyUsd >= usd - buyUsd ? 'buy' : 'sell',
      count: Number(r.count),
      bucketMs,
    } satisfies TerminalTrade;
  }).filter((trade) => trade.price > 0 && trade.usd > 0);
}

export function readTerminalHistory(
  symbol: string,
  from: number,
  to: number,
  maxFrames: number = TERMINAL.HISTORY_MAX_FRAMES,
): TerminalHistory {
  const d = open();
  const summary = d.prepare(`
    SELECT COUNT(*) AS count, MIN(as_of) AS first_at, MAX(as_of) AS last_at
    FROM terminal_frames
    WHERE symbol = ? AND as_of >= ? AND as_of <= ?
  `).get(symbol, from, to) as {
    count: number; first_at: number | null; last_at: number | null;
  };
  const count = Number(summary.count);
  const columns = `
    as_of, last_update_id, mid, best_bid, best_ask, bid_usd, ask_usd,
    bin_bps, range_pct, bids, asks
  `;
  const rows = (count <= maxFrames || maxFrames <= 1
    ? d.prepare(`
        SELECT ${columns}
        FROM terminal_frames
        WHERE symbol = ? AND as_of >= ? AND as_of <= ?
        ${maxFrames <= 1 ? 'ORDER BY as_of DESC LIMIT 1' : 'ORDER BY as_of ASC'}
      `).all(symbol, from, to)
    : d.prepare(`
        WITH ranked AS (
          SELECT as_of,
                 ROW_NUMBER() OVER (ORDER BY as_of ASC) - 1 AS rn
          FROM terminal_frames
          WHERE symbol = ? AND as_of >= ? AND as_of <= ?
        ), picked AS (
          SELECT as_of FROM ranked
          WHERE rn = 0
             OR CAST(rn * ? / ? AS INTEGER) <> CAST((rn - 1) * ? / ? AS INTEGER)
        )
        SELECT ${columns}
        FROM terminal_frames t
        JOIN picked USING (as_of)
        WHERE t.symbol = ?
        ORDER BY t.as_of ASC
      `).all(
      symbol, from, to,
      maxFrames - 1, Math.max(1, count - 1), maxFrames - 1, Math.max(1, count - 1),
      symbol,
    )) as unknown as Record<string, unknown>[];

  const allFrames = rows.map((r) => ({
    asOf: Number(r.as_of),
    lastUpdateId: Number(r.last_update_id),
    mid: Number(r.mid),
    bestBid: Number(r.best_bid),
    bestAsk: Number(r.best_ask),
    bidUsd: Number(r.bid_usd),
    askUsd: Number(r.ask_usd),
    binBps: Number(r.bin_bps),
    rangePct: Number(r.range_pct),
    bids: decodeFloats(r.bids),
    asks: decodeFloats(r.asks),
  }));
  const frames = selectEvenly(allFrames, Math.max(1, maxFrames));
  const tradeCount = Number((d.prepare(`
    SELECT COUNT(*) AS count FROM terminal_trades
    WHERE symbol = ? AND t >= ? AND t <= ?
  `).get(symbol, from, to) as { count: number }).count);
  const trades = tradeCount > TERMINAL.HISTORY_EXACT_TRADES
    ? bucketedTrades(symbol, from, to)
    : exactTrades(symbol, from, to);

  return {
    symbol,
    from,
    to,
    firstAt: summary.first_at === null ? null : Number(summary.first_at),
    lastAt: summary.last_at === null ? null : Number(summary.last_at),
    frameCount: Number(summary.count),
    truncated: count > frames.length,
    binBps: TERMINAL.HISTORY_BIN_BPS,
    rangePct: TERMINAL.HISTORY_RANGE_PCT,
    tradeBucketMs: tradeCount > TERMINAL.HISTORY_EXACT_TRADES
      ? tradeBucketMs(to - from)
      : 0,
    frames,
    trades,
  };
}

export function pruneTerminalHistory(now = Date.now()): number {
  const cutoff = pruneBefore(now);
  const d = open();
  const frames = d.prepare(`DELETE FROM terminal_frames WHERE as_of < ?`).run(cutoff);
  const trades = d.prepare(`DELETE FROM terminal_trades WHERE t < ?`).run(cutoff);
  return Number(frames.changes ?? 0) + Number(trades.changes ?? 0);
}

export { DB_PATH as TERMINAL_DB_PATH };
