import type { Candle } from '../../shared/types';
import { DAY_MS } from './tokens';
import type { SessionPoint, SessionSeries } from './types';

/**
 * Session VWAP with sigma bands.
 *
 * A session is one UTC day (reset at 00:00 UTC). For every candle inside the
 * session we accumulate volume-weighted sums over the session so far:
 *
 *   VWAP = Σ(typical × volume) / Σ(volume)
 *   σ²   = Σ(volume × (typical − VWAP)²) / Σ(volume)
 *
 * Because the sums are cumulative, the bands start tight at the first candle
 * and flare out as the session develops — exactly the "tight at open, wider
 * later" shape the view requires. Each session produces one series; the break
 * between two series is the visible gap between sessions.
 */

export function dayStart(t: number): number {
  return Math.floor(t / DAY_MS) * DAY_MS;
}

export function buildSessionSeries(candles: readonly Candle[]): SessionSeries[] {
  const series: SessionSeries[] = [];
  let cur: { t0: number; points: SessionPoint[] } | null = null;
  let w = 0;
  let s = 0;
  let q = 0;

  const flush = () => {
    if (!cur) return;
    const last = cur.points[cur.points.length - 1];
    series.push({ t0: cur.t0, t1: last ? last.t : cur.t0, points: cur.points });
  };

  for (const c of candles) {
    const d = dayStart(c.t);
    if (!cur || cur.t0 !== d) {
      flush();
      cur = { t0: d, points: [] };
      w = 0;
      s = 0;
      q = 0;
    }
    const tp = (c.h + c.l + c.c) / 3;
    const v = c.v > 0 ? c.v : 0;
    w += v;
    s += tp * v;
    q += tp * tp * v;
    const vwap = w > 0 ? s / w : tp;
    const variance = w > 0 ? Math.max(0, q / w - vwap * vwap) : 0;
    const sigma = Math.sqrt(variance);
    cur.points.push({
      t: c.t,
      vwap,
      p1: vwap + sigma,
      m1: vwap - sigma,
      p2: vwap + 2 * sigma,
      m2: vwap - 2 * sigma,
    });
  }
  flush();
  return series;
}

/**
 * Rebuilds only when the candle series actually changed (length or last-candle
 * values). Reads happen every animation frame; the build itself is ~12k cheap
 * ops, so guarding by fingerprint is enough to keep the loop at 60fps.
 */
export class SessionVwapCache {
  private fingerprint = '';
  private cached: SessionSeries[] = [];

  get(candles: readonly Candle[]): SessionSeries[] {
    const last = candles[candles.length - 1];
    const fp = last
      ? `${candles.length}:${last.t}:${last.h}:${last.l}:${last.c}`
      : 'empty';
    if (fp === this.fingerprint) return this.cached;
    this.cached = buildSessionSeries(candles);
    this.fingerprint = fp;
    return this.cached;
  }
}
