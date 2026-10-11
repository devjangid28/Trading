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

export function buildPlan(
  symbol: string,
  side: Side,
  setup: Setup,
  price: number,
  atrPct: number,
  opts: PlanOptions = DEFAULT_PLAN_OPTIONS,
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
  const targets = setup.targets.map((t) => {
    const reward = Math.abs(t.price - entryMid);
    return {
      label: t.label,
      price: t.price,
      rr: riskPerUnit > 0 ? reward / riskPerUnit : 0,
    };
  });

  const noRoom = targets.length === 0;
  const rr = targets.length ? (targets[targets.length - 1].rr || 0) : 0;

  // Position sizing: risk amount divided by per-unit risk.
  const riskAmount = (opts.accountSize * opts.riskPct) / 100;
  const qty = riskPerUnit > 0 ? riskAmount / riskPerUnit : null;

  const costs = buildCosts(entryMid, qty, opts, deriv, side);
  const rewardAmount = qty !== null && targets.length
    ? Math.abs(targets[targets.length - 1].price - entryMid) * qty
    : null;

  // Net R after costs â€” the number that actually matters.
  //
  // Net R is gross R minus costs expressed in R. It previously read
  // `(gross R - cost R) - 1`, which subtracted a whole extra R and made every
  // plan look one R worse than it is: a 2R trade displayed as ~1R. There is no
  // reason to subtract a further R here â€” the 1R at risk is already the
  // denominator.
  const costR = (costs.totalBps / 10_000 * entryMid) / riskPerUnit;
  const netR = qty !== null && riskPerUnit > 0 ? rr - costR : null;

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

  return {
    feeBps,
    feeAmount,
    fundingBps: Math.round(fundingBps * 10) / 10,
    fundingAmount,
    slippageBps,
    slippageAmount,
    totalBps: Math.round((feeBps + fundingBps + slippageBps) * 10) / 10,
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

