import type { Candle } from '../../shared/types';
import type { SessionId, VisibleStats } from '../charts/types';

const MINUTE = 60_000;

export function sessionOpen(timestamp: number, session: SessionId): boolean {
  const date = new Date(timestamp);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (session === 'london') return minutes >= 8 * 60 && minutes < 16 * 60 + 30;
  return minutes >= 13 * 60 + 30 && minutes < 20 * 60;
}

export function sessionSegments(
  candles: Candle[],
  sessions: Record<SessionId, boolean>,
): Array<{ london: boolean; newyork: boolean }> {
  return candles.map((candle) => ({
    london: sessions.london && sessionOpen(candle.t, 'london'),
    newyork: sessions.newyork && sessionOpen(candle.t, 'newyork'),
  }));
}

function clampRange(length: number, from?: number, to?: number): [number, number] {
  if (length === 0) return [0, -1];
  const start = Math.max(0, Math.min(length - 1, Math.floor(from ?? 0)));
  const end = Math.max(start, Math.min(length - 1, Math.floor(to ?? length - 1)));
  return [start, end];
}

export function visibleRangeStats(
  candles: Candle[],
  from?: number,
  to?: number,
  binCount = 64,
): VisibleStats {
  const [start, end] = clampRange(candles.length, from, to);
  if (start > end) {
    return { volumeQty: 0, deltaQty: null, cvdUsd: null, poc: null, bars: 0 };
  }

  const slice = candles.slice(start, end + 1);
  let volumeQty = 0;
  let deltaQty = 0;
  let cvdUsd = 0;
  let hasBaseTaker = true;
  let hasQuoteTaker = true;
  let high = -Infinity;
  let low = Infinity;

  for (const candle of slice) {
    volumeQty += candle.v;
    if (candle.takerBuyBase === undefined) hasBaseTaker = false;
    else deltaQty += candle.takerBuyBase * 2 - candle.v;
    if (candle.takerBuyQuote === undefined || candle.qv === undefined) hasQuoteTaker = false;
    else cvdUsd += candle.takerBuyQuote * 2 - candle.qv;
    if (candle.h > high) high = candle.h;
    if (candle.l < low) low = candle.l;
  }

  let poc: number | null = null;
  if (Number.isFinite(high) && Number.isFinite(low)) {
    if (high === low) {
      poc = high;
    } else {
      const bins = Math.max(12, Math.min(120, Math.round(binCount)));
      const width = (high - low) / bins;
      const weights = new Array<number>(bins).fill(0);
      for (const candle of slice) {
        const weight = candle.qv ?? candle.v;
        if (!Number.isFinite(weight) || weight <= 0) continue;
        const lo = Math.max(0, Math.min(bins - 1, Math.floor((candle.l - low) / width)));
        const hi = Math.max(0, Math.min(bins - 1, Math.floor((candle.h - low) / width)));
        const span = hi - lo + 1;
        for (let i = lo; i <= hi; i += 1) weights[i] += weight / span;
      }
      let best = 0;
      for (let i = 1; i < bins; i += 1) if (weights[i] > weights[best]) best = i;
      poc = low + (best + 0.5) * width;
    }
  }

  return {
    volumeQty,
    deltaQty: hasBaseTaker ? deltaQty : null,
    cvdUsd: hasQuoteTaker ? cvdUsd : null,
    poc,
    bars: slice.length,
  };
}

export function sessionMinutes(timestamp: number): number {
  const date = new Date(timestamp);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

export const SESSION_WINDOWS: Record<SessionId, { start: number; end: number }> = {
  london: { start: 8 * 60, end: 16 * 60 + 30 },
  newyork: { start: 13 * 60 + 30, end: 20 * 60 },
};

export function sessionDurationMs(session: SessionId): number {
  const window = SESSION_WINDOWS[session];
  return (window.end - window.start) * MINUTE;
}
