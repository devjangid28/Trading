import type {
  TerminalBook, TerminalHistoryFrame, TerminalSpan,
} from '../../../shared/types.js';
import { TERMINAL_SPANS } from '../../../shared/types.js';
import { TERMINAL } from '../config.js';

export const SPAN_MS: Record<TerminalSpan, number> = {
  '1m': 60_000,
  '2m': 120_000,
  '5m': 300_000,
  '12m': 720_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export function parseTerminalSpan(raw: unknown): TerminalSpan | null {
  if (typeof raw !== 'string') return null;
  return (TERMINAL_SPANS as readonly string[]).includes(raw) ? (raw as TerminalSpan) : null;
}

export interface DepthLattice {
  binBps: number;
  rangePct: number;
  bids: number[];
  asks: number[];
}

function binsPerSide(rangePct: number, binBps: number): number {
  return Math.max(1, Math.ceil((rangePct * 10_000) / Math.max(0.01, binBps)));
}

/** Compress a real full-depth snapshot; every value is summed resting notional. */
export function compactDepth(
  book: Pick<TerminalBook, 'mid' | 'bids' | 'asks'>,
  binBps = TERMINAL.HISTORY_BIN_BPS,
  rangePct = TERMINAL.HISTORY_RANGE_PCT,
): DepthLattice {
  const bins = binsPerSide(rangePct, binBps);
  const bids = new Array<number>(bins).fill(0);
  const asks = new Array<number>(bins).fill(0);
  if (!(book.mid > 0) || !(rangePct > 0) || !(binBps > 0)) {
    return { binBps, rangePct, bids, asks };
  }
  const step = binBps / 10_000;
  const indexFor = (price: number): number => Math.floor(
    (Math.abs(price - book.mid) / book.mid) / step + 1e-9,
  );
  for (const level of book.bids) {
    if (!(level.price > 0) || !(level.usd > 0) || level.price >= book.mid) continue;
    const index = indexFor(level.price);
    if (index >= 0 && index < bins) bids[index] += level.usd;
  }
  for (const level of book.asks) {
    if (!(level.price > 0) || !(level.usd > 0) || level.price <= book.mid) continue;
    const index = indexFor(level.price);
    if (index >= 0 && index < bins) asks[index] += level.usd;
  }
  return { binBps, rangePct, bids, asks };
}

export function historyFrame(
  book: TerminalBook,
  binBps = TERMINAL.HISTORY_BIN_BPS,
  rangePct = TERMINAL.HISTORY_RANGE_PCT,
): TerminalHistoryFrame {
  const lattice = compactDepth(book, binBps, rangePct);
  return {
    asOf: book.asOf,
    lastUpdateId: book.lastUpdateId,
    mid: book.mid,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    bidUsd: book.bidUsd,
    askUsd: book.askUsd,
    binBps: lattice.binBps,
    rangePct: lattice.rangePct,
    bids: lattice.bids,
    asks: lattice.asks,
  };
}

/** A deterministic, evenly spaced subset that always keeps the newest sample. */
export function selectEvenly<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return items.slice();
  if (max <= 1) return items.length ? [items[items.length - 1]] : [];
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    const index = Math.round((i * (items.length - 1)) / (max - 1));
    out.push(items[index]);
  }
  return out;
}

const TRADE_STEPS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000] as const;

export function tradeBucketMs(spanMs: number, target = TERMINAL.HISTORY_TRADE_BUCKETS): number {
  const wanted = Math.max(1, spanMs) / Math.max(1, target);
  return TRADE_STEPS.find((step) => step >= wanted) ?? TRADE_STEPS[TRADE_STEPS.length - 1];
}

export function historyWindow(
  span: TerminalSpan,
  now = Date.now(),
  retentionMs = TERMINAL.HISTORY_RETENTION_MS,
): { from: number; to: number; spanMs: number } {
  const spanMs = SPAN_MS[span];
  const from = Math.max(now - spanMs, now - retentionMs);
  return { from, to: Math.max(from + 1, now), spanMs };
}

export function pruneBefore(now = Date.now(), retentionMs = TERMINAL.HISTORY_RETENTION_MS): number {
  return now - retentionMs;
}
