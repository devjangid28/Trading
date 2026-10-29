import type { TerminalTrade } from '../../shared/types';
import type { BookFrame } from './math';

export const MOCK_SPAN_MS = 15 * 60_000;
export const MOCK_RECORD_MS = 3.5 * 60_000;

export interface MockHeatmap {
  frames: BookFrame[];
  trades: TerminalTrade[];
  recordStart: number;
  lowest: number;
  highest: number;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultAnchor(symbol: string): number {
  const base = symbol.replace(/USDT$/i, '').toUpperCase();
  if (base === 'BTC') return 80_590;
  if (base === 'ETH') return 2_420;
  if (base === 'SOL') return 148;
  if (base === 'BNB') return 612;
  return 100;
}

/** Deterministic reference-shaped path: rise, fall, then recover to the last price. */
function pathPrice(mid: number, u: number): number {
  const t = Math.min(1, Math.max(0, u));
  if (t < 0.28) return mid - 50 + (t / 0.28) * 160;
  if (t < 0.66) return mid + 110 - ((t - 0.28) / 0.38) * 280;
  return mid - 170 + ((t - 0.66) / 0.34) * 170;
}

function describe(
  asOf: number,
  mid: number,
  levels: Array<{ price: number; usd: number }>,
  asks: Array<{ price: number; usd: number }>,
  lastUpdateId: number,
): BookFrame {
  return {
    asOf,
    lastUpdateId,
    mid,
    bestBid: levels[0]?.price ?? mid,
    bestAsk: asks[0]?.price ?? mid,
    bidUsd: levels.reduce((sum, level) => sum + level.usd, 0),
    askUsd: asks.reduce((sum, level) => sum + level.usd, 0),
    bids: levels,
    asks,
    source: 'live',
  };
}

/**
 * The reference composition, generated only when the app is explicitly in
 * MOCK mode. It is deterministic for a symbol and is never merged into LIVE
 * frames or presented as captured history.
 */
export function buildMockHeatmap(symbol: string, anchorMid = 0, now = Date.now()): MockHeatmap {
  const mid = anchorMid > 0 ? anchorMid : defaultAnchor(symbol);
  const seed = hash(`${symbol}:${Math.round(mid)}`);
  const random = rng(seed);
  const recordStart = now - MOCK_RECORD_MS;
  const tradeStart = now - MOCK_SPAN_MS;
  const priceStep = Math.max(0.5, mid * 0.000025);
  const round = (price: number) => Number(price.toFixed(mid >= 1_000 ? 2 : 4));

  const trades: TerminalTrade[] = [];
  let id = 1_000_000;
  const pushTrade = (t: number, price: number, usd: number, side: 'buy' | 'sell', count: number) => {
    trades.push({
      id: id++,
      t,
      price: round(price),
      qty: usd / Math.max(1e-9, price),
      usd,
      side,
      count,
    });
  };

  // 45 large prints carry the bubble story; a dense small-print tail puts the
  // auto tape threshold near the reference's $5.5K without inventing giant fills.
  for (let i = 0; i < 45; i++) {
    const u = (i + 0.35) / 45;
    const t = tradeStart + u * (MOCK_SPAN_MS - 8_000);
    const price = pathPrice(mid, u) + (random() - 0.5) * priceStep * 2;
    const scale = i === 12 || i === 21 || i === 31 ? 2.4 : 1;
    const rising = u < 0.28 || u >= 0.66;
    pushTrade(t, price, (90_000 + random() * 260_000) * scale, rising ? 'buy' : 'sell', 1 + Math.floor(random() * 9));
  }
  for (let i = 0; i < 1_800; i++) {
    const u = (i + 0.2) / 1_800;
    const t = tradeStart + u * (MOCK_SPAN_MS - 5_000);
    const price = pathPrice(mid, u) + (random() - 0.5) * priceStep * 3;
    const rising = u < 0.28 || u >= 0.66;
    pushTrade(t, price, 500 + random() * 5_500, rising ? 'buy' : 'sell', 1 + Math.floor(random() * 4));
  }
  trades.sort((a, b) => a.t - b.t || a.id - b.id);

  interface LevelSpec {
    price: number;
    usd: number;
    since: number;
    until?: number;
  }

  const bidWallSince = MOCK_RECORD_MS - 39_000;
  const bidSpecs: LevelSpec[] = [
    { price: round(mid - 11 * priceStep), usd: 262_900, since: bidWallSince },
    { price: round(mid - 31 * priceStep), usd: 198_400, since: 0 },
    { price: round(mid - 55 * priceStep), usd: 154_300, since: 0 },
    { price: round(mid - 15 * priceStep), usd: 210_000, since: 0, until: MOCK_RECORD_MS - 20_000 },
    { price: round(mid - 44 * priceStep), usd: 186_000, since: MOCK_RECORD_MS - 10_000 },
  ];
  const askSpecs: LevelSpec[] = [
    { price: round(mid + 8 * priceStep), usd: 343_700, since: MOCK_RECORD_MS - 2_000 },
    { price: round(mid + 33 * priceStep), usd: 250_000, since: 0 },
    { price: round(mid + 57 * priceStep), usd: 176_500, since: 0 },
    { price: round(mid + 22 * priceStep), usd: 403_000, since: 0, until: MOCK_RECORD_MS - 20_000 },
  ];
  for (let pull = 0; pull < 6; pull++) {
    askSpecs.push({
      price: round(mid + (15 + pull) * priceStep),
      usd: 165_000 + pull * 6_000,
      since: 0,
      until: MOCK_RECORD_MS - (24_000 + pull * 9_000),
    });
  }

  const controlled = new Set([...bidSpecs, ...askSpecs].map((spec) => spec.price));
  const grid: number[] = [];
  for (let level = -360; level <= 360; level++) grid.push(round(mid + level * priceStep));
  const times: number[] = [];
  for (let elapsed = 0; elapsed <= MOCK_RECORD_MS; elapsed += 2_000) times.push(elapsed);
  if (!times.includes(bidWallSince)) times.push(bidWallSince);
  times.sort((a, b) => a - b);

  const frames: BookFrame[] = [];
  for (const elapsed of times) {
    const asOf = recordStart + elapsed;
    const u = (asOf - tradeStart) / MOCK_SPAN_MS;
    const frameMid = pathPrice(mid, Math.min(1, u));
    const bids: Array<{ price: number; usd: number }> = [];
    const asks: Array<{ price: number; usd: number }> = [];

    // A stable price lattice is what a real book looks like between snapshots:
    // sizes change, individual price levels do not wander with the mid.
    for (const price of grid) {
      if (controlled.has(price)) continue;
      if (Math.abs(price - frameMid) > 95 * priceStep) continue;
      const offset = Math.round((price - mid) / priceStep);
      const baseUsd = 3_600 + (Math.abs(offset * 2_654_435_761) % 10_500);
      const usd = baseUsd + random() * 2_400;
      if (price < frameMid) bids.push({ price, usd });
      else asks.push({ price, usd });
    }

    for (const spec of bidSpecs) {
      if (elapsed < spec.since) continue;
      if (spec.until !== undefined && elapsed >= spec.until) continue;
      bids.push({ price: spec.price, usd: spec.usd });
    }
    for (const spec of askSpecs) {
      if (elapsed < spec.since) continue;
      if (spec.until !== undefined && elapsed >= spec.until) continue;
      asks.push({ price: spec.price, usd: spec.usd });
    }

    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);
    frames.push(describe(asOf, frameMid, bids, asks, id + frames.length));
  }

  const prices = trades.map((trade) => trade.price);
  return {
    frames,
    trades,
    recordStart,
    lowest: prices.length ? Math.min(...prices) : mid,
    highest: prices.length ? Math.max(...prices) : mid,
  };
}
