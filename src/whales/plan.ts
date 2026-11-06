import type { WhaleBubble } from './types';
import { bubbleRadius, clampNumber } from './engine';
import { fmtUsd } from './format';
import { WHALE_TAG_RATIO, WHALE_LABEL_MIN_R, WHALE_BUBBLE_MAX_R } from './tokens';

/**
 * Pure, canvas-free planning for the Whales chart. Everything that the CHECKS
 * assert (cluster bubbles, tags, labels, tooltip placement, net consistency,
 * axis-tag conflicts) is computed here so it can be unit-tested without a DOM.
 */

export interface PlanViewport {
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  priceMin: number;
  priceMax: number;
  start: number;
  end: number;
}

export interface DrawnBubble {
  bubble: WhaleBubble;
  x: number;
  y: number;
  r: number;
}

export interface PlacedTag {
  text: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bubbleId: string;
}

export interface PlacedLabel {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bubbleId: string;
}

const TAG_FONT_APPROX = 7.2; // px per char at the 12px mono tag font
const LABEL_FONT_APPROX = 7.2;
const TAG_H = 18;
const LABEL_H = 20;

/** D8: right-gutter caption (always "bubbles/price"). */
export const GUTTER_CAPTION = 'bubbles/price';

/** D10: time-axis label color (#6b7686, 11px mono). */
export const TIME_LABEL_COLOR = '#6b7686';

/**
 * D3: screen-space aggregation. Merge bubbles whose centers are closer than
 * 0.6 x the sum of their radii into one cluster bubble (summed notional,
 * buy/sell pie recomputed, VWAP y). Radius keeps the sqrt scaling, capped at
 * 38px. Returns drawn bubbles sorted by notional descending.
 */
export function clusterBubbles(
  bubbles: readonly WhaleBubble[],
  vp: PlanViewport,
  t0: number | null,
): DrawnBubble[] {
  const plotW = Math.max(1, vp.plotRight - vp.plotLeft);
  const visible = bubbles.filter((b) => {
    if (t0 !== null && b.t < t0) return false;
    if (b.t < vp.start || b.t > vp.end) return false;
    return true;
  }).sort((a, b) => a.t - b.t);

  const drawn: DrawnBubble[] = visible.map((b) => {
    const x = vp.plotLeft + ((b.t - vp.start) / (vp.end - vp.start)) * plotW;
    const y = vp.plotTop + ((vp.priceMax - b.price) / Math.max(1e-9, vp.priceMax - vp.priceMin)) * (vp.plotBottom - vp.plotTop);
    return { bubble: b, x, y, r: bubbleRadius(b.notional) };
  });

  // Iterative merging until stable: any pair closer than 0.6 * (r1+r2) merges.
  for (let pass = 0; pass < 20; pass++) {
    let mergedAny = false;
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        const a = drawn[i];
        const b = drawn[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist <= 0.6 * (a.r + b.r)) {
          const total = a.bubble.notional + b.bubble.notional;
          const buyUsd = a.bubble.buyUsd + b.bubble.buyUsd;
          const sellUsd = a.bubble.sellUsd + b.bubble.sellUsd;
          const mergedBubble: WhaleBubble = {
            id: `${a.bubble.id}+${b.bubble.id}`,
            t: (a.bubble.t * a.bubble.notional + b.bubble.t * b.bubble.notional) / total,
            price: (a.bubble.price * a.bubble.notional + b.bubble.price * b.bubble.notional) / total,
            buyUsd,
            sellUsd,
            notional: total,
            count: a.bubble.count + b.bubble.count,
            prints: a.bubble.prints + b.bubble.prints,
            tradeIds: [...a.bubble.tradeIds, ...b.bubble.tradeIds],
            avg: total > 0 ? (a.bubble.avg * a.bubble.notional + b.bubble.avg * b.bubble.notional) / total : 0,
          };
          a.bubble = mergedBubble;
          a.x = vp.plotLeft + ((mergedBubble.t - vp.start) / (vp.end - vp.start)) * plotW;
          a.y = vp.plotTop + ((vp.priceMax - mergedBubble.price) / Math.max(1e-9, vp.priceMax - vp.priceMin)) * (vp.plotBottom - vp.plotTop);
          a.r = bubbleRadius(total);
          drawn.splice(j, 1);
          j -= 1;
          mergedAny = true;
        }
      }
    }
    if (!mergedAny) break;
  }

  return drawn.sort((a, b) => b.bubble.notional - a.bubble.notional);
}

function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * D4/D5: place tags and labels with collision avoidance.
 * Tags: plain text with a dark outline (no box), one per cluster bubble,
 * only when |buy - sell| / total >= 0.35, placed to the right of the bubble,
 * drawn in descending notional order, at most 3, skip overlaps.
 * Labels: above the bubble (right-above if taken), priority = largest notional.
 */
export function planOverlays(
  drawn: readonly DrawnBubble[],
  vp: PlanViewport,
  maxTags = 3,
): { tags: PlacedTag[]; labels: PlacedLabel[] } {
  const tags: PlacedTag[] = [];
  const labels: PlacedLabel[] = [];

  for (const d of drawn) {
    const b = d.bubble;
    const imbalance = b.notional > 0 ? Math.abs(b.buyUsd - b.sellUsd) / b.notional : 0;

    if (imbalance >= WHALE_TAG_RATIO && tags.length < maxTags) {
      const selling = b.sellUsd > b.buyUsd;
      const text = `${fmtUsd(Math.abs(b.buyUsd - b.sellUsd))} whale ${selling ? 'selling' : 'buying'} here`;
      const w = text.length * TAG_FONT_APPROX + 14;
      const x = clampNumber(d.x + 6, vp.plotLeft + 2, vp.plotRight - w - 2);
      const y = d.y + d.r + 10;
      const rect = { x, y, w, h: TAG_H };
      if (tags.every((t) => !rectsOverlap(t, rect)) && rect.x + rect.w <= vp.plotRight && rect.x >= vp.plotLeft) {
        tags.push({
          text,
          color: selling ? '#ff8fa3' : '#3ddc84',
          x,
          y,
          w,
          h: TAG_H,
          bubbleId: b.id,
        });
      }
    }

    if (d.r >= WHALE_LABEL_MIN_R) {
      const text = fmtUsd(b.notional);
      const w = text.length * LABEL_FONT_APPROX + 8;
      let x = clampNumber(d.x - w / 2, vp.plotLeft + 2, vp.plotRight - w - 2);
      let y = d.y - d.r - 12;
      let rect = { x, y, w, h: LABEL_H };
      if (labels.some((l) => rectsOverlap(l, rect))) {
        x = clampNumber(d.x + d.r * 0.4, vp.plotLeft + 2, vp.plotRight - w - 2);
        rect = { x, y, w, h: LABEL_H };
      }
      if (!labels.some((l) => rectsOverlap(l, rect)) && rect.x + rect.w <= vp.plotRight && rect.x >= vp.plotLeft) {
        labels.push({ text, x, y, w, h: LABEL_H, bubbleId: b.id });
      }
    }
  }

  return { tags, labels };
}

export interface NetView {
  headerNet: number;
  lastPoint: { t: number; whale: number } | null;
  perCandle: Array<{ t: number; whale: number; everyone: number }>;
}

/** D9: bubble-net consistency with the reading bar (same in-view store). */
export function netForView(
  points: readonly { t: number; whale: number; everyone: number }[],
  vp: PlanViewport,
): NetView {
  const perCandle = points.filter((p) => p.t >= vp.start && p.t <= vp.end);
  let headerNet = 0;
  let lastPoint: NetView['lastPoint'] = null;
  for (const p of perCandle) {
    headerNet += p.whale;
    lastPoint = { t: p.t, whale: headerNet };
  }
  return { headerNet, lastPoint, perCandle };
}

/** D7: tooltip placement clamped fully inside the plot rectangle. */
export function tooltipPlacement(
  cursorX: number,
  cursorY: number,
  vp: PlanViewport,
  width = 480,
  height = 88,
): { x: number; y: number } {
  const fitsRight = cursorX + 14 + width <= vp.plotRight;
  const x = fitsRight ? Math.max(vp.plotLeft + 4, cursorX + 14) : Math.max(vp.plotLeft + 4, cursorX - width - 14);
  const y = clampNumber(cursorY - height / 2, vp.plotTop + 4, Math.max(vp.plotTop + 4, vp.plotBottom - height - 4));
  return { x, y };
}

export interface AxisTag {
  price: number;
  y: number;
}

/**
 * D12: pick which axis tags to draw so that none overlap by more than 2px.
 * Always keeps the last-price and crosshair tags; level/avg tags are skipped
 * when they would collide with either.
 */
export function filterAxisTags(
  candidates: AxisTag[],
  reserved: Array<{ y: number }>,
  minGap = 24,
): AxisTag[] {
  const kept: AxisTag[] = [];
  for (const c of candidates.sort((a, b) => a.y - b.y)) {
    const conflict = reserved.some((r) => Math.abs(r.y - c.y) < minGap)
      || kept.some((k) => Math.abs(k.y - c.y) < minGap);
    if (!conflict) kept.push(c);
  }
  return kept;
}

export { WHALE_BUBBLE_MAX_R };
