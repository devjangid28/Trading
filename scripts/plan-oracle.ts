/**
 * FIX 4 — an independent oracle for trade-plan arithmetic.
 *
 * WHY A SECOND IMPLEMENTATION
 *
 * Position sizing, net R, leverage, liquidation price and tax are where real
 * money is decided, and two serious bugs were already found in that code by
 * inspection rather than by a test. The existing tests assert against the same
 * implementation they exercise, so they would both have passed if that
 * implementation were wrong in the same way twice.
 *
 * This file recomputes every figure from the DEFINITIONS, and deliberately does
 * NOT import anything from `server/src/engine/tradePlan.ts`. If the two agree
 * across thousands of randomised long and short plans, that is two independent
 * derivations converging. If they disagree, something is wrong and the
 * comparison test fails loudly.
 *
 * The definitions used, stated plainly:
 *
 *   riskAmount    = accountSize * riskPct / 100
 *   riskPerUnit   = |entry - stop|                       (per one unit of the base asset)
 *   qty           = riskAmount / riskPerUnit             (risk exactly riskAmount at the stop)
 *   notional      = qty * entry
 *   leverage      = notional / accountSize
 *   reward(k)     = |target_k - entry|
 *   R(k)          = reward(k) / riskPerUnit
 *   costs (bps)   = 2 * takerFee + |funding8h| * 10000 * (holdHours / 8)
 *                   + max(defaultSlippage, spread)
 *   costR         = (costBps / 10000 * entry) / riskPerUnit
 *   netR(k)       = R(k) - costR
 *
 *   Liquidation. With isolated margin and leverage L, the margin fraction is
 *   1/L, so liquidation sits 1/L of entry away from it in the adverse
 *   direction. That is the definition; `liqToStopMultiple` is
 *   (1/L) / (|entry - stop| / entry).
 *
 *   India tax. Gains are taxed at a flat rate on the PROFIT; TDS is 1% of the
 *   SELL TRANSFER VALUE above a threshold; losses produce no credit at all.
 */

export interface OracleInput {
  side: 'bullish' | 'bearish';
  entry: number;
  stop: number;
  targetPrices: number[];
  accountSize: number;
  riskPct: number;
  takerFeeBps: number;
  funding8h: number;
  holdHours: number;
  slippageBps: number;
  /** Optional realistic spread from a depth snapshot; else slippageBps is used. */
  spreadBps?: number;
  /** TradingView-style gross leverage requested by the user. */
  leverage: number;
}

export interface OraclePlan {
  entry: number;
  stop: number;
  dir: 1 | -1;
  riskPerUnit: number;
  riskAmount: number;
  qty: number | null;
  notional: number | null;
  actualLeverage: number | null;
  grossR: number[];
  costBps: number;
  costR: number;
  netR: number[];
  feeBps: number;
  fundingBps: number;
  slippageBps: number;
  noRoom: boolean;
  liqPrice: number | null;
  liqDistancePct: number | null;
  stopDistancePct: number | null;
  liqToStopMultiple: number | null;
  /** true when liquidation is at least 2x the stop distance away. */
  leverageCheckOk: boolean;
}

export function oraclePlan(i: OracleInput): OraclePlan {
  const dir: 1 | -1 = i.side === 'bullish' ? 1 : -1;
  const riskPerUnit = Math.abs(i.entry - i.stop);
  const riskAmount = (i.accountSize * i.riskPct) / 100;
  const qty = riskPerUnit > 0 ? riskAmount / riskPerUnit : null;
  const notional = qty !== null ? qty * i.entry : null;
  const actualLeverage = notional !== null && i.accountSize > 0 ? notional / i.accountSize : null;

  const feeBps = i.takerFeeBps * 2; // enter and exit, both taker
  const fundingBps = Math.abs(i.funding8h) * 10_000 * (i.holdHours / 8);
  const slippageBps = Math.max(i.slippageBps, i.spreadBps ?? 0);
  const costBps = feeBps + fundingBps + slippageBps;
  const costR = riskPerUnit > 0 ? (costBps / 10_000 * i.entry) / riskPerUnit : 0;

  const grossR = i.targetPrices.map((t) => Math.abs(t - i.entry) / riskPerUnit);
  const netR = grossR.map((r) => r - costR);

  const marginFraction = i.leverage > 0 ? 1 / i.leverage : 1;
  const liqPrice = i.entry * (1 - dir * marginFraction);
  const liqDistancePct = marginFraction * 100;
  const stopDistancePct = i.entry > 0 ? (riskPerUnit / i.entry) * 100 : 0;
  const liqToStopMultiple = stopDistancePct > 0 ? liqDistancePct / stopDistancePct : null;

  return {
    entry: i.entry,
    stop: i.stop,
    dir,
    riskPerUnit,
    riskAmount,
    qty,
    notional,
    actualLeverage,
    grossR,
    costBps,
    costR,
    netR,
    feeBps,
    fundingBps,
    slippageBps,
    noRoom: i.targetPrices.length === 0,
    liqPrice,
    liqDistancePct,
    stopDistancePct,
    liqToStopMultiple,
    leverageCheckOk: (liqToStopMultiple ?? 0) >= 2,
  };
}

export interface IndiaTaxInput {
  side: 'bullish' | 'bearish';
  entry: number;
  exitPrice: number;
  qty: number;
  feeAmount: number;
  slippageAmount: number;
  fundingAmount: number;
  cryptoGainRate: number;
  tdsRate: number;
  tdsThreshold: number;
}

export interface OracleTax {
  grossProfit: number;
  netGain: number;
  tax: number;
  tds: number;
  netAfterTax: number;
  /** Always >= 0. A losing trade must never produce a negative tax figure. */
  hasCredit: boolean;
}

/**
 * Indian tax, recomputed from the rules rather than from `buildIndiaTax`.
 *
 * The property that matters and is easy to get wrong: a loss produces NO tax
 * credit. `max(0, gross)` on the profit side, and no negative anywhere, because
 * India allows no loss offset for virtual-asset gains.
 */
export function oracleIndiaTax(t: IndiaTaxInput): OracleTax {
  const dir: 1 | -1 = t.side === 'bullish' ? 1 : -1;
  const gross = (t.exitPrice - t.entry) * t.qty * dir;
  const fees = t.feeAmount + t.slippageAmount + t.fundingAmount;
  // Profit is floored at zero: a loss is a loss, not a negative gain to tax.
  const netGain = Math.max(0, gross - fees);
  const tax = netGain * t.cryptoGainRate;

  // TDS is on the transfer value (sell value), not on the profit.
  const sellValue = t.exitPrice * t.qty;
  const tds = sellValue > t.tdsThreshold ? sellValue * t.tdsRate : 0;

  return {
    grossProfit: Math.max(0, gross),
    netGain,
    tax,
    tds,
    netAfterTax: netGain - tax - tds,
    hasCredit: tax < 0 || tds < 0,
  };
}

/** Deterministic PRNG, so a failing case is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}