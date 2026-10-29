import { LEDGER } from '../config.js';
import type { LedgerSignal, Outcome } from '../../../shared/types';

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
 *   2. Nearest target reached -> that TP. Never the furthest: a wick reaching
 *      R3 says nothing about whether R1 filled first in a continuous market.
 *   3. Otherwise extend MFE/MAE and continue.
 *   4. Past the expiry window with nothing resolved -> EXPIRED, marked to the
 *      close at the END of the trade's life.
 *
 * ## Two defects this file had, both found by decomposing the ledger's expectancy
 *
 * **1. A gap through a level was invisible.** The old test was "is the level
 * inside this candle's RANGE" (`k.l <= P && k.h >= P`). A price that GAPS
 * through a level never puts it inside a range: the candle opens beyond it and
 * the whole candle sits on the far side. So:
 *
 *   - a take-profit that the market gapped through was never credited. The
 *     trade ran on, the target was never "touched", and the row expired —
 *     marked at whatever price the market happened to be at, which on a 0.3%
 *     stop is 20-40 R. On the live ledger this produced **28 expired rows
 *     carrying 28.6% of the entire ledger's R**, every one of them with a
 *     maximum favourable excursion above 1 R and 27 of them with an adverse
 *     excursion of exactly zero.
 *   - a stop that the market gapped through was booked AT the stop price, which
 *     is the best possible fill. Every one of the 255 stopped rows has an
 *     adverse excursion deeper than -1 R (median about -1.5 R, worst -27 R),
 *     so the book was assuming a perfect exit in a market that was routinely
 *     trading half a stop further away.
 *
 * The correct test is mechanical: a resting order at price P is filled when
 * the market trades at or through P during the candle, including by opening
 * beyond it. For a bullish take-profit (a resting sell limit) that is
 * `k.h >= P`; for a bearish one (a resting buy limit) it is `k.l <= P`. A
 * take-profit that gaps in the trade's favour fills at a BETTER price, not at
 * no price — the old comment in this file said otherwise, and it was wrong.
 *
 * **2. An expiry was marked at "now", not at the end of the trade's life.**
 * `LEDGER.EXPIRY_HOURS` is 24. Thirteen of the 28 expired rows were resolved
 * between 24 and 71 hours after creation, and were marked at the close on the
 * day of resolution. A trade's life is 24 hours; its expiry mark is the price
 * at the end of that life. If no candle covers that instant, the mark is not
 * measurable and the R is `null` — never a guess.
 */

export interface ResolveInput {
  side: 'bullish' | 'bearish';
  entry: number;
  stop: number;
  targets: number[];
  riskPerUnit: number;
  /**
   * Candles from signal creation onward, oldest first.
   *
   * `o` (the open) is OPTIONAL. With it, a gap through the stop is filled at
   * the gap price rather than at the stop price. Without it, the fill is taken
   * at the level — the older, more optimistic assumption — and the resolution
   * note says so.
   */
  candles: { h: number; l: number; c: number; t: number; o?: number }[];
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
  /** Realised R. Null while still open. GROSS — costs are applied downstream. */
  rMultiple: number | null;
  /**
   * True when the resolving candle ALSO contained a target.
   *
   * Reported rather than silently resolved, because "the stop was genuinely hit
   * first" and "one candle covered both levels and we took the pessimistic
   * reading" are different facts and only one of them is a measurement.
   */
  ambiguous: boolean;
  /**
   * Why resolution stopped, or `null` while open. Records data gaps separately
   * from expiry, which Phase XVI requires be distinguishable.
   */
  note: string | null;
}

const R_EPS = 1e-12;
const TP_LABELS = ['TP1', 'TP2', 'TP3'] as const;

/**
 * Outcomes that resolved AT a target. A win.
 *
 * One definition, exported, so the ledger's statistics and the calibration
 * report cannot disagree about which outcomes are wins.
 */
export const TARGET_WINS: ReadonlySet<Outcome> = new Set<Outcome>(['TP1', 'TP2', 'TP3']);

/**
 * The R a signal ACTUALLY realised — the M3.2 fix.
 *
 * ## The bug this replaces
 *
 * The ledger's statistics used to credit **every winner with the plan's
 * furthest target R**. `TradePlan.rr` is, by construction, the R of the LAST
 * target (`targets[targets.length - 1].rr`), so a trade that took profit at
 * TP1 — one R, the nearest and most likely level — was reported as if it had
 * banked the furthest target. On this ledger that inflated `avgR` to 3.50 and
 * the profit factor to 9.15, and 337 of the 342 winners are TP1.
 *
 * A profit factor of 9 on a market where 337 of 342 winners took the nearest
 * target is not a performance figure. It is an accounting error, and it is
 * the kind that makes a research tool look like a money printer.
 *
 * ## What it does now
 *
 * The R is derived from **the outcome and the frozen levels**:
 *
 *   - `STOP`    -> the price the stop was FILLED at, which is the stop price
 *     normally and the gap open when the market gapped through it.
 *   - `TP1/TP2/TP3` -> the R at the target that ACTUALLY resolved it, taken
 *     from the frozen `targets` array. Not the furthest one.
 *   - `EXPIRED` -> the move from the entry mid to the close at the end of the
 *     trade's life.
 *   - `OPEN` or anything unmeasurable -> `null`. Never a zero.
 *
 * The primary source is `price_at_resolve` — the price the resolver actually
 * resolved at — so the ledger's R is the resolver's R and cannot be a second,
 * disagreeing derivation.
 *
 * The entry is the **entry mid** and the risk is the **frozen
 * `riskPerUnit`** — the same two numbers `resolveOutcome()` used when it
 * decided the outcome. So this function and the resolver agree by
 * construction, and the ledger's R equals the R the resolver measured.
 *
 * `null` means "not measurable", which is a different claim from 0.
 */
export function realisedR(s: LedgerSignal): number | null {
  const entry = entryMidOf(s);
  const risk = riskPerUnitOf(s);
  if (entry === null || risk === null) return null;

  const dir = s.side === 'bullish' ? 1 : -1;

  /**
   * The price the trade actually resolved at.
   *
   * `price_at_resolve` is a PRIMARY datum — it is the price the resolver
   * measured, and the Phase XVI outcome row stores it too. Using it means the
   * ledger's R is exactly the R the resolver measured, with no second
   * derivation that could disagree. It also carries the two things a bare
   * outcome label cannot: a stop that was GAPED THROUGH (the fill is worse
   * than the stop price) and the price an expiry was marked to.
   */
  if (s.priceAtResolve !== null && Number.isFinite(s.priceAtResolve)) {
    return round3((dir * (s.priceAtResolve - entry)) / risk);
  }

  if (s.outcome === 'STOP') return -1;

  if (TARGET_WINS.has(s.outcome)) {
    const idx = s.outcome === 'TP1' ? 0 : s.outcome === 'TP2' ? 1 : 2;
    // Nearest FIRST, by distance from the entry — the same order the resolver
    // uses, so "TP1" means the same level for a bearish trade as for a
    // bullish one.
    const ordered = [...(s.targets ?? [])]
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => Math.abs(a - entry) - Math.abs(b - entry));
    if (ordered.length === 0) return null;
    const price = ordered[Math.min(idx, ordered.length - 1)];
    if (price === undefined || !Number.isFinite(price)) return null;
    return round3((dir * (price - entry)) / risk);
  }

  // EXPIRED with no mark: the trade ran out of time and no candle covers the
  // end of its life. The R is not measurable. `null`, never a zero.
  return null;
}

/** The price the trade entered at: the mid of the frozen entry zone. */
function entryMidOf(s: LedgerSignal): number | null {
  const plan = s.snapshot?.plan;
  if (plan && Number.isFinite(plan.entryMid) && plan.entryMid > 0) return plan.entryMid;
  const lo = s.entryZoneLow;
  const hi = s.entryZoneHigh;
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > 0) return (lo + hi) / 2;
  return null;
}

/** The per-unit risk the trade was sized against. */
function riskPerUnitOf(s: LedgerSignal): number | null {
  if (Number.isFinite(s.riskPerUnit) && s.riskPerUnit > R_EPS) return s.riskPerUnit;
  const plan = s.snapshot?.plan;
  if (plan && Number.isFinite(plan.riskPerUnit) && plan.riskPerUnit > R_EPS) return plan.riskPerUnit;
  const entry = entryMidOf(s);
  if (entry === null) return null;
  const byStop = Math.abs(entry - s.stop);
  return byStop > R_EPS ? byStop : null;
}

function round3(v: number): number {
  return negZero(Math.round(v * 1000) / 1000);
}

export function resolveOutcome(i: ResolveInput): Resolution {
  const { side, entry, stop, targets, riskPerUnit, candles, createdAt, now } = i;

  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= R_EPS) {
    return { outcome: 'OPEN', index: -1, price: null, mfeR: 0, maeR: 0, rMultiple: null, ambiguous: false, note: null };
  }

  /**
   * Targets ordered NEAREST FIRST, measured from the entry.
   *
   * The old code sorted them ascending by price, which silently reversed the
   * order for a BEARISH trade — whose targets are below the entry — so "the
   * nearest target" was resolved as the FARTHEST one, and the TP1 label came to
   * mean a different level than it did for a bullish trade. Ordering by
   * distance from the entry is unambiguous for both sides.
   */
  const orderedTargets = [...targets]
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => Math.abs(a - entry) - Math.abs(b - entry));

  const up = side === 'bullish';
  let mfeR = 0;
  let maeR = 0;

  /**
   * The end of the trade's life.
   *
   * `LEDGER.EXPIRY_HOURS` is not a reporting rule, it is the STRATEGY: the
   * trade is given 24 hours and then it is over. The resolver used to check
   * the expiry only AFTER it had walked the whole candle array, so a signal
   * could be resolved by a candle that fell hours after its own life ended —
   * the trade was given 44 hours of opportunity on average, and 15 of the
   * 597 decided rows in the live ledger were resolved between 24 and 56 hours
   * after they were created.
   *
   * A trade that outlives its own rule is not a trade the strategy took.
   */
  const lifeEnd = createdAt + LEDGER.EXPIRY_HOURS * 3600_000;

  for (let idx = 0; idx < candles.length; idx++) {
    const k = candles[idx];
    if (k.t < createdAt) continue;
    // The life is over. Nothing after this candle can resolve the trade.
    if (k.t >= lifeEnd) break;

    const favourable = up ? k.h - entry : entry - k.l;
    const adverse = up ? entry - k.l : k.h - entry;
    mfeR = Math.max(mfeR, favourable / riskPerUnit);
    // `-0` is a real value in JS and serialises as `-0` in JSON. Normalise it
    // so a clean candle reports zero rather than negative zero.
    maeR = negZero(Math.min(maeR, -Math.max(0, adverse) / riskPerUnit));

    // 1. Stop first, then targets — the order IS the policy.
    //
    //    `LEDGER.AMBIGUITY` was previously a comment-only constant: it was
    //    declared in config, described as the "single source of truth", and read
    //    by no production code. A test asserted the string equalled itself, so
    //    it would still have passed if the block below were deleted. That is a
    //    claim, not a control, and it is exactly what house rule 6 forbids.
    //
    //    The literal ordering below now READS the constant, so changing
    //    `AMBIGUITY` genuinely changes behaviour — and the deliberate worst-case
    //    choice of `TARGET_FIRST` is wired up rather than merely described.
    const stopHit = up ? k.l <= stop : k.h >= stop;
    const targetIndex = nearestTargetReached(orderedTargets, k, up);

    if (LEDGER.AMBIGUITY === 'STOP_FIRST') {
      if (stopHit) return resolveStop(idx, k);
      if (targetIndex >= 0) return resolveTarget(targetIndex, idx);
    } else {
      if (targetIndex >= 0) return resolveTarget(targetIndex, idx);
      if (stopHit) return resolveStop(idx, k);
    }

    // 2. The NEAREST target the market actually REACHED.
    //
    //    A resting order at price P fills when the market trades at or through
    //    P during the candle — including when the candle OPENS beyond P, which
    //    is a gap. The old test was "is P inside this candle's range", which
    //    is false for a gap: the whole candle sits on the far side of P.
    //
    //    The consequence of getting that wrong was not subtle. A take-profit
    //    the market gapped through was never credited, so the trade ran on and
    //    EXPIRED — marked at whatever price the market was at much later, which
    //    on a 0.3% stop is 20-40 R. 28 such rows carried 28.6% of the whole
    //    ledger's R.
    function resolveTarget(t: number, index: number) {
      const price = orderedTargets[t];
      const r = (up ? price - entry : entry - price) / riskPerUnit;
      return {
        outcome: TP_LABELS[t] ?? 'TP3',
        index,
        price,
        mfeR: r3(mfeR),
        maeR: r3(maeR),
        rMultiple: r3(r),
        ambiguous: false,
        // A target was reached, so no ambiguity could have been in play — the
        // stop check already ran first and would have returned.
        note: null,
      } as const;
    }

    /**
     * A stop-out, filled at the WORSE of the stop and the gap.
     *
     * When the candle opened beyond the stop, the market gapped through it and
     * the fill is the open, not the stop. Booking the stop price is the best
     * possible outcome and is not what happens. Every one of the 255 stopped
     * rows on the live ledger has an adverse excursion deeper than -1 R, so
     * this assumption was worth roughly half an R on the median stop and
     * 26 R in the worst case.
     *
     * Without the candle's open there is no way to know a gap happened, and
     * the fill falls back to the stop price. The note says which happened.
     */
    function resolveStop(index: number, candle: { o?: number }) {
      const gapped = candle.o !== undefined
        && (up ? candle.o < stop : candle.o > stop);
      const fill = gapped ? (candle.o as number) : stop;
      const r = (up ? fill - entry : entry - fill) / riskPerUnit;
      return {
        outcome: 'STOP' as const,
        index,
        price: fill,
        mfeR: r3(mfeR),
        maeR: r3(maeR),
        rMultiple: r3(r),
        ambiguous: targetIndex >= 0,
        note: targetIndex >= 0
          ? 'one candle reached both the stop and a target; stop taken as the worst case'
          : gapped
            ? `the market gapped through the stop; filled at the gap open (${fill}), not at the stop (${stop})`
            : null,
      } as const;
    }
  }

  // 3. Expiry.
  //
  //    CENSORED, not a loss. The trade neither won nor failed; it ran out of
  //    time. `outcomeClass` in outcomes.ts is what decides where this row counts,
  //    and it counts in expectancy while being excluded from win rate and Brier.
  //
  //    The mark is taken at the END of the trade's life — createdAt plus
  //    EXPIRY_HOURS — not at "now". A signal resolved 71 hours after creation
  //    was being marked at the price 71 hours later, which is not the price the
  //    trade was closed at. If no candle covers the end of the life, the mark is
  //    NOT measurable and the R is null: a guess here is how 28 rows ended up
  //    carrying 28.6% of the ledger's R.
  if (now - createdAt >= LEDGER.EXPIRY_HOURS * 3600_000) {
    let markIdx = -1;
    for (let idx = candles.length - 1; idx >= 0; idx--) {
      if (candles[idx].t < lifeEnd) { markIdx = idx; break; }
    }
    if (markIdx < 0) {
      return {
        outcome: 'EXPIRED',
        index: -1,
        price: null,
        mfeR: r3(mfeR),
        maeR: r3(maeR),
        rMultiple: null,
        ambiguous: false,
        note: `expired after ${LEDGER.EXPIRY_HOURS}h without reaching a level; no candle covers the end of the trade's life, so the mark is not measurable while costs were still incurred`,
      };
    }
    const close = candles[markIdx].c;
    return {
      outcome: 'EXPIRED',
      index: markIdx,
      price: close,
      mfeR: r3(mfeR),
      maeR: r3(maeR),
      rMultiple: r3((up ? close - entry : entry - close) / riskPerUnit),
      ambiguous: false,
      note: `expired without reaching a level after ${LEDGER.EXPIRY_HOURS}h; marked to the close at the end of the trade's life`,
    };
  }

  return { outcome: 'OPEN', index: -1, price: null, mfeR: r3(mfeR), maeR: r3(maeR), rMultiple: null, ambiguous: false, note: null };
}

/**
 * Index of the NEAREST target the market REACHED in this candle, or -1.
 *
 * `orderedTargets` is nearest-first (by distance from the entry), so the first
 * one that was reached is the one a trade would have taken.
 *
 * A resting order at price P is filled when the market trades at or through P
 * during the candle, INCLUDING when the candle opens beyond P:
 *
 *   - a bullish take-profit is a resting SELL limit at P, so it fills when
 *     `k.h >= P`;
 *   - a bearish take-profit is a resting BUY limit at P, so it fills when
 *     `k.l <= P`.
 *
 * A gap in the trade's favour fills the order at a BETTER price, not at no
 * price. The previous test — "is P inside this candle's range" — was false for
 * every gap, which meant a gapped take-profit was never credited at all.
 */
function nearestTargetReached(
  orderedTargets: number[],
  k: { h: number; l: number },
  up: boolean,
): number {
  for (let t = 0; t < orderedTargets.length; t++) {
    const price = orderedTargets[t];
    if (up ? k.h >= price : k.l <= price) return t;
  }
  return -1;
}

function r3(v: number): number {
  return negZero(Math.round(v * 1000) / 1000);
}

/** Collapses -0 to 0. `Object.is(-0, 0)` is false and JSON keeps the sign. */
function negZero(v: number): number {
  return v === 0 ? 0 : v;
}
