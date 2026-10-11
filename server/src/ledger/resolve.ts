import { LEDGER } from '../config.js';
import type { Outcome } from '../../../shared/types';

/**
 * Outcome resolution. Pure — no I/O, no database, no network.
 *
 * Deliberately in its own module so it can be unit-tested without pulling
 * `node:sqlite` into the test module graph. Keeping this separate from the
 * store is also the right design: this is the policy, the store is the plumbing.
 *
 * Policy, in order:
 *   1. Stop touched -> STOP. Checked FIRST inside a candle, because if one
 *      candle's range spans both the stop and a target we cannot know which
 *      came first, and assuming the target biases the ledger upward.
 *   2. Nearest target touched -> that TP. Never the furthest: a wick reaching
 *      R3 says nothing about whether R1 filled first in a continuous market.
 *   3. Otherwise extend MFE/MAE and continue.
 *   4. Past the expiry window with nothing resolved -> EXPIRED at the close.
 */

export interface ResolveInput {
  side: 'bullish' | 'bearish';
  entry: number;
  stop: number;
  targets: number[];
  riskPerUnit: number;
  /** Candles from signal creation onward, oldest first. */
  candles: { h: number; l: number; c: number; t: number }[];
  createdAt: number;
  now: number;
}

export interface Resolution {
  outcome: Outcome;
  /** Index into `candles` where it resolved, or -1. */
  index: number;
  price: number | null;
  /** Maximum favourable excursion in R. Always >= 0. */
  mfeR: number;
  /** Maximum adverse excursion in R. Always <= 0. */
  maeR: number;
  /** Realised R. Null while still open. */
  rMultiple: number | null;
}

const R_EPS = 1e-12;
const TP_LABELS = ['TP1', 'TP2', 'TP3'] as const;

export function resolveOutcome(i: ResolveInput): Resolution {
  const { side, entry, stop, targets, riskPerUnit, candles, createdAt, now } = i;

  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= R_EPS) {
    return { outcome: 'OPEN', index: -1, price: null, mfeR: 0, maeR: 0, rMultiple: null };
  }

  const sortedTargets = [...targets]
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  const up = side === 'bullish';
  let mfeR = 0;
  let maeR = 0;

  for (let idx = 0; idx < candles.length; idx++) {
    const k = candles[idx];
    if (k.t < createdAt) continue;

    const favourable = up ? k.h - entry : entry - k.l;
    const adverse = up ? entry - k.l : k.h - entry;
    mfeR = Math.max(mfeR, favourable / riskPerUnit);
    // `-0` is a real value in JS and serialises as `-0` in JSON. Normalise it
    // so a clean candle reports zero rather than negative zero.
    maeR = negZero(Math.min(maeR, -Math.max(0, adverse) / riskPerUnit));

    // 1. Stop first.
    const stopHit = up ? k.l <= stop : k.h >= stop;
    if (stopHit) {
      return { outcome: 'STOP', index: idx, price: stop, mfeR: r3(mfeR), maeR: r3(maeR), rMultiple: -1 };
    }

    // 2. Nearest target actually TRADED THROUGH by this candle.
    //
    //    The test is "is the target inside this candle's range", not "is the
    //    target below the high". If a candle opens above 104 and runs to
    //    106.5, price gapped past 104 — it never filled there — so that
    //    candle credits TP2, not TP1. Checking only the high silently
    //    over-credited the nearest target on every gap.
    for (let t = 0; t < sortedTargets.length; t++) {
      const price = sortedTargets[t];
      const inRange = k.l <= price && k.h >= price;
      if (inRange) {
        const r = (up ? price - entry : entry - price) / riskPerUnit;
        return {
          outcome: TP_LABELS[t] ?? 'TP3',
          index: idx,
          price,
          mfeR: r3(mfeR),
          maeR: r3(maeR),
          rMultiple: r3(r),
        };
      }
    }
  }

  // 3. Expiry.
  if (now - createdAt >= LEDGER.EXPIRY_HOURS * 3600_000) {
    const last = candles[candles.length - 1];
    const close = last?.c ?? entry;
    return {
      outcome: 'EXPIRED',
      index: candles.length - 1,
      price: close,
      mfeR: r3(mfeR),
      maeR: r3(maeR),
      rMultiple: r3((up ? close - entry : entry - close) / riskPerUnit),
    };
  }

  return { outcome: 'OPEN', index: -1, price: null, mfeR: r3(mfeR), maeR: r3(maeR), rMultiple: null };
}

function r3(v: number): number {
  return negZero(Math.round(v * 1000) / 1000);
}

/** Collapses -0 to 0. `Object.is(-0, 0)` is false and JSON keeps the sign. */
function negZero(v: number): number {
  return v === 0 ? 0 : v;
}
