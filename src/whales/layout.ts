import { clampNumber } from './engine';

export interface WhalesLayout {
  w: number;
  h: number;
  top: number;
  priceTop: number;
  priceH: number;
  volumeTop: number;
  volumeH: number;
  netTop: number;
  netH: number;
  timeTop: number;
  timeH: number;
  plotLeft: number;
  plotRight: number;
  gutterX: number;
  gutterW: number;
  gutterTop: number;
  gutterH: number;
  axisX: number;
  axisW: number;
}

export const RIGHT_AXIS_W = 90;
export const BUBBLE_GUTTER_W = 95;
export const PANEL_GAP = 6;
export const TIME_H = 16;
export const TOP_PAD = 8;
export const LEFT_PAD = 10;
export const RIGHT_PAD = 10;

export function computeLayout(w: number, h: number): WhalesLayout {
  const width = Math.max(1, w);
  const height = Math.max(1, h);
  const timeH = TIME_H;
  const timeTop = height - timeH;
  const plotRight = Math.max(80, width - RIGHT_AXIS_W - BUBBLE_GUTTER_W - RIGHT_PAD * 2 - 8);
  const gutterX = plotRight + 6;
  const gutterW = BUBBLE_GUTTER_W;
  const axisX = gutterX + gutterW + 4;
  const axisW = Math.max(50, width - axisX - RIGHT_PAD);
  const plotLeft = LEFT_PAD;
  const top = TOP_PAD;
  const bodyTop = top;
  const bodyH = Math.max(160, timeTop - bodyTop - 4);
  const volumeH = Math.max(36, Math.round(bodyH * 0.14));
  const netH = Math.max(36, Math.round(bodyH * 0.13));
  const priceH = Math.max(120, bodyH - volumeH - netH - PANEL_GAP * 2);
  const priceTop = bodyTop;
  const volumeTop = priceTop + priceH + PANEL_GAP;
  const netTop = volumeTop + volumeH + PANEL_GAP;
  return {
    w: width,
    h: height,
    top,
    priceTop,
    priceH,
    volumeTop,
    volumeH,
    netTop,
    netH,
    timeTop,
    timeH,
    plotLeft,
    plotRight,
    gutterX,
    gutterW,
    gutterTop: priceTop,
    gutterH: netTop + netH - priceTop,
    axisX,
    axisW,
  };
}

export function xForTime(time: number, start: number, end: number, left: number, width: number): number {
  if (end <= start) return left;
  return left + ((time - start) / (end - start)) * width;
}

export function timeForX(x: number, start: number, end: number, left: number, width: number): number {
  if (width <= 0) return start;
  return start + ((x - left) / width) * (end - start);
}

export function yForPrice(price: number, priceMin: number, priceMax: number, top: number, height: number): number {
  if (priceMax <= priceMin || height <= 0) return top;
  return top + ((priceMax - price) / (priceMax - priceMin)) * height;
}

export function priceForY(y: number, priceMin: number, priceMax: number, top: number, height: number): number {
  if (height <= 0) return priceMin;
  return priceMax - ((y - top) / height) * (priceMax - priceMin);
}

export interface NiceTicks {
  values: number[];
  step: number;
}

export function nicePriceTicks(min: number, max: number, count = 7): NiceTicks {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return { values: [], step: 0 };
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = nice * mag;
  const first = Math.ceil(min / step) * step;
  const values: number[] = [];
  for (let v = first; v <= max + step * 1e-8 && values.length < 64; v += step) {
    values.push(Number(v.toFixed(12)));
  }
  return { values, step };
}

/**
 * Price axis ticks for the Whales view: a fixed nice step (default 200 for
 * BTC at 15m). Falls back to the nice 7-tick algorithm when a fixed step
 * would produce an unusable count.
 */
export function axisTicks(min: number, max: number, step = 200): NiceTicks {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return { values: [], step: 0 };
  const count = Math.floor((max - min) / step) + 1;
  if (count > 50 || count < 3) return nicePriceTicks(min, max, 7);
  const first = Math.ceil(min / step) * step;
  const values: number[] = [];
  for (let v = first; v <= max + step * 1e-8 && values.length < 64; v += step) {
    values.push(Number(v.toFixed(12)));
  }
  return { values, step };
}

export function niceTimeStep(spanMs: number, width: number): number {
  const candidates = [
    60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
    60 * 60_000, 2 * 3_600_000, 3 * 3_600_000, 4 * 3_600_000, 6 * 3_600_000,
    8 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000, 2 * 86_400_000,
  ];
  for (const step of candidates) {
    if ((step / Math.max(1, spanMs)) * width >= 110) return step;
  }
  return candidates[candidates.length - 1];
}

export function clampTime(span: number, min: number, max: number): number {
  return clampNumber(span, min, max);
}
