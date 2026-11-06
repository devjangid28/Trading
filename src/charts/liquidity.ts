import { BINANCE_REST_BASE } from '../lib/binance';

export interface LiquidityWall {
  price: number;
  usd: number;
  side: 'bid' | 'ask';
  levels: number;
}

interface DepthLevel {
  price: number;
  qty: number;
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseDepthLevel(raw: unknown): DepthLevel | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const price = finite(raw[0]);
  const qty = finite(raw[1]);
  if (price === null || qty === null) return null;
  return { price, qty };
}

async function readJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Depth HTTP ${response.status}`);
  return response.json();
}

/**
 * Fetch the Binance order book depth and aggregate the top levels into
 * liquidity walls. Levels are binned by a relative price step so a wall
 * spans a price zone instead of a single tick. A wall is only kept when
 * its total notional is material relative to the book.
 */
export async function fetchLiquidityWalls(
  symbol: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<LiquidityWall[]> {
  try {
    const limit = Math.max(20, Math.min(500, opts.limit ?? 100));
    const url = `${BINANCE_REST_BASE}/api/v3/depth?symbol=${encodeURIComponent(symbol.toUpperCase())}&limit=${limit}`;
    const body = await readJson(url, opts.signal);
    if (!body || typeof body !== 'object') return [];
    const bids = (body as { bids?: unknown }).bids;
    const asks = (body as { asks?: unknown }).asks;
    if (!Array.isArray(bids) || !Array.isArray(asks)) return [];

    const bidLevels: DepthLevel[] = [];
    const askLevels: DepthLevel[] = [];
    for (const raw of bids) {
      const level = parseDepthLevel(raw);
      if (level) bidLevels.push(level);
    }
    for (const raw of asks) {
      const level = parseDepthLevel(raw);
      if (level) askLevels.push(level);
    }
    if (bidLevels.length === 0 || askLevels.length === 0) return [];

    const mid = (bidLevels[0].price + askLevels[0].price) / 2;
    if (!Number.isFinite(mid) || mid <= 0) return [];
    const binStep = Math.max(mid * 0.0004, 1e-12);

    const bin = (price: number) => Math.round(price / binStep);

    const aggregate = (levels: DepthLevel[], side: 'bid' | 'ask'): LiquidityWall[] => {
      const groups = new Map<number, { priceUsd: number; usd: number; count: number }>();
      for (const level of levels) {
        const key = bin(level.price);
        const usd = level.price * level.qty;
        const existing = groups.get(key) ?? { priceUsd: 0, usd: 0, count: 0 };
        existing.priceUsd += level.price * usd;
        existing.usd += usd;
        existing.count += 1;
        groups.set(key, existing);
      }
      const walls = [...groups.values()]
        .map((entry) => ({
          price: entry.priceUsd / Math.max(1e-12, entry.usd),
          usd: entry.usd,
          side,
          levels: entry.count,
        }))
        .sort((a, b) => b.usd - a.usd);
      const reference = walls[0]?.usd ?? 0;
      return walls.filter((wall) => reference > 0 && wall.usd >= reference * 0.12).slice(0, 12);
    };

    const walls = [...aggregate(bidLevels, 'bid'), ...aggregate(askLevels, 'ask')]
      .sort((a, b) => a.price - b.price);
    return walls;
  } catch {
    return [];
  }
}