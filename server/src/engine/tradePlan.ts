import type {
  DerivRow, IndiaTax, LeverageCheck, Setup, Side, TradeCosts, TradePlan,
} from '../../../shared/types';
import { INDIA_TAX, RISK } from '../config.js';

/**
 * Phase 4 â€” trade plan.
 *
 * The rule that governs this file: **never invent a number.** If there is no
 * liquidity target, `rr` is 0 and `noRoom` is true. If the user has not set an
 * account size, `qty` is null. A plan with holes is more useful than a plan
 * with confident guesses.
 */

export interface PlanOptions {
  accountSize: number;
  riskPct: number;
  currency: 'INR' | 'USD';
  holdingHours: number;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  accountSize: RISK.DEFAULT_ACCOUNT,
  riskPct: RISK.DEFAULT_RISK_PCT,
  currency: 'INR',
  holdingHours: RISK.EXPECTED_HOLD_HOURS,
};

/**
 * @param opts **Deliberately has no default.** A position size computed against
 *   an account balance nobody chose is a fabricated number, and this repo's
 *   second house rule forbids exactly that. Until a caller supplies a real
 *   account size, `qty`/`riskAmount`/`rewardAmount` stay `null` and the UI shows
 *   a dash. The board therefore publishes `riskPerUnit` — which is *measured* —
 *   and never a share of an invented account.
 *
 *   Before Part XV this defaulted to `DEFAULT_PLAN_OPTIONS`, which meant every
 *   board row silently published a size sized against $100,000. Nothing in the
 *   codebase ever changed it.
 *
 * @param deriv Real derivatives, so `buildCosts` can charge real funding and
 *   real spread. Omitting it made funding 0 bps and slippage a flat default on
 *   every row, which understated costs and therefore flattered `netExpectedR`
 *   and the actionability gate that reads it.
 */
export function buildPlan(
  symbol: string,
  side: Side,
  setup: Setup,
  price: number,
  atrPct: number,
  opts?: PlanOptions,
  deriv: DerivRow | null = null,
): TradePlan {
  const atr = (atrPct / 100) * price;
  const buffer = atr * RISK.STOP_ATR_BUFFER;

  const stop = side === 'bullish'
    ? setup.invalidation - buffer
    : setup.invalidation + buffer;

  const entryLow = Math.min(setup.obLow, setup.obHigh);
  const entryHigh = Math.max(setup.obLow, setup.obHigh);
  const entryMid = (entryLow + entryHigh) / 2;

  const riskPerUnit = Math.abs(entryMid - stop);

  // Targets come from real liquidity levels only.
  //
  // `netR` is per target, not just for the last one: a plan that quotes a gross
  // R for R1 and a net R for R3 is comparing two different quantities, and the
  // whole point of quoting costs is to see the difference. Added by Fix 4 after
  // the oracle comparison found the headline `netR` covered only the furthest
  // target.
  const targets = setup.targets.map((t) => {
    const reward = Math.abs(t.price - entryMid);
    const rr = riskPerUnit > 0 ? reward / riskPerUnit : 0;
    return { label: t.label, price: t.price, rr, netR: 0 };
  });

  const noRoom = targets.length === 0;
  const rr = targets.length ? (targets[targets.length - 1].rr || 0) : 0;

  // Position sizing: risk amount divided by per-unit risk.
  //
  // `null` unless the caller supplied a real account size. The board supplies
  // none, so board rows publish `riskPerUnit` (measured) and not a fabricated
  // share of an account nobody chose. Part XV.
  const riskAmount = opts ? (opts.accountSize * opts.riskPct) / 100 : null;
  const qty = riskAmount !== null && riskPerUnit > 0 ? riskAmount / riskPerUnit : null;

  // `holdingHours` is an analytical assumption tagged `[TUNED]` in config, not a
  // number the user supplied, so it falls back to the config default when no
  // options object exists. The ACCOUNT size does not fall back, for the reason
  // above.
  const costs = buildCosts(entryMid, qty, opts ?? DEFAULT_PLAN_OPTIONS, deriv, side);
  const rewardAmount = qty !== null && targets.length
    ? Math.abs(targets[targets.length - 1].price - entryMid) * qty
    : null;

  // Net R after costs — the number that actually matters.
  //
  // Net R is gross R minus costs expressed in R. It previously read
  // `(gross R - cost R) - 1`, which subtracted a whole extra R and made every
  // plan look one R worse than it is: a 2R trade displayed as ~1R. There is no
  // reason to subtract a further R here — the 1R at risk is already the
  // denominator.
  //
  // Part XV: this used to be gated on `qty !== null`, which meant "no position
  // size" also erased "net R" — two unrelated unknowns collapsed into one. Cost
  // in R needs only the cost in bps and the per-unit risk, both of which are
  // measured without an account size. Decoupling them keeps `netExpectedR`, and
  // therefore the actionability gate, meaningful on the board.
  const costR = riskPerUnit > 0 ? (costs.totalBps / 10_000 * entryMid) / riskPerUnit : 0;
  const netR = riskPerUnit > 0 ? rr - costR : null;

  // Fill in the per-target net R now that the cost is known.
  for (const t of targets) t.netR = riskPerUnit > 0 ? t.rr - costR : 0;

  return {
    symbol,
    side,
    entryLow,
    entryHigh,
    entryMid,
    stop,
    targets,
    rr,
    noRoom,
    riskPerUnit,
    qty: qty !== null ? Math.round(qty * 1e8) / 1e8 : null,
    riskAmount,
    rewardAmount,
    costs,
    netR: netR !== null ? Math.round(netR * 100) / 100 : null,
  };
}

function buildCosts(
  price: number,
  qty: number | null,
  opts: PlanOptions,
  deriv: DerivRow | null,
  side: Side,
): TradeCosts {
  // Round trip: enter and exit are both taker.
  const feeBps = RISK.TAKER_FEE_BPS * 2;
  const feeAmount = qty !== null ? (qty * price * feeBps) / 10_000 : null;

  // Funding is charged per 8h interval on the notional.
  const intervals = opts.holdingHours / 8;
  const fundingBps = deriv ? Math.abs(deriv.funding8h) * 10_000 * intervals : 0;
  const fundingAmount = qty !== null ? (qty * price * fundingBps) / 10_000 : null;

  // Slippage from the depth snapshot when available, otherwise the default.
  const slippageBps = deriv?.depth
    ? Math.max(RISK.DEFAULT_SLIPPAGE_BPS, deriv.depth.spreadBps)
    : RISK.DEFAULT_SLIPPAGE_BPS;
  const slippageAmount = qty !== null ? (qty * price * slippageBps) / 10_000 : null;

  void side;

  // NOT rounded.
  //
  // These used to be rounded to one decimal place before being summed, which
  // meant a 0.046bps funding rate was rounded to 0 and then cost nothing. The
  // error is small in absolute terms but it is a display decision leaking into
  // a calculation, and it made buildPlan disagree with an independent oracle
  // recomputing the same figure from the same definitions. Formatting is the
  // UI's job; the engine returns the number it actually used.
  const totalBps = feeBps + fundingBps + slippageBps;

  return {
    feeBps,
    feeAmount,
    fundingBps,
    fundingAmount,
    slippageBps,
    slippageAmount,
    totalBps,
  };
}

/**
 * Leverage sanity: is the liquidation price far enough from the stop that the
 * exchange will not close the position before the thesis is disproved?
 *
 * The model, and why it changed: an isolated-margin position liquidates at
 * roughly `1 / leverage` of adverse move, so the liquidation *distance* as a
 * fraction of price is the margin fraction (leverage = 1 / marginFraction).
 * The previous version computed `liqDistance / riskFraction` using a
 * `liqDistance` that was defined as `riskFraction / impliedLeverage`, so the
 * multiple always collapsed to `1 / impliedLeverage` â€” meaning a *wider* stop
 * (higher implied leverage) reported liquidation as *closer*, which is exactly
 * backwards and would have warned on the safest setups and passed the most
 * dangerous ones.
 */
export function buildLeverageCheck(
  price: number,
  stop: number,
  marginFraction = 0.1,
): LeverageCheck {
  const riskFraction = price > 0 ? Math.abs(price - stop) / price : 0;
  if (riskFraction <= 0) {
    return { impliedLeverage: null, liqPrice: null, liqToStopMultiple: null, ok: false, note: 'no stop distance' };
  }

  // Liquidation sits `marginFraction` of price away from entry.
  const liqDistanceFraction = marginFraction;
  const multiple = liqDistanceFraction / riskFraction;
  const impliedLeverage = marginFraction > 0 ? Math.round(1 / marginFraction) : null;
  // Long (stop below entry) liquidates below, short above.
  const liqPrice = stop < price ? price * (1 - liqDistanceFraction) : price * (1 + liqDistanceFraction);
  const ok = multiple >= RISK.MIN_LIQ_TO_STOP_MULTIPLE;

  return {
    impliedLeverage,
    liqPrice,
    liqToStopMultiple: Math.round(multiple * 100) / 100,
    ok,
    note: ok
      ? `liquidation sits ${multiple.toFixed(1)}x the stop distance`
      : `liquidation only ${multiple.toFixed(1)}x from the stop â€” expect to be closed before the thesis resolves`,
  };
}

/**
 * Indian tax, as published in the research and flagged [?] everywhere:
 *   - 30% flat on crypto gains
 *   - 1% TDS per sell transfer above Rs 10,000
 *   - NO loss offset and NO carry-forward
 *
 * That last point is the one that changes behaviour: many small losing
 * trades cost more than they look, because nothing offsets them.
 */
export function buildIndiaTax(
  plan: TradePlan,
  opts: PlanOptions = DEFAULT_PLAN_OPTIONS,
  rates = INDIA_TAX,
): IndiaTax {
  const entry = plan.entryMid;
  const exit = plan.targets[0]?.price ?? plan.entryMid;
  const qty = plan.qty ?? 0;

  const grossProfit = Math.max(0, (exit - entry) * qty * (plan.side === 'bullish' ? 1 : -1));
  const fees = (plan.costs.feeAmount ?? 0) + (plan.costs.slippageAmount ?? 0) + (plan.costs.fundingAmount ?? 0);
  const netGain = Math.max(0, grossProfit - fees);

  // TDS applies to the transfer value, not the profit.
  const transferValue = exit * qty;
  const tds = transferValue > rates.TDS_THRESHOLD_INR
    ? transferValue * rates.TDS_RATE
    : 0;

  const tax = netGain * rates.CRYPTO_GAIN_RATE;
  const netAfterTax = netGain - tax - tds;

  const breakEvenMovePct = entry > 0
    ? ((fees + tds + tax) / (qty * entry)) * 100
    : 0;

  return {
    grossProfit: round2(grossProfit),
    fees: round2(fees),
    tds: round2(tds),
    tax: round2(tax),
    netAfterTax: round2(netAfterTax),
    breakEvenMovePct: round2(breakEvenMovePct),
    currency: opts.currency,
    unverifiedRates: true,
    note: rates.LOSS_OFFSET_ALLOWED
      ? ''
      : 'Losses cannot be offset against other gains â€” many small losing trades cost more than they look.',
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

