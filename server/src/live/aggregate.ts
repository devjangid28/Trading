import type { LiveAggregate, LiveMover, LiveSector } from '../../../shared/types.js';
import { currentUniverse } from '../data/universeBuilder.js';
import { MOVERS_MIN_VOLUME_USD } from '../config.js';

/**
 * The 1-second live aggregate — the ONE source of truth for numbers that move
 * every second.
 *
 * WHY THE SERVER OWNS THIS
 *
 * The diagnostic found three different denominators on one screen: the breadth
 * chips counted the whole universe (42), the depth curve counted the board rows
 * (40), and the "choppy" chip counted assets whose 24h change was exactly zero
 * (always 0) while the engine knew 16 coins were choppy. Each panel re-derived
 * "how many coins are up" from whatever rows it happened to hold.
 *
 * The server is the only place that sees every symbol's tick, so it computes
 * breadth, live sector flow and movers once, from the same universe set the
 * scanner uses, and pushes the result as one `agg` event per second. Every
 * client renders that verbatim.
 *
 * A symbol with no tick yet falls back to its 24h REST change, so the three
 * buckets ALWAYS sum to the universe size and the denominator never changes
 * between panels.
 */

interface TickValue {
  price: number;
  changePct: number;
  at: number;
}

const lastTick = new Map<string, TickValue>();

/** Record the newest tick for a symbol. Called from the SSE hub's onTick. */
export function recordTick(symbol: string, price: number, changePct: number, at = Date.now()): void {
  lastTick.set(symbol, { price, changePct, at });
}

/** Newest live value for a symbol, or null before the first tick. */
export function liveValue(symbol: string): TickValue | null {
  return lastTick.get(symbol) ?? null;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Compute the aggregate from the current universe and the newest ticks.
 * Returns null before the universe has been resolved.
 */
export function computeAggregate(now = Date.now()): LiveAggregate | null {
  const uni = currentUniverse();
  if (!uni) return null;
  return buildAggregate(uni.entries, now);
}

/**
 * Pure aggregate builder. Exported so unit tests can drive it with a hand-built
 * universe and no network, and so the denominator guarantee ("up + down + flat
 * always equals the universe size") is a test, not a comment.
 */
export function buildAggregate(
  entries: { base: string; pair: string; sector: string; ticker: { lastPrice: number; priceChangePercent: number; quoteVolume: number } }[],
  now = Date.now(),
): LiveAggregate {
  let up = 0;
  let down = 0;
  let flat = 0;
  let seen = 0;

  const sectorAcc = new Map<string, { sum: number; n: number }>();
  const movers: LiveMover[] = [];

  for (const e of entries) {
    const tick = lastTick.get(e.pair);
    const changePct = tick ? tick.changePct : e.ticker.priceChangePercent;
    const price = tick ? tick.price : e.ticker.lastPrice;
    if (tick) seen += 1;

    if (changePct > 0) up += 1;
    else if (changePct < 0) down += 1;
    else flat += 1;

    const acc = sectorAcc.get(e.sector) ?? { sum: 0, n: 0 };
    acc.sum += changePct;
    acc.n += 1;
    sectorAcc.set(e.sector, acc);

    if (e.ticker.quoteVolume >= MOVERS_MIN_VOLUME_USD) {
      movers.push({
        base: e.base,
        pair: e.pair,
        price,
        changePct: round2(changePct),
        volumeUsd: e.ticker.quoteVolume,
      });
    }
  }

  const sectors: LiveSector[] = [...sectorAcc.entries()]
    .map(([sector, v]) => ({ sector, avgChange: round2(v.sum / v.n), n: v.n }))
    .sort((a, b) => b.avgChange - a.avgChange);

  movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

  return {
    asOf: now,
    n: entries.length,
    up,
    down,
    flat,
    seen,
    sectors,
    movers: movers.slice(0, 15),
    btc: tickPair('BTCUSDT'),
    eth: tickPair('ETHUSDT'),
    venue: 'Binance',
  };
}

function tickPair(symbol: string): { price: number; changePct: number } | null {
  const t = lastTick.get(symbol);
  return t ? { price: t.price, changePct: round2(t.changePct) } : null;
}

/** Test helper: forget every recorded tick. */
export function __resetAggregate(): void {
  lastTick.clear();
}
