/**
 * The geometry of a trade, and how to move it.
 *
 * "Geometry" means the shape of a trade: how far the stop is, how far each
 * target is, which side it is on. It is deliberately separate from the entry
 * price, because the random-entry baseline needs to take the SAME geometry and
 * plant it somewhere else in time.
 *
 * Pure. No I/O, no clock, no randomness that is not seeded.
 */

import { resolveOutcome, type ResolveInput, type Resolution } from '../../ledger/resolve.js';

export interface Geometry {
  side: 'bullish' | 'bearish';
  /** The price the trade was entered at. */
  entry: number;
  /** The stop level. */
  stop: number;
  /** Target levels, in the plan's own order. */
  targets: number[];
  /** Per-unit risk: the distance from the entry to the stop. */
  riskPerUnit: number;
}

/**
 * Move the geometry to a new entry price, preserving every distance.
 *
 * The stop keeps the same distance from the entry, and each target keeps the
 * same distance. So a trade with a 0.3% stop and a 1.5% target (5 R) stays a
 * 5 R trade wherever it is entered. That is what "the same stop/target
 * geometry" has to mean for a baseline to be comparable.
 */
export function reanchor(g: Geometry, newEntry: number): Geometry {
  const dir = g.side === 'bullish' ? 1 : -1;
  return {
    side: g.side,
    entry: newEntry,
    stop: newEntry - dir * g.riskPerUnit,
    targets: g.targets.map((t) => newEntry + (t - g.entry)),
    riskPerUnit: g.riskPerUnit,
  };
}

/** The R distances of a geometry's targets, relative to its entry. */
export function targetRs(g: Geometry): number[] {
  const dir = g.side === 'bullish' ? 1 : -1;
  if (g.riskPerUnit <= 0) return [];
  return g.targets.map((t) => (dir * (t - g.entry)) / g.riskPerUnit);
}

/** A candle in the shape the resolver wants. */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/**
 * Resolve a geometry over a candle series, from `fromTs` for `lifeMs`.
 *
 * `now` is the end of the trade's life, so an expiry is marked at the end of
 * that life rather than at the end of the data.
 */
export function resolveGeometry(
  g: Geometry,
  candles: Bar[],
  fromTs: number,
  lifeMs: number,
): Resolution {
  const input: ResolveInput = {
    side: g.side,
    entry: g.entry,
    stop: g.stop,
    targets: g.targets,
    riskPerUnit: g.riskPerUnit,
    candles: candles.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c })),
    createdAt: fromTs,
    now: fromTs + lifeMs,
  };
  return resolveOutcome(input);
}

/**
 * A seeded xorshift32.
 *
 * Every random draw in this engine is seeded, so a baseline printed twice
 * prints the same numbers. A baseline that moved between runs could not be
 * compared with anything.
 */
export function makeRandom(seed: number): () => number {
  let s = (seed >>> 0) || 0x5eed;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };
}
