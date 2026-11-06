import { VP_TOKENS } from './tokens';
import type { LevelSpec, VpLayout, ViewState } from './types';
import { priceAxisLabel } from './format';

/**
 * Overlay level system, same family as the Whales view:
 *
 *  - user "my level": white 2px dashed line, dark chip with white border at left
 *  - liquidation in range: magenta dotted line + magenta chip at left
 *  - liquidation out of range: no line; a pinned chip at top/bottom with ▲/▼
 *  - reference ray: solid grey line across the whole canvas (plot + axis),
 *    white filled axis tag with black text
 *  - last price: dotted white-ish line, white filled bold axis tag
 *
 * Left chips stack 20px apart so near-identical levels never overlap; axis
 * tags use the same rule on the price axis side.
 */

const FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

interface StackItem {
  id: string;
  y: number;
  height: number;
}

/** Push y positions apart so the smallest gap is minGap. */
export function stackVertically(
  items: StackItem[],
  minGap: number,
  top: number,
  bottom: number,
): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const out = new Map<string, number>();
  let prev = -Infinity;
  for (const it of sorted) {
    let y = it.y;
    if (prev > -Infinity && y < prev + minGap) y = prev + minGap;
    y = Math.max(top + it.height / 2, Math.min(bottom - it.height / 2, y));
    out.set(it.id, y);
    prev = y;
  }
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawChip(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y: number,
  text: string,
  color: string,
  border: string,
): void {
  ctx.font = FONT;
  const w = ctx.measureText(text).width;
  const h = 17;
  const rx = x0;
  const ry = y - h / 2;
  ctx.fillStyle = 'rgba(13,18,32,0.92)';
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  roundRect(ctx, rx, ry, w + 12, h, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, rx + 6, y + 0.5);
}

function drawAxisTag(
  ctx: CanvasRenderingContext2D,
  l: VpLayout,
  y: number,
  text: string,
  bold: boolean,
): number {
  ctx.font = bold ? 'bold 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' : FONT;
  const w = ctx.measureText(text).width;
  const pad = 5;
  const x = l.axisRight - w - pad - 4;
  const h = 15;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, x, y - h / 2, w + pad * 2, h, 3);
  ctx.fill();
  ctx.strokeStyle = 'rgba(10,14,23,0.35)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + pad, y + 0.5);
  return x;
}

export interface OverlayResult {
  profileHitY: number | null;
}

export function drawOverlays(
  ctx: CanvasRenderingContext2D,
  l: VpLayout,
  view: ViewState,
  levels: readonly LevelSpec[],
): OverlayResult {
  const inView = (p: number): boolean => p >= view.priceMin && p <= view.priceMax;
  const yFor = (p: number): number =>
    l.plotBottom - ((p - view.priceMin) / (view.priceMax - view.priceMin)) * (l.plotBottom - l.plotTop);

  interface ChipDatum {
    id: string;
    lineY: number;
    text: string;
    color: string;
    border: string;
  }
  interface AxisTagDatum {
    id: string;
    y: number;
    text: string;
    bold: boolean;
  }
  const chips: ChipDatum[] = [];
  const tags: AxisTagDatum[] = [];
  const pins: Array<{ side: 'top' | 'bottom'; text: string }> = [];

  ctx.save();
  for (const lev of levels) {
    const y = yFor(lev.price);
    switch (lev.kind) {
      case 'user': {
        if (!inView(lev.price)) break;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 5]);
        ctx.beginPath();
        ctx.moveTo(l.plotLeft, y);
        ctx.lineTo(l.plotRight, y);
        ctx.stroke();
        ctx.setLineDash([]);
        chips.push({
          id: lev.id,
          lineY: y,
          text: `★ ${lev.label} ${priceAxisLabel(lev.price)}`,
          color: '#ffffff',
          border: '#ffffff',
        });
        break;
      }
      case 'liq-short':
      case 'liq-long': {
        if (inView(lev.price)) {
          ctx.strokeStyle = VP_TOKENS.magenta;
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 4]);
          ctx.beginPath();
          ctx.moveTo(l.plotLeft, y);
          ctx.lineTo(l.plotRight, y);
          ctx.stroke();
          ctx.setLineDash([]);
          chips.push({
            id: lev.id,
            lineY: y,
            text: `⚡ ${lev.label} ${priceAxisLabel(lev.price)}`,
            color: VP_TOKENS.magenta,
            border: VP_TOKENS.magenta,
          });
        } else {
          pins.push({
            side: lev.price < view.priceMin ? 'bottom' : 'top',
            text: `${lev.price < view.priceMin ? '▼' : '▲'} ⚡ ${lev.label} ${priceAxisLabel(lev.price)}`,
          });
        }
        break;
      }
      case 'ref': {
        if (!inView(lev.price)) break;
        ctx.strokeStyle = VP_TOKENS.refLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(l.plotLeft, y);
        ctx.lineTo(l.axisRight, y);
        ctx.stroke();
        tags.push({ id: lev.id, y, text: priceAxisLabel(lev.price), bold: false });
        break;
      }
      case 'last': {
        if (!inView(lev.price)) break;
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(l.plotLeft, y);
        ctx.lineTo(l.plotRight, y);
        ctx.stroke();
        ctx.setLineDash([]);
        tags.push({ id: lev.id, y, text: priceAxisLabel(lev.price), bold: true });
        break;
      }
    }
  }
  ctx.restore();

  // Left chips — stack 20px apart.
  if (chips.length) {
    const ys = stackVertically(
      chips.map((c) => ({ id: c.id, y: c.lineY, height: 17 })),
      20,
      l.plotTop,
      l.plotBottom,
    );
    for (const c of chips) {
      drawChip(ctx, l.plotLeft + 4, ys.get(c.id) ?? c.lineY, c.text, c.color, c.border);
    }
  }

  // Axis tags — stack on the price axis side.
  if (tags.length) {
    const sizes = tags.map((t) => {
      ctx.font = t.bold ? 'bold 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' : FONT;
      return { id: t.id, y: t.y, height: 15, width: ctx.measureText(t.text).width };
    });
    const ys = stackVertically(sizes, 20, l.plotTop, l.plotBottom);
    for (const t of tags) {
      drawAxisTag(ctx, l, ys.get(t.id) ?? t.y, t.text, t.bold);
    }
  }

  // Pinned out-of-range liquidation chips.
  for (const pin of pins) {
    const y = pin.side === 'top' ? l.plotTop + 14 : l.plotBottom - 14;
    drawChip(ctx, l.plotLeft + 4, y, pin.text, VP_TOKENS.magenta, VP_TOKENS.magenta);
  }

  return { profileHitY: null };
}
