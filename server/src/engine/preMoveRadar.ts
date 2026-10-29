import type { Candle, DerivRow, Setup, TradePlan } from '../../../shared/types.js';
import { fetchKlines } from '../data/binance.js';
import { resolveUniverse } from '../data/universeBuilder.js';
import { buildDerivatives } from '../data/derivatives/build.js';
import { computeVolumeProfile } from './volumeProfile.js';
import {
  detectOrderBlock, averageRange, choppiness, findPivots, trendFromPivots,
  sessionStartIndex, sessionStartTime, sessionVwap,
} from './orderblock.js';
import { volatilityContext } from './timeframes.js';
import { buildPlan } from './tradePlan.js';
import { resolveIdentity } from '../data/coinIdentity.js';
import { cached } from '../lib/cache.js';

export interface PreMoveSignal {
  base: string;
  symbol: string;
  displayTicker: string;
  logoUrl: string | null;
  sector: string;
  price: number;
  changePct: number;
  preMoveScore: number;
  /** Fired signal labels */
  signals: string[];
  estimatedDirection: 'bullish' | 'bearish' | 'unclear';
  /** 0–100: how strongly the directional votes agree */
  directionConfidence: number;
  /** Individual directional votes for display */
  dirVotes: {
    label: string;
    vote: 'bull' | 'bear' | 'neutral';
    weight: number;
  }[];
  timeframeMinutes: number;
  volumeProfile: { poc: number; vah: number; val: number } | null;
  setup: Setup | null;
  plan: TradePlan | null;
  derivatives: DerivRow | null;
  /** Bollinger squeeze detected — compression before expansion */
  squeeze: boolean;
  /** Taker buy ratio 0–1 (>0.55 bull, <0.45 bear) */
  takerRatio: number | null;
  /** Price vs session VWAP */
  vwap: number | null;
  /** 1h trend from pivot structure */
  trend1h: 'up' | 'down' | 'range';
  updatedAt: number;
}

// ─── Signal weights ────────────────────────────────────────────────────────

interface SignalFactors {
  oiAccum: boolean;       // 20pts — OI building while price flat
  cvdDiv: boolean;        // 20pts — CVD slope vs price divergence
  domImbalance: boolean;  // 15pts — strong bid/ask wall
  fundingFlip: boolean;   // 15pts — funding trending from negative toward positive
  vpCoil: boolean;        // 15pts — price coiling at POC
  choppDrop: boolean;     // 10pts — choppiness falling below 42
  relStrength: boolean;   // 5pts  — holding while BTC drops
}

function scoreFactors(f: SignalFactors): number {
  return (
    (f.oiAccum ? 20 : 0) +
    (f.cvdDiv ? 20 : 0) +
    (f.domImbalance ? 15 : 0) +
    (f.fundingFlip ? 15 : 0) +
    (f.vpCoil ? 15 : 0) +
    (f.choppDrop ? 10 : 0) +
    (f.relStrength ? 5 : 0)
  );
}

function labelledSignals(f: SignalFactors): string[] {
  const out: string[] = [];
  if (f.oiAccum) out.push('OI Accumulation');
  if (f.cvdDiv) out.push('CVD Divergence');
  if (f.domImbalance) out.push('DOM Imbalance');
  if (f.fundingFlip) out.push('Funding Flip');
  if (f.vpCoil) out.push('Volume Profile Coil');
  if (f.choppDrop) out.push('Choppiness Dropping');
  if (f.relStrength) out.push('Relative Strength');
  return out;
}

// ─── Directional vote system ───────────────────────────────────────────────
//
// Each vote has a weight. Bull votes add, bear votes subtract.
// Final score: sum(bull weights) - sum(bear weights), normalised to 0–100.
// Direction is bullish when score > 55, bearish when < 45, unclear otherwise.

interface DirVote {
  label: string;
  vote: 'bull' | 'bear' | 'neutral';
  weight: number;
}

function buildDirectionVotes(
  d: DerivRow | null,
  closed: Candle[],
  btcChangePct: number,
  trend1h: 'up' | 'down' | 'range',
  vwap: number | null,
): DirVote[] {
  const last = closed[closed.length - 1];
  const price = last?.c ?? 0;

  const dayAgo = closed[sessionStartIndex(closed)];
  const changePct = dayAgo?.c > 0 ? ((price - dayAgo.c) / dayAgo.c) * 100 : 0;

  const votes: DirVote[] = [];

  // 1. HTF trend (weight 30) — strongest directional signal
  if (trend1h === 'up') votes.push({ label: 'HTF Trend', vote: 'bull', weight: 30 });
  else if (trend1h === 'down') votes.push({ label: 'HTF Trend', vote: 'bear', weight: 30 });
  else votes.push({ label: 'HTF Trend', vote: 'neutral', weight: 30 });

  // 2. CVD slope (weight 25)
  if (d && d.cvdSlope > 0) votes.push({ label: 'CVD Slope', vote: 'bull', weight: 25 });
  else if (d && d.cvdSlope < 0) votes.push({ label: 'CVD Slope', vote: 'bear', weight: 25 });
  else votes.push({ label: 'CVD Slope', vote: 'neutral', weight: 25 });

  // 3. OI direction (weight 20) — OI rising + price flat = accumulation
  if (d && d.oiChange.h1 > 0 && d.cvdSlope > 0) votes.push({ label: 'OI + CVD', vote: 'bull', weight: 20 });
  else if (d && d.oiChange.h1 > 0 && d.cvdSlope < 0) votes.push({ label: 'OI + CVD', vote: 'bear', weight: 20 });
  else votes.push({ label: 'OI + CVD', vote: 'neutral', weight: 20 });

  // 4. DOM imbalance (weight 15)
  if (d?.depth && d.depth.imbalance > 0.15) votes.push({ label: 'DOM', vote: 'bull', weight: 15 });
  else if (d?.depth && d.depth.imbalance < -0.15) votes.push({ label: 'DOM', vote: 'bear', weight: 15 });
  else votes.push({ label: 'DOM', vote: 'neutral', weight: 15 });

  // 5. Taker ratio (weight 15)
  const tr = d?.takerRatio ?? null;
  if (tr !== null && tr > 0.55) votes.push({ label: 'Taker Ratio', vote: 'bull', weight: 15 });
  else if (tr !== null && tr < 0.45) votes.push({ label: 'Taker Ratio', vote: 'bear', weight: 15 });
  else votes.push({ label: 'Taker Ratio', vote: 'neutral', weight: 15 });

  // 6. Price vs VWAP (weight 10)
  if (vwap && price > vwap) votes.push({ label: 'vs VWAP', vote: 'bull', weight: 10 });
  else if (vwap && price < vwap) votes.push({ label: 'vs VWAP', vote: 'bear', weight: 10 });
  else votes.push({ label: 'vs VWAP', vote: 'neutral', weight: 10 });

  // 7. Relative strength vs BTC (weight 10)
  if (btcChangePct < -0.3 && changePct >= -0.1) votes.push({ label: 'vs BTC', vote: 'bull', weight: 10 });
  else if (btcChangePct > 0.3 && changePct <= 0.1) votes.push({ label: 'vs BTC', vote: 'bear', weight: 10 });
  else votes.push({ label: 'vs BTC', vote: 'neutral', weight: 10 });

  // 8. Funding (weight 10) — negative funding = shorts paying = bull fuel
  if (d && d.funding8h < -0.0001) votes.push({ label: 'Funding', vote: 'bull', weight: 10 });
  else if (d && d.funding8h > 0.0003) votes.push({ label: 'Funding', vote: 'bear', weight: 10 });
  else votes.push({ label: 'Funding', vote: 'neutral', weight: 10 });

  return votes;
}

function resolveDirection(votes: DirVote[]): {
  direction: 'bullish' | 'bearish' | 'unclear';
  confidence: number;
} {
  const totalWeight = votes.reduce((s, v) => s + v.weight, 0);
  const bullWeight = votes.filter((v) => v.vote === 'bull').reduce((s, v) => s + v.weight, 0);
  const bearWeight = votes.filter((v) => v.vote === 'bear').reduce((s, v) => s + v.weight, 0);

  if (totalWeight === 0) return { direction: 'unclear', confidence: 0 };

  const bullPct = (bullWeight / totalWeight) * 100;
  const bearPct = (bearWeight / totalWeight) * 100;

  // Confidence = how dominant the winning side is (0–100)
  const confidence = Math.round(Math.max(bullPct, bearPct));

  if (bullPct >= 55 && bullPct > bearPct + 10) return { direction: 'bullish', confidence };
  if (bearPct >= 55 && bearPct > bullPct + 10) return { direction: 'bearish', confidence };
  return { direction: 'unclear', confidence: Math.round(Math.max(bullPct, bearPct)) };
}

// ─── Per-coin computation ──────────────────────────────────────────────────

async function computePreMove(
  candles: Candle[],
  d: DerivRow | null,
  btcChangePct: number,
  _btcCandles: Candle[],
): Promise<{
  factors: SignalFactors;
  score: number;
  direction: 'bullish' | 'bearish' | 'unclear';
  directionConfidence: number;
  dirVotes: DirVote[];
  squeeze: boolean;
  takerRatio: number | null;
  vwap: number | null;
  trend1h: 'up' | 'down' | 'range';
}> {
  const closed = candles.filter((c) => c.closed);
  const empty = {
    factors: {} as SignalFactors, score: 0, direction: 'unclear' as const,
    directionConfidence: 0, dirVotes: [], squeeze: false, takerRatio: null,
    vwap: null, trend1h: 'range' as const,
  };
  if (closed.length < 20) return empty;

  const last = closed[closed.length - 1];
  const price = last.c;
  const dayAgo = closed[sessionStartIndex(closed)];
  const changePct = dayAgo.c > 0 ? ((price - dayAgo.c) / dayAgo.c) * 100 : 0;

  // ── 1h trend from 5m pivot structure (last 12 candles = 1h) ──────────────
  const pivots1h = findPivots(closed.slice(-12), 2);
  const trend1h = trendFromPivots(pivots1h);

  // ── Session VWAP ──────────────────────────────────────────────────────────
  const dayStart = sessionStartTime(closed);
  const vwap = sessionVwap(closed, dayStart);

  // ── Volatility / squeeze ──────────────────────────────────────────────────
  const vol = volatilityContext(candles);
  const squeeze = vol.squeeze;

  // ── Taker ratio from last 20 candles ─────────────────────────────────────
  const recent20 = closed.slice(-20);
  const totalVol = recent20.reduce((s, c) => s + c.v, 0);
  const buyVol = recent20.reduce((s, c) => s + (c.takerBuyBase ?? c.v * 0.5), 0);
  const takerRatio = totalVol > 0 ? buyVol / totalVol : null;

  // ── Signal factors ────────────────────────────────────────────────────────

  // 1. OI Accumulation: OI rising while price flat
  const oiAccum = !!(d && d.oiChange.h1 > 0 && Math.abs(changePct) < 0.5);

  // 2. CVD Divergence: CVD slope positive but price flat/down last 3 candles
  const last3 = closed.slice(-3);
  const priceFlat = last3.length === 3 && last3[2].c <= last3[0].c * 1.002;
  const cvdDiv = !!(d && d.cvdSlope > 0 && priceFlat);

  // 3. DOM Imbalance: strong bid or ask wall
  const domImbalance = !!(d?.depth && Math.abs(d.depth.imbalance) > 0.15);

  // 4. Funding Flip: funding near zero from negative + CVD rising (shorts being squeezed)
  const fundingFlip = !!(d && d.funding8h > -0.0002 && d.funding8h < 0.0003 && d.cvdSlope > 0);

  // 5. Volume Profile Coil: price within 0.3% of POC for 3+ candles
  const vp = computeVolumeProfile(candles);
  let vpCoil = false;
  if (vp) {
    const recent3 = closed.slice(-3);
    vpCoil = recent3.length === 3 && recent3.every((c) => Math.abs(c.c - vp.poc) / vp.poc < 0.003);
  }

  // 6. Choppiness Dropping: chop < 42 and falling
  const chop = choppiness(closed);
  const chopPrev = choppiness(closed.slice(0, -3));
  const choppDrop = chop < 42 && chop < chopPrev;

  // 7. Relative Strength: coin flat/up while BTC drops
  const relStrength = btcChangePct < -0.3 && changePct >= -0.1;

  const factors: SignalFactors = {
    oiAccum, cvdDiv, domImbalance, fundingFlip, vpCoil, choppDrop, relStrength,
  };

  const score = scoreFactors(factors);

  // ── Direction votes ───────────────────────────────────────────────────────
  const dirVotes = buildDirectionVotes(d, closed, btcChangePct, trend1h, vwap);
  const { direction, confidence: directionConfidence } = resolveDirection(dirVotes);

  return {
    factors, score, direction, directionConfidence, dirVotes,
    squeeze, takerRatio, vwap, trend1h,
  };
}

// ─── Public entry point ────────────────────────────────────────────────────

export async function buildPreMoveRadar(): Promise<PreMoveSignal[]> {
  return cached('radar:premove', 60_000, async () => {
    const [universe, derivsResult] = await Promise.all([
      resolveUniverse(),
      buildDerivatives().catch(() => ({
        rows: [] as DerivRow[],
        asOf: Date.now(),
        source: null,
        unavailable: 'derivatives build failed',
      })),
    ]);

    const derivMap = new Map<string, DerivRow>();
    for (const row of derivsResult.rows) derivMap.set(row.symbol, row);

    const btcCandles = await fetchKlines('BTCUSDT', '5m', 320).catch(() => [] as Candle[]);
    const btcClosed = btcCandles.filter((c) => c.closed);
    const btcDayAgo = btcClosed[sessionStartIndex(btcClosed)];
    const btcLast = btcClosed[btcClosed.length - 1];
    const btcChangePct = btcDayAgo && btcLast && btcDayAgo.c > 0
      ? ((btcLast.c - btcDayAgo.c) / btcDayAgo.c) * 100
      : 0;

    const signals: PreMoveSignal[] = [];
    const CONC = 8;
    const entries = universe.entries;

    for (let i = 0; i < entries.length; i += CONC) {
      const batch = entries.slice(i, i + CONC);
      const results = await Promise.allSettled(
        batch.map(async (u) => {
          const candles = await fetchKlines(u.pair, '5m', 320).catch(() => [] as Candle[]);
          const closed = candles.filter((c) => c.closed);
          if (closed.length < 20) return null;

          const d = derivMap.get(u.pair) ?? null;
          const result = await computePreMove(candles, d, btcChangePct, btcCandles);

          if (result.score < 40) return null;

          const last = closed[closed.length - 1];
          const dayAgo = closed[sessionStartIndex(closed)];
          const price = last.c;
          const changePct = dayAgo.c > 0 ? ((price - dayAgo.c) / dayAgo.c) * 100 : 0;

          const vp = computeVolumeProfile(candles);
          const atr = averageRange(closed, 20);
          const prefer = result.direction === 'unclear' ? undefined : result.direction;
          const setup = closed.length >= 40
            ? detectOrderBlock(candles, { range: atr, prefer })
            : null;
          const plan = setup ? buildPlan(u.base, setup.side, setup, price, (atr / price) * 100) : null;

          const identity = resolveIdentity(u.base, u.name, u.sector);

          return {
            base: u.base,
            symbol: u.pair,
            displayTicker: identity.displayTicker,
            logoUrl: identity.logoUrl,
            sector: u.sector,
            price,
            changePct: Math.round(changePct * 100) / 100,
            preMoveScore: result.score,
            signals: labelledSignals(result.factors),
            estimatedDirection: result.direction,
            directionConfidence: result.directionConfidence,
            dirVotes: result.dirVotes,
            timeframeMinutes: 30,
            volumeProfile: vp ? { poc: vp.poc, vah: vp.vah, val: vp.val } : null,
            setup,
            plan,
            derivatives: d,
            squeeze: result.squeeze,
            takerRatio: result.takerRatio,
            vwap: result.vwap,
            trend1h: result.trend1h,
            updatedAt: Date.now(),
          } satisfies PreMoveSignal;
        }),
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) signals.push(r.value);
      }
    }

    return signals.sort((a, b) => b.preMoveScore - a.preMoveScore);
  });
}
