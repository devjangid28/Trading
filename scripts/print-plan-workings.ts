/**
 * FIX 4 — three worked trade plans, printed with the arithmetic shown.
 *
 * Intended to be checked BY HAND. Every figure is printed with the expression
 * that produced it, and every figure is computed twice: once by `buildPlan`
 * (the production code the UI will render) and once by the independent oracle
 * in `scripts/plan-oracle.ts`. A disagreement stops the script.
 *
 * Run: npx tsx scripts/print-plan-workings.ts
 */
import { buildPlan, buildLeverageCheck, buildIndiaTax, DEFAULT_PLAN_OPTIONS } from '../server/src/engine/tradePlan.js';
import { INDIA_TAX, RISK } from '../server/src/config.js';
import { oraclePlan, oracleIndiaTax } from './plan-oracle.js';
import type { Setup, Side } from '../shared/types.js';

const f = (v: number, d = 4): string =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : String(v);
const i = (v: number): string => Math.round(v).toLocaleString('en-US');
const pct = (v: number, d = 3): string => `${v >= 0 ? '+' : ''}${f(v, d)}%`;
const money = (v: number): string => `₹${i(v)}`;

function setup(side: Side, obLow: number, obHigh: number, invalidation: number, targets: number[]): Setup {
  return {
    side, obTime: 1_767_000_000_000, obHigh, obLow, z: (obLow + obHigh) / 2, invalidation,
    targets: targets.map((price, n) => ({
      label: n === 0 ? 'R1' : n === 1 ? 'R2' : 'R3',
      price, kind: 'pivot' as const, strength: 1, pooled: n === 0,
    })),
    context: [], rr: 0, displacement: 1.4, fvg: true, violated: false, ageMinutes: 42,
    previous: [], retest: 'in-zone' as const, distanceAtr: 0.3,
    htf: { aligned: true, note: '5m zone inside a same-side 1h zone', zones: [] } as unknown as Setup['htf'],
  };
}

let failures = 0;
function cross(label: string, a: number, b: number, tol = 0.01): void {
  const ok = Math.abs(a - b) <= tol;
  if (!ok) failures++;
  console.log(`      ${ok ? '==' : '!! MISMATCH'} ${label.padEnd(30)} buildPlan=${f(a, 6)}  oracle=${f(b, 6)}`);
}

interface CaseSpec {
  title: string;
  symbol: string;
  side: Side;
  obLow: number;
  obHigh: number;
  invalidation: number;
  targets: number[];
  price: number;
  atrPct: number;
  funding8h: number;
  spreadBps: number;
  leverage: number;
  accountSize: number;
  riskPct: number;
  holdHours: number;
  note: string;
}

const CASES: CaseSpec[] = [
  {
    title: 'CASE 1 — LONG, three liquidity targets',
    symbol: 'BTCUSDT', side: 'bullish',
    obLow: 82_940, obHigh: 83_010, invalidation: 82_880,
    targets: [83_520, 84_180, 85_400],
    price: 83_100, atrPct: 0.72, funding8h: 0.00000457, spreadBps: 2.1,
    leverage: 10, accountSize: 500_000, riskPct: 1, holdHours: 8,
    note: 'Full-size plan with three real liquidity levels ahead.',
  },
  {
    title: 'CASE 2 — SHORT, crowded funding against the position',
    symbol: 'ETHUSDT', side: 'bearish',
    obLow: 3_012, obHigh: 3_034, invalidation: 3_046,
    targets: [2_960, 2_890, 2_810],
    price: 3_000, atrPct: 1.05, funding8h: -0.00031, spreadBps: 3.4,
    leverage: 8, accountSize: 250_000, riskPct: 0.75, holdHours: 16,
    note: 'Negative funding means a short RECEIVES; the cost model takes |funding|, so it is shown as a drag.',
  },
  {
    title: 'CASE 3 — NO LIQUIDITY TARGET (R:R shows "-")',
    symbol: 'LUMIAUSDT', side: 'bullish',
    obLow: 0.10980, obHigh: 0.11020, invalidation: 0.10940,
    targets: [],
    price: 0.11050, atrPct: 3.1, funding8h: 0, spreadBps: 12,
    leverage: 5, accountSize: 100_000, riskPct: 0.5, holdHours: 4,
    note: 'No pivot above, so there is no R:R. The plan still sizes correctly — it just has no reward leg.',
  },
];

console.log('='.repeat(80));
console.log('FIX 4 — TRADE PLAN WORKINGS (verify these by hand)');
console.log('='.repeat(80));
console.log(`account defaults overridden per case; risk % and holding time shown per case`);
console.log(`fee ${RISK.TAKER_FEE_BPS}bps taker per side (round trip x2), India tax 30% + 1% TDS above ₹${i(INDIA_TAX.TDS_THRESHOLD_INR)}`);

for (const c of CASES) {
  const s = setup(c.side, c.obLow, c.obHigh, c.invalidation, c.targets);
  const opts = {
    accountSize: c.accountSize, riskPct: c.riskPct, currency: 'INR' as const, holdingHours: c.holdHours,
  };
  const deriv = { funding8h: c.funding8h, depth: { spreadBps: c.spreadBps } } as never;

  const plan = buildPlan(c.symbol, c.side, s, c.price, c.atrPct, opts, deriv);
  const lev = buildLeverageCheck(plan.entryMid, plan.stop, 1 / c.leverage);
  const tax = buildIndiaTax(plan, opts, INDIA_TAX);

  const o = oraclePlan({
    side: c.side,
    entry: plan.entryMid,
    stop: plan.stop,
    targetPrices: plan.targets.map((t) => t.price),
    accountSize: c.accountSize, riskPct: c.riskPct,
    takerFeeBps: RISK.TAKER_FEE_BPS, funding8h: c.funding8h, holdHours: c.holdHours,
    slippageBps: RISK.DEFAULT_SLIPPAGE_BPS, spreadBps: c.spreadBps, leverage: c.leverage,
  });

  const stopDistPct = ((plan.entryMid - plan.stop) / plan.entryMid) * 100;
  const notional = plan.qty !== null ? plan.qty * plan.entryMid : null;
  const impliedLev = notional !== null ? notional / c.accountSize : null;

  console.log('');
  console.log('-'.repeat(80));
  console.log(c.title);
  console.log(`  ${c.note}`);
  console.log('-'.repeat(80));
  console.log(`  side                 ${c.side.toUpperCase()}`);
  console.log(`  ATR%                 ${f(c.atrPct, 2)}%`);
  console.log(`  1) account size      ${money(c.accountSize)}`);
  console.log(`  2) risk %            ${f(c.riskPct, 2)}%`);
  console.log(`  3) risk amount       ${money(c.accountSize)} x ${f(c.riskPct, 2)}/100 = ${money(plan.riskAmount ?? 0)}`);
  console.log(`  4) order-block       ${f(s.obLow, 5)} .. ${f(s.obHigh, 5)}`);
  console.log(`  5) entry (mid)       (${f(s.obLow, 5)} + ${f(s.obHigh, 5)}) / 2 = ${f(plan.entryMid, 6)}`);
  console.log(`  6) invalidation      ${f(c.invalidation, 5)}`);
  console.log(`     ATR buffer        ${f(c.price * (c.atrPct / 100), 6)} x ${RISK.STOP_ATR_BUFFER} = ${f(c.price * (c.atrPct / 100) * RISK.STOP_ATR_BUFFER, 6)}`);
  console.log(`  7) stop              invalidation ${c.side === 'bullish' ? '-' : '+'} buffer = ${f(plan.stop, 6)}`);
  console.log(`  8) risk per unit     |${f(plan.entryMid, 6)} - ${f(plan.stop, 6)}| = ${f(plan.riskPerUnit, 6)}`);
  console.log(`  9) stop distance %   ${f(plan.riskPerUnit, 6)} / ${f(plan.entryMid, 6)} = ${f(stopDistPct, 3)}%`);
  console.log(` 10) position size     ${money(plan.riskAmount ?? 0)} / ${f(plan.riskPerUnit, 6)} = ${f(plan.qty ?? 0, 6)} ${c.symbol.replace('USDT', '')}`);
  console.log(` 11) notional          ${f(plan.qty ?? 0, 6)} x ${f(plan.entryMid, 6)} = ${money(notional ?? 0)}`);
  console.log(` 12) implied leverage  ${money(notional ?? 0)} / ${money(c.accountSize)} = ${f(impliedLev ?? 0, 2)}x`);
  console.log(` 13) liq price @ ${String(c.leverage).padStart(3)}x  ${f(plan.entryMid, 6)} x (1 - 1/${c.leverage}) = ${f(lev.liqPrice ?? 0, 6)}`);
  console.log(`     liq distance %    ${f(lev.liqPrice !== null ? Math.abs((lev.liqPrice - plan.entryMid) / plan.entryMid) * 100 : 0, 3)}%  (${f(lev.liqToStopMultiple ?? 0, 2)}x the stop distance)`);
  console.log(`     leverage check    ${lev.ok ? 'OK' : 'FAIL'} — ${lev.note}`);
  console.log(` 14) fees              ${RISK.TAKER_FEE_BPS}bps x 2 sides = ${f(plan.costs.feeBps, 2)}bps = ${money(plan.costs.feeAmount ?? 0)}`);
  console.log(` 15) funding (${c.holdHours}h)  |${c.funding8h}| x 10000 x ${c.holdHours}/8 = ${f(plan.costs.fundingBps, 2)}bps = ${money(plan.costs.fundingAmount ?? 0)}`);
  console.log(` 16) slippage          max(${RISK.DEFAULT_SLIPPAGE_BPS}, spread ${c.spreadBps}) = ${f(plan.costs.slippageBps, 2)}bps = ${money(plan.costs.slippageAmount ?? 0)}`);
  console.log(` 17) total cost        ${f(plan.costs.feeBps, 1)} + ${f(plan.costs.fundingBps, 1)} + ${f(plan.costs.slippageBps, 1)} = ${f(plan.costs.totalBps, 1)}bps`);
  const costR = (plan.costs.totalBps / 10_000 * plan.entryMid) / plan.riskPerUnit;
  console.log(`     cost in R         (${f(plan.costs.totalBps, 1)}/10000 x ${f(plan.entryMid, 6)}) / ${f(plan.riskPerUnit, 6)} = ${f(costR, 4)}R`);

  if (!plan.targets.length) {
    console.log(` 18) targets           none found — R:R is reported as "-", never invented`);
    console.log(`     headline netR     null (no reward leg to net against)`);
  } else {
    plan.targets.forEach((t, n) => {
      const reward = Math.abs(t.price - plan.entryMid);
      console.log(` ${String(18 + n).padStart(2)}) ${t.label.padEnd(2)} ${f(t.price, 6)}   reward ${f(reward, 6)} = ${f(t.rr, 3)}R   net ${f(t.netR, 3)}R   after cost ${f(plan.costs.totalBps, 1)}bps`);
    });
    console.log(`     headline R:R      ${f(plan.rr, 3)}   headline netR ${f(plan.netR ?? 0, 3)}R`);
  }

  console.log(` 19) India tax (TP1 or entry if none):`);
  const exit = plan.targets[0]?.price ?? plan.entryMid;
  const ot = oracleIndiaTax({
    side: c.side, entry: plan.entryMid, exitPrice: exit, qty: plan.qty ?? 0,
    feeAmount: plan.costs.feeAmount ?? 0, slippageAmount: plan.costs.slippageAmount ?? 0,
    fundingAmount: plan.costs.fundingAmount ?? 0,
    cryptoGainRate: INDIA_TAX.CRYPTO_GAIN_RATE, tdsRate: INDIA_TAX.TDS_RATE,
    tdsThreshold: INDIA_TAX.TDS_THRESHOLD_INR,
  });
  console.log(`     exit price        ${f(exit, 6)}`);
  console.log(`     gross P/L         (${f(exit, 6)} - ${f(plan.entryMid, 6)}) x ${f(plan.qty ?? 0, 4)} x ${c.side === 'bullish' ? 1 : -1} = ${money(tax.grossProfit)}`);
  console.log(`     less costs        fees ${money(tax.fees)}`);
  console.log(`     taxable gain      max(0, gross - fees) = ${money(ot.netGain)}`);
  console.log(`     tax @ 30%         ${money(ot.netGain)} x ${INDIA_TAX.CRYPTO_GAIN_RATE} = ${money(tax.tax)}`);
  console.log(`     TDS @ 1%          sell value ${money(exit * (plan.qty ?? 0))} ${exit * (plan.qty ?? 0) > INDIA_TAX.TDS_THRESHOLD_INR ? '>' : '<='} ${money(INDIA_TAX.TDS_THRESHOLD_INR)} => ${money(tax.tds)}`);
  console.log(`     AFTER TAX         ${money(ot.netGain)} - ${money(tax.tax)} - ${money(tax.tds)} = ${money(tax.netAfterTax)}`);
  console.log(`     note              ${tax.note}`);

  console.log('');
  console.log('  CROSS-CHECK buildPlan vs independent oracle:');
  cross('entryMid', plan.entryMid, o.entry, 1e-9);
  cross('stop', plan.stop, o.stop, 1e-9);
  cross('riskPerUnit', plan.riskPerUnit, o.riskPerUnit, 1e-9);
  cross('riskAmount', plan.riskAmount ?? 0, o.riskAmount, 0.01);
  cross('qty', plan.qty ?? 0, o.qty ?? 0, 1e-6);
  cross('feeBps', plan.costs.feeBps, o.feeBps, 0.01);
  cross('fundingBps', plan.costs.fundingBps, o.fundingBps, 0.01);
  cross('slippageBps', plan.costs.slippageBps, o.slippageBps, 0.01);
  cross('costR', costR, o.costR, 1e-6);
  plan.targets.forEach((t, n) => {
    cross(`${t.label}.grossR`, t.rr, o.grossR[n], 1e-9);
    cross(`${t.label}.netR`, t.netR, o.netR[n], 1e-9);
  });
  cross('liqPrice', lev.liqPrice ?? 0, o.liqPrice ?? 0, 1e-6);
  cross('liqToStopMultiple', lev.liqToStopMultiple ?? 0, o.liqToStopMultiple ?? 0, 0.01);
}

console.log('');
console.log('='.repeat(80));
console.log(failures === 0
  ? 'RESULT: buildPlan and the independent oracle agree on every figure.'
  : `RESULT: ${failures} MISMATCH(ES) — buildPlan and the oracle disagree. Fix before shipping.`);
console.log('='.repeat(80));
process.exit(failures === 0 ? 0 : 1);