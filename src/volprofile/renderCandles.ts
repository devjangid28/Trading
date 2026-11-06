import type { Candle } from '../../shared/types';
import { CANDLE_STEP_MS, VP_TOKENS } from './tokens';
import type { VpLayout, ViewState } from './types';

/**
 * Candle renderer with per-pixel-column decimation.
 *
 * When candles are wider than ~1px they are drawn as classic wick + body bars.
 * When they are narrower than 1px (the default 12k-candle fit is 4-8 candles
 * per pixel), each pixel column becomes one 1px bar: open = first open, close
 * = last close, high = max, low = min, coloured by direction. The result is
 * the thin green/red noise the design calls for.
 */

const UP = VP_TOKENS.up;
const DOWN = VP_TOKENS.down;

function lowerBound(candles: readonly Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(candles: readonly Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function drawCandles(
  ctx: CanvasRenderingContext2D,
  l: VpLayout,
  candles: readonly Candle[],
  view: ViewState,
): void {
  if (!candles.length) return;
  const { plotLeft, plotRight, plotTop, plotBottom } = l;
  const pw = plotRight - plotLeft;
  const ph = plotBottom - plotTop;
  const span = view.end - view.start;
  if (span <= 0 || pw <= 0 || ph <= 0) return;

  const pxPerCandle = (pw / span) * CANDLE_STEP_MS;
  const yFor = (p: number): number =>
    plotBottom - ((p - view.priceMin) / (view.priceMax - view.priceMin)) * ph;

  const i0 = lowerBound(candles, view.start - CANDLE_STEP_MS);
  const i1 = upperBound(candles, view.end + CANDLE_STEP_MS);

  if (pxPerCandle >= 1.2) {
    ctx.fillStyle = UP;
    const bw = Math.max(1, Math.min(6, pxPerCandle * 0.7));
    const stepPx = (CANDLE_STEP_MS / span) * pw;
    const xc = (i: number): number => plotLeft + (i - i0) * stepPx + stepPx / 2;
    for (let i = i0; i < i1; i++) {
      const c = candles[i];
      const x = xc(i);
      const up = c.c >= c.o;
      const yh = yFor(c.h);
      const yl = yFor(c.l);
      ctx.fillStyle = up ? UP : DOWN;
      ctx.fillRect(x - 0.5, yh, 1, Math.max(1, yl - yh));
      const yo = yFor(c.o);
      const yc = yFor(c.c);
      const top = Math.min(yo, yc);
      const bottom = Math.max(yo, yc);
      ctx.fillRect(x - bw / 2, top, bw, Math.max(1, bottom - top));
    }
    return;
  }

  // Decimate: one 1px candle per pixel column.
  const colW = Math.max(1, Math.floor(pxPerCandle));
  let idx = i0;
  for (let x = plotLeft; x < plotRight; x += colW) {
    const colStartT = view.start + ((x - plotLeft) / pw) * span;
    const colEndT = view.start + ((x + colW - plotLeft) / pw) * span;
    let o: number | undefined;
    let cl = 0;
    let h = -Infinity;
    let lo = Infinity;
    while (idx < i1 && candles[idx].t < colEndT) {
      const c = candles[idx];
      if (c.t >= colStartT) {
        if (o === undefined) o = c.o;
        cl = c.c;
        if (c.h > h) h = c.h;
        if (c.l < lo) lo = c.l;
      }
      idx++;
    }
    if (o === undefined || !Number.isFinite(h) || !Number.isFinite(lo)) continue;
    ctx.fillStyle = cl >= o ? UP : DOWN;
    const yh = yFor(h);
    const yl = yFor(lo);
    ctx.fillRect(x, yh, colW, Math.max(1, yl - yh));
  }
}
