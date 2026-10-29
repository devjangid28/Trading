import type {
  Candle, TerminalBook, TerminalBookLevel, TerminalHistoryFrame, TerminalInterval, TerminalTrade,
} from '../../shared/types';

export interface BookLattice {
  binBps: number;
  rangePct: number;
  binsPerSide: number;
  bids: Float32Array;
  asks: Float32Array;
}

export interface BookFrame {
  asOf: number;
  lastUpdateId: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  bidUsd: number;
  askUsd: number;
  bids: TerminalBookLevel[];
  asks: TerminalBookLevel[];
  /** Server-captured compact history; prices derive from `mid` and `binBps`. */
  lattice?: BookLattice;
  source?: 'live' | 'history';
}

export interface WallReading {
  side: 'bid' | 'ask';
  price: number;
  usd: number;
  distanceBps: number;
  multiple: number;
  peerLevels: number;
  standingMs: number;
  standingSinceStart: boolean;
  pulls: number;
}

export const INTERVAL_MS: Record<TerminalInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/** [TUNED] Browser-only heatmap memory: 15 min at the 1 s live cadence, 45 min at 3 s fallback. */
export const BOOK_HISTORY_LIMIT = 900;
/** [TUNED] Captured history plus live frames; history frames are compact lattices. */
export const MERGED_FRAME_LIMIT = 4_000;

export function frameFromBook(book: TerminalBook): BookFrame {
  return {
    asOf: book.asOf,
    lastUpdateId: book.lastUpdateId,
    mid: book.mid,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    bidUsd: book.bidUsd,
    askUsd: book.askUsd,
    bids: book.bids,
    asks: book.asks,
    source: 'live',
  };
}

export function frameFromHistory(frame: TerminalHistoryFrame): BookFrame {
  const binsPerSide = Math.max(frame.bids.length, frame.asks.length);
  return {
    asOf: frame.asOf,
    lastUpdateId: frame.lastUpdateId,
    mid: frame.mid,
    bestBid: frame.bestBid,
    bestAsk: frame.bestAsk,
    bidUsd: frame.bidUsd,
    askUsd: frame.askUsd,
    bids: [],
    asks: [],
    lattice: {
      binBps: frame.binBps,
      rangePct: frame.rangePct,
      binsPerSide,
      bids: Float32Array.from(frame.bids),
      asks: Float32Array.from(frame.asks),
    },
    source: 'history',
  };
}

/**
 * Merge captured history with the live ring. Same-timestamp live frames win:
 * a full level list is better evidence than a compact historical lattice.
 */
export function mergeBookFrames(
  history: readonly BookFrame[],
  live: readonly BookFrame[],
  cap = MERGED_FRAME_LIMIT,
): BookFrame[] {
  if (!history.length) return live.slice(-cap);
  const byTime = new Map<number, BookFrame>();
  for (const frame of history) byTime.set(frame.asOf, frame);
  for (const frame of live) byTime.set(frame.asOf, frame);
  const out = [...byTime.values()].sort((a, b) => a.asOf - b.asOf);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** Append one sampled book, dropping a duplicate snapshot. */
export function appendBookFrame(
  frames: BookFrame[],
  next: BookFrame,
  cap = BOOK_HISTORY_LIMIT,
): BookFrame[] {
  const last = frames[frames.length - 1];
  if (last && last.lastUpdateId === next.lastUpdateId && last.asOf === next.asOf) return frames;
  const out = frames.length >= cap ? frames.slice(frames.length - cap + 1) : frames.slice();
  out.push(next);
  return out;
}

/** Merge REST polls by aggregate-trade id, oldest first. */
export function mergeTrades(
  existing: TerminalTrade[],
  incoming: TerminalTrade[],
  cap = 5_000,
): TerminalTrade[] {
  if (!incoming.length) return existing;
  const byId = new Map<number, TerminalTrade>();
  for (const t of existing) byId.set(t.id, t);
  for (const t of incoming) byId.set(t.id, t);
  const out = [...byId.values()].sort((a, b) => a.t - b.t || a.id - b.id);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/**
 * Extend the newest REST candle with the live tick. This is a display merge
 * only: it never marks a candle closed, and the next REST poll replaces the
 * whole forming bar with the exchange's own OHLCV.
 */
export function mergeLiveCandle(
  candles: Candle[],
  price: number | null | undefined,
  interval: TerminalInterval,
  now = Date.now(),
): Candle[] {
  if (!candles.length || price === null || price === undefined) return candles;
  if (!Number.isFinite(price) || price <= 0) return candles;

  const step = INTERVAL_MS[interval];
  const bucket = Math.floor(now / step) * step;
  const last = candles[candles.length - 1];

  if (bucket > last.t) {
    return [
      ...candles,
      { t: bucket, o: price, h: price, l: price, c: price, v: 0, closed: false },
    ];
  }
  if (bucket < last.t) return candles;
  if (last.closed === false && last.c === price && last.h >= price && last.l <= price) {
    return candles;
  }
  return [
    ...candles.slice(0, -1),
    {
      ...last,
      h: Math.max(last.h, price),
      l: Math.min(last.l, price),
      c: price,
      closed: false,
    },
  ];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The largest resting level near the touch, compared with the median level.
 * Only a level that is genuinely exceptional is called a wall; an evenly
 * distributed book returns null rather than promoting its biggest normal level.
 */
export interface SideWall {
  side: 'bid' | 'ask';
  price: number;
  usd: number;
  distanceBps: number;
  multiple: number;
  peerLevels: number;
  standingMs: number;
  standingSinceStart: boolean;
  pulls: number;
}

export interface SideWalls {
  bid: SideWall | null;
  ask: SideWall | null;
}

function sideWall(
  frames: BookFrame[],
  side: 'bid' | 'ask',
  top: TerminalBookLevel,
  peerMedian: number,
  peerLevels: number,
): SideWall {
  const latest = frames[frames.length - 1];
  const distanceBps = latest.mid > 0 ? (Math.abs(top.price - latest.mid) / latest.mid) * 10_000 : 0;
  const floor = top.usd * 0.4;
  const present = (f: BookFrame) => {
    const levels = side === 'bid' ? f.bids : f.asks;
    const level = levels.find((l) => l.price === top.price);
    return Boolean(level && level.usd >= floor);
  };
  let start = frames.length - 1;
  while (start > 0 && present(frames[start - 1])) start -= 1;
  let pulls = 0;
  let was = present(frames[0]);
  for (let i = 1; i < frames.length; i++) {
    const is = present(frames[i]);
    if (was && !is) pulls += 1;
    was = is;
  }
  return {
    side,
    price: top.price,
    usd: top.usd,
    distanceBps,
    multiple: peerMedian > 0 ? top.usd / peerMedian : 0,
    peerLevels,
    standingMs: latest.asOf - frames[start].asOf,
    standingSinceStart: start === 0,
    pulls,
  };
}

/**
 * The two largest near-touch levels, one per side. These are the levels the
 * reference calls the nearest walls; unlike wallReading() this does not require
 * a multiple of the peer median, so it always names what is actually resting
 * nearest the touch. The multiple is returned for honesty, not hidden.
 */
export function nearestWalls(
  frames: BookFrame[],
  near: number,
  peerLevels = 20,
  minUsd = 0,
): SideWalls {
  const latest = frames[frames.length - 1];
  if (!latest || latest.mid <= 0) return { bid: null, ask: null };
  const nearBids = latest.bids.filter((l) => l.usd >= minUsd && (latest.mid - l.price) / latest.mid <= near + 1e-9);
  const nearAsks = latest.asks.filter((l) => l.usd >= minUsd && (l.price - latest.mid) / latest.mid <= near + 1e-9);
  const all = [...nearBids, ...nearAsks];
  if (!all.length) return { bid: null, ask: null };
  const peers = [...all].sort((a, b) => b.usd - a.usd).slice(0, Math.max(1, peerLevels));
  const med = median(peers.map((l) => l.usd));
  const topBid = nearBids.reduce<TerminalBookLevel | null>((top, l) => (!top || l.usd > top.usd ? l : top), null);
  const topAsk = nearAsks.reduce<TerminalBookLevel | null>((top, l) => (!top || l.usd > top.usd ? l : top), null);
  return {
    bid: topBid ? sideWall(frames, 'bid', topBid, med, peers.length) : null,
    ask: topAsk ? sideWall(frames, 'ask', topAsk, med, peers.length) : null,
  };
}

export interface TapeStats {
  cvdUsd: number;
  candleDeltaQty: number;
  poc: number | null;
  capturedUsd: number;
  capturedTrades: number;
}

/** Stats measured only from the public tape this browser has captured. */
export function tapeStats(
  trades: TerminalTrade[],
  mid: number,
  intervalMs: number,
  asOf: number,
): TapeStats {
  let cvdUsd = 0;
  let candleDeltaQty = 0;
  let capturedUsd = 0;
  const bucketStart = Math.floor(asOf / intervalMs) * intervalMs;
  const bin = mid > 0 ? Math.max(mid * 0.0001, Number.EPSILON) : 1;
  const byBin = new Map<number, number>();
  for (const t of trades) {
    const signed = t.side === 'buy' ? t.usd : -t.usd;
    cvdUsd += signed;
    capturedUsd += t.usd;
    if (t.t >= bucketStart) candleDeltaQty += t.side === 'buy' ? t.qty : -t.qty;
    const key = Math.round(t.price / bin);
    byBin.set(key, (byBin.get(key) ?? 0) + t.usd);
  }
  let pocKey: number | null = null;
  let pocUsd = -1;
  for (const [key, usd] of byBin) {
    if (usd > pocUsd) { pocUsd = usd; pocKey = key; }
  }
  return {
    cvdUsd,
    candleDeltaQty,
    poc: pocKey === null ? null : pocKey * bin,
    capturedUsd,
    capturedTrades: trades.length,
  };
}

export function wallReading(
  frames: BookFrame[],
  multiple: number,
  near: number,
  peerLevels = 20,
): WallReading | null {
  const latest = frames[frames.length - 1];
  if (!latest) return null;

  const nearBids = latest.bids.filter((l) => latest.mid > 0 && (latest.mid - l.price) / latest.mid <= near + 1e-9);
  const nearAsks = latest.asks.filter((l) => latest.mid > 0 && (l.price - latest.mid) / latest.mid <= near + 1e-9);
  const all = [...nearBids, ...nearAsks];
  if (all.length < 4) return null;

  const peers = [...all].sort((a, b) => b.usd - a.usd).slice(0, Math.max(1, peerLevels));
  const med = median(peers.map((l) => l.usd));
  if (med <= 0) return null;

  let top = all[0];
  for (const level of all) if (level.usd > top.usd) top = level;
  const ratio = top.usd / med;
  if (ratio < multiple) return null;

  const side: 'bid' | 'ask' = nearBids.includes(top) ? 'bid' : 'ask';
  const distanceBps = latest.mid > 0 ? (Math.abs(top.price - latest.mid) / latest.mid) * 10_000 : 0;
  const wallFloor = top.usd * 0.4;

  const present = (frame: BookFrame) => {
    const book = side === 'bid' ? frame.bids : frame.asks;
    const level = book.find((l) => l.price === top.price);
    return Boolean(level && level.usd >= wallFloor);
  };

  let start = frames.length - 1;
  while (start > 0 && present(frames[start - 1])) start -= 1;
  const standingSinceStart = start === 0;

  let pulls = 0;
  let was = present(frames[0]);
  for (let i = 1; i < frames.length; i++) {
    const is = present(frames[i]);
    if (was && !is) pulls += 1;
    was = is;
  }

  return {
    side,
    price: top.price,
    usd: top.usd,
    distanceBps,
    multiple: ratio,
    peerLevels: peers.length,
    standingMs: latest.asOf - frames[start].asOf,
    standingSinceStart,
    pulls,
  };
}

export interface PullEvent {
  t: number;
  price: number;
  side: 'bid' | 'ask';
  usd: number;
  standingMs: number;
}

function tradeTimesByPrice(trades: readonly TerminalTrade[]): Map<number, number[]> {
  const byPrice = new Map<number, number[]>();
  for (const t of trades) {
    const list = byPrice.get(t.price);
    if (list) list.push(t.t);
    else byPrice.set(t.price, [t.t]);
  }
  for (const list of byPrice.values()) list.sort((a, b) => a - b);
  return byPrice;
}

function tradedBetween(byPrice: Map<number, number[]>, price: number, from: number, to: number): boolean {
  const list = byPrice.get(price);
  if (!list || !list.length) return false;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] <= from) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length && list[lo] <= to;
}

/**
 * Levels that visibly disappeared between two live snapshots without a trade at
 * that price. A level consumed by trades is not a pull; a level that vanishes
 * while the tape is quiet is. Only the contiguous live tail is considered �
 * server history frames are lattices without individual levels.
 */
export function pullEvents(
  frames: readonly BookFrame[],
  trades: readonly TerminalTrade[],
  minUsd = 10_000,
  limit = 160,
): PullEvent[] {
  const live: BookFrame[] = [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (f.source === 'history' || !f.bids.length || !f.asks.length) break;
    live.push(f);
  }
  live.reverse();
  if (live.length < 2) return [];

  const byPrice = tradeTimesByPrice(trades);
  const active = new Map<string, { start: number; usd: number; price: number; side: 'bid' | 'ask' }>();
  const out: PullEvent[] = [];
  let prev: BookFrame | null = null;

  for (const frame of live) {
    const seen = new Set<string>();
    for (const side of ['bid', 'ask'] as const) {
      for (const level of side === 'bid' ? frame.bids : frame.asks) {
        const key = `${side}:${level.price}`;
        seen.add(key);
        const state = active.get(key);
        if (state) state.usd = level.usd;
        else active.set(key, { start: frame.asOf, usd: level.usd, price: level.price, side });
      }
    }
    if (prev) {
      for (const [key, state] of active) {
        if (seen.has(key)) continue;
        const quiet = !tradedBetween(byPrice, state.price, prev.asOf, frame.asOf);
        if (quiet && state.usd >= minUsd) {
          out.push({
            t: frame.asOf,
            price: state.price,
            side: state.side,
            usd: state.usd,
            standingMs: Math.max(0, frame.asOf - state.start),
          });
        }
        active.delete(key);
      }
    }
    prev = frame;
  }

  return out.length > limit ? out.slice(out.length - limit) : out;
}

/** Price notation for the selected market; BTC and ETH both quote cents. */
export function priceDecimals(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 2;
  if (price >= 1000) return 2;
  if (price >= 1) return 4;
  if (price >= 0.01) return 5;
  if (price >= 0.0001) return 6;
  return 8;
}

export function priceQuantum(price: number): number {
  return 10 ** -priceDecimals(price);
}

export function snapPrice(price: number, quantum: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(quantum) || quantum <= 0) return price;
  return Math.round(price / quantum) * quantum;
}
export function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1_000) return 'under 1s';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1_000);
  if (secs === 0 || secs === 60) return `${mins} min`;
  return `${mins}m ${secs}s`;
}

export const fmtDuration = humanizeDuration;
export const humanizeMs = humanizeDuration;

export function bluffScore(...args: any[]): number {
  let pulls = 0;
  let dwellMs = 0;
  let tradedThrough = false;
  if (args[0] && typeof args[0] === 'object') {
    pulls = Number(args[0].pulls ?? args[0].pullCount ?? 0) || 0;
    dwellMs = Number(args[0].standingMs ?? args[0].dwellMs ?? args[0].dwell ?? 0) || 0;
    tradedThrough = Boolean(args[1]);
  } else {
    pulls = Number(args[0]) || 0;
    dwellMs = Number(args[1]) || 0;
    tradedThrough = Boolean(args[2]);
  }
  if (tradedThrough) return 0;
  if (pulls <= 0) return 0;
  const minutes = Math.max(1 / 60, dwellMs / 60_000);
  return Math.min(1, (pulls / minutes) / 2);
}

export function isBluff(...args: any[]): boolean {
  const score = bluffScore(...args);
  let pulls = 0;
  if (args[0] && typeof args[0] === 'object') pulls = Number(args[0].pulls ?? args[0].pullCount ?? 0) || 0;
  else pulls = Number(args[0]) || 0;
  return !args.includes(true) && score >= 0.35 && pulls >= 1;
}

export const bluffHeuristic = isBluff;
export const wallBluffScore = bluffScore;
