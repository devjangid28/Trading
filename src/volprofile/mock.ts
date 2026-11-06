import type { Candle } from '../../shared/types';
import { CANDLE_STEP_MS } from './tokens';

/**
 * Deterministic synthetic 1m candles for MOCK mode. The volume-profile view is
 * a data-heavy screen: in mock it must never call the real API, but it still
 * needs a full 12,000-candle canvas to exercise decimation, sessions, VWAP
 * bands and profiles. Seeded per symbol so a reload shows the same picture.
 */

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultAnchor(symbol: string): number {
  const base = symbol.replace(/USDT$/i, '').toUpperCase();
  if (base === 'BTC') return 80_590;
  if (base === 'ETH') return 2_420;
  if (base === 'SOL') return 148;
  if (base === 'BNB') return 612;
  return 100;
}

export function buildMockCandles(
  symbol: string,
  count: number = 12_000,
  now: number = Date.now(),
): Candle[] {
  const mid = defaultAnchor(symbol);
  const seed = hash(`${symbol}:mock:${Math.round(mid)}`);
  const random = rng(seed);
  const step = CANDLE_STEP_MS;
  const start = now - count * step;
  const drift = mid * 0.00002;
  const out: Candle[] = [];

  let prevClose = mid * (1 - 0.004 + random() * 0.008);
  let i = 0;
  while (i < count) {
    const t = start + i * step;
    const dayU = (i % 1440) / 1440;
    // Day shape: slight rise, session-ish bulge, then fall — gives VWAP bands
    // something to flare over inside a session.
    const dayShape = Math.sin((dayU - 0.5) * Math.PI) * 0.0012;
    const wave = Math.sin(i / 61) * mid * 0.00035;
    const open = prevClose;
    const close = open + drift + wave + dayShape * mid + (random() - 0.5) * mid * 0.0006;
    const high = Math.max(open, close) * (1 + random() * 0.00035);
    const low = Math.min(open, close) * (1 - random() * 0.00035);
    const v = 1.2 + random() * 8 + Math.abs(close - open) * 2_000;
    const qv = v * ((open + close) / 2);
    const buyRatio = 0.35 + random() * 0.35;
    out.push({
      t,
      o: open,
      h: high,
      l: low,
      c: close,
      v,
      qv,
      trades: 8 + Math.floor(random() * 60),
      takerBuyBase: v * buyRatio,
      takerBuyQuote: qv * buyRatio,
      closed: t + step <= now,
    });
    prevClose = close;
    i++;
  }
  return out;
}
