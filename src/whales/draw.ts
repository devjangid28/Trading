import type { Candle, TerminalTrade } from '../../shared/types';
import type { WhaleBubble, WhaleLevel, WhaleView } from './types';
import { WHALES_TOKENS as T } from './tokens';
import { clusterBubbles, filterAxisTags, GUTTER_CAPTION, netForView, planOverlays, TIME_LABEL_COLOR, type DrawnBubble, type PlanViewport } from './plan';
import {
  clampNumber, ema, priceHistogram, visiblePoc, whaleAverages, bubbleRadius, zoneBands, INTERVAL_MS,
} from './engine';
import type { CandleStats } from './engine';
import type { WhalesLayout } from './layout';
import {
  axisTicks, niceTimeStep, xForTime, yForPrice,
} from './layout';
import { fmtPrice, fmtSignedUsd, prettyTime } from './format';

export interface DrawState {
  bars: Candle[];
  stats: Map<number, CandleStats>;
  trades: TerminalTrade[];
  bubbles: WhaleBubble[];
  levels: WhaleLevel[];
  t0: number | null;
  netPoints: Array<{ t: number; whale: number; everyone: number }>;
  lastPrice: number | null;
  interval: keyof typeof INTERVAL_MS;
  maFast: number[];
  maSlow: number[];
}

export interface DrawOpts {
  showBubbles: boolean;
  showAvg: boolean;
  showZones: boolean;
  showVolProfile: boolean;
  showLiq: boolean;
  showLevels: boolean;
  showMa: boolean;
  showBubbleNet: boolean;
  showRef: boolean;
  showVolume: boolean;
  hover: { x: number; y: number; price: number; time: number } | null;
  /** In-view whale net, shared with the reading bar (D9 consistency). */
  expectedNet: number | null;
}

const MONO = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const MONO_BOLD = '700 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const MONO_SMALL = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function setLineDash(ctx: CanvasRenderingContext2D, dash: number[] | null): void {
  ctx.setLineDash(dash ?? []);
}

function drawLevelLine(
  ctx: CanvasRenderingContext2D,
  left: number,
  right: number,
  y: number,
  level: WhaleLevel,
): void {
  ctx.strokeStyle = level.color;
  ctx.lineWidth = 1;
  const dash = level.style === 'dashed' ? [10, 5]
    : level.style === 'dotted' ? [2, 5]
      : level.style === 'dashdot' ? [10, 4, 2, 4]
        : [];
  setLineDash(ctx, dash);
  ctx.beginPath();
  ctx.moveTo(left, Math.round(y) + 0.5);
  ctx.lineTo(right, Math.round(y) + 0.5);
  ctx.stroke();
  setLineDash(ctx, null);
}

function drawAxisTag(
  ctx: CanvasRenderingContext2D,
  axisX: number,
  axisW: number,
  y: number,
  text: string,
  color: string,
  filled: boolean,
): void {
  if (y < 8 || y > ctx.canvas.height - 8) return;
  ctx.font = MONO_BOLD;
  const width = Math.min(axisW - 6, ctx.measureText(text).width + 14);
  const x = axisX + 3;
  if (filled) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y - 11, width, 22);
    ctx.fillStyle = '#0a0e17';
  } else {
    ctx.fillStyle = 'rgba(10,14,23,0.9)';
    ctx.fillRect(x, y - 11, width, 22);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y - 11, width, 22);
    ctx.fillStyle = color;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + width / 2, y);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = T.text;
}

function levelIcon(level: WhaleLevel): string {
  if (level.kind === 'user') return '\u2605 ';
  if (level.kind === 'liq-short' || level.kind === 'liq-long') return '\u26A1 ';
  return '';
}

interface ChipStack {
  topY: number;
  bottomY: number;
}

function drawEdgeChip(
  ctx: CanvasRenderingContext2D,
  layout: WhalesLayout,
  level: WhaleLevel,
  above: boolean,
  y: number,
): void {
  ctx.font = MONO_BOLD;
  const text = `${above ? '\u25B2' : '\u25BC'} ${levelIcon(level)}${level.label} ${fmtPrice(level.price)}`;
  const tw = ctx.measureText(text).width + 12;
  const boxH = 20;
  const x = layout.plotLeft + 4;
  ctx.fillStyle = 'rgba(10,14,23,0.85)';
  ctx.fillRect(x, y, tw, boxH);
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, tw, boxH);
  ctx.fillStyle = level.color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 6, y + boxH / 2);
  ctx.textBaseline = 'alphabetic';
}

function drawLevels(
  ctx: CanvasRenderingContext2D,
  layout: WhalesLayout,
  view: WhaleView,
  levels: readonly WhaleLevel[],
  opts: DrawOpts,
  lastY: number | null,
): void {
  const stack: ChipStack = { topY: layout.priceTop + 2, bottomY: layout.volumeTop - 22 };
  const visible: WhaleLevel[] = [];
  const above: WhaleLevel[] = [];
  const below: WhaleLevel[] = [];
  for (const level of levels) {
    if (!opts.showRef && level.kind === 'ref') continue;
    if (!opts.showLiq && (level.kind === 'liq-short' || level.kind === 'liq-long')) continue;
    const y = yForPrice(level.price, view.priceMin, view.priceMax, layout.priceTop, layout.priceH);
    if (y < layout.priceTop - 6) above.push(level);
    else if (y > layout.priceTop + layout.priceH + 6) below.push(level);
    else visible.push(level);
  }
  above.sort((a, b) => Math.abs(b.price - view.priceMax) - Math.abs(a.price - view.priceMax));
  below.sort((a, b) => Math.abs(b.price - view.priceMin) - Math.abs(a.price - view.priceMin));
  for (const level of above.slice(0, 5)) {
    if (stack.topY > layout.volumeTop - 24) break;
    drawEdgeChip(ctx, layout, level, true, stack.topY);
    stack.topY += 20;
  }
  for (const level of below.slice(0, 5)) {
    if (stack.bottomY < layout.priceTop) break;
    drawEdgeChip(ctx, layout, level, false, stack.bottomY);
    stack.bottomY -= 20;
  }
  const reserved = [{ y: lastY }, { y: opts.hover ? opts.hover.y : null }].filter((r): r is { y: number } => r.y !== null && Number.isFinite(r.y));
  const candidates = visible.map((level) => ({
    level,
    y: yForPrice(level.price, view.priceMin, view.priceMax, layout.priceTop, layout.priceH),
  }));
  const kept = new Set(filterAxisTags(candidates.map((c) => ({ price: c.level.price, y: c.y })), reserved).map((t) => t.price));
  for (const c of candidates) {
    const { level, y } = c;
    drawLevelLine(ctx, layout.plotLeft, layout.plotRight, y, level);
    ctx.font = MONO_BOLD;
    const label = `${levelIcon(level)}${level.label} ${fmtPrice(level.price)}`;
    const tw = ctx.measureText(label).width + 10;
    ctx.fillStyle = 'rgba(10,14,23,0.82)';
    ctx.fillRect(layout.plotLeft + 4, y - 10, tw, 18);
    ctx.fillStyle = level.color;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, layout.plotLeft + 9, y);
    ctx.textBaseline = 'alphabetic';
    if (kept.has(level.price)) {
      drawAxisTag(ctx, layout.axisX, layout.axisW, y, fmtPrice(level.price), level.color, level.kind === 'user');
    }
  }
}

function drawWhaleIcon(ctx: CanvasRenderingContext2D, x: number, y: number, size = 10): void {
  ctx.save();
  ctx.fillStyle = '#3cc8e6';
  ctx.beginPath();
  ctx.ellipse(x, y, size * 0.62, size * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + size * 0.55, y);
  ctx.lineTo(x + size, y - size * 0.28);
  ctx.lineTo(x + size, y + size * 0.28);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - size * 0.28, y - size * 0.42);
  ctx.lineTo(x - size * 0.08, y);
  ctx.lineTo(x - size * 0.28, y + size * 0.42);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBand(
  ctx: CanvasRenderingContext2D,
  layout: WhalesLayout,
  view: WhaleView,
  bubbles: readonly WhaleBubble[],
  lastPrice: number | null,
  lastTagY: number | null,
): void {
  const inView = bubbles.filter((b) => b.t >= view.start && b.t <= view.end);
  const avg = whaleAverages(inView);
  const buyY = avg.buyAvg !== null ? yForPrice(avg.buyAvg, view.priceMin, view.priceMax, layout.priceTop, layout.priceH) : null;
  const sellY = avg.sellAvg !== null ? yForPrice(avg.sellAvg, view.priceMin, view.priceMax, layout.priceTop, layout.priceH) : null;
  if (buyY === null && sellY === null) return;

  const mid = (view.priceMin + view.priceMax) / 2;
  const minBandPx = Math.max(4, (0.0005 * mid / Math.max(1e-9, view.priceMax - view.priceMin)) * layout.priceH);
  const center = (buyY !== null && sellY !== null ? (buyY + sellY) / 2 : (buyY ?? sellY)) as number;
  const half = buyY !== null && sellY !== null
    ? Math.min(30, Math.max(minBandPx / 2, (Math.abs(buyY - sellY) + 6) / 2))
    : minBandPx / 2;

  ctx.fillStyle = T.whaleGreenSoft;
  ctx.fillRect(layout.plotLeft, center - half, layout.plotRight - layout.plotLeft, half * 2);

  if (sellY !== null) {
    ctx.strokeStyle = T.down;
    ctx.lineWidth = 1.5;
    setLineDash(ctx, [10, 4, 2, 4]);
    ctx.beginPath();
    ctx.moveTo(layout.plotLeft, Math.round(sellY) + 0.5);
    ctx.lineTo(layout.plotRight, Math.round(sellY) + 0.5);
    ctx.stroke();
    setLineDash(ctx, null);
  }
  if (buyY !== null) {
    ctx.strokeStyle = T.up;
    ctx.lineWidth = 1.5;
    setLineDash(ctx, [10, 4, 2, 4]);
    ctx.beginPath();
    ctx.moveTo(layout.plotLeft - 5, Math.round(buyY) + 0.5);
    ctx.lineTo(layout.plotRight - 5, Math.round(buyY) + 0.5);
    ctx.stroke();
    setLineDash(ctx, null);
  }

  let chipY = Math.max(layout.priceTop + 2, ((buyY ?? sellY) as number) - 26);
  if (avg.buyAvg !== null) {
    const pct = lastPrice !== null && lastPrice > 0 ? ((lastPrice / avg.buyAvg) - 1) * 100 : 0;
    ctx.font = MONO_BOLD;
    const text = `buyers' avg (price ${fmtPctAbs(pct)}) ${fmtPrice(avg.buyAvg)}`;
    const tw = ctx.measureText(text).width + 36;
    ctx.fillStyle = 'rgba(10,14,23,0.88)';
    ctx.fillRect(layout.plotLeft + 4, chipY, tw, 20);
    drawWhaleIcon(ctx, layout.plotLeft + 14, chipY + 10);
    ctx.fillStyle = T.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, layout.plotLeft + 24, chipY + 10);
    ctx.textBaseline = 'alphabetic';
    chipY += 20;
  }
  if (avg.sellAvg !== null) {
    const pct = lastPrice !== null && lastPrice > 0 ? ((lastPrice / avg.sellAvg) - 1) * 100 : 0;
    ctx.font = MONO_BOLD;
    const text = `sellers' avg (price ${fmtPctAbs(pct)}) ${fmtPrice(avg.sellAvg)}`;
    const tw = ctx.measureText(text).width + 36;
    ctx.fillStyle = 'rgba(10,14,23,0.88)';
    ctx.fillRect(layout.plotLeft + 4, chipY, tw, 20);
    drawWhaleIcon(ctx, layout.plotLeft + 14, chipY + 10);
    ctx.fillStyle = T.text;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, layout.plotLeft + 24, chipY + 10);
    ctx.textBaseline = 'alphabetic';
  }

  if (buyY !== null && avg.buyAvg !== null && (lastTagY === null || Math.abs(buyY - lastTagY) > 24)) {
    drawAxisTag(ctx, layout.axisX, layout.axisW, buyY, fmtPrice(avg.buyAvg), T.up, false);
  }
  if (sellY !== null && avg.sellAvg !== null && (lastTagY === null || Math.abs(sellY - lastTagY) > 24)) {
    drawAxisTag(ctx, layout.axisX, layout.axisW, sellY, fmtPrice(avg.sellAvg), T.down, false);
  }
}

function fmtPctAbs(v: number): string {
  return `${v >= 0 ? '+' : '\u2212'}${Math.abs(v).toFixed(2)}%`;
}

function drawLastPrice(
  ctx: CanvasRenderingContext2D,
  layout: WhalesLayout,
  view: WhaleView,
  price: number,
): number {
  const y = yForPrice(price, view.priceMin, view.priceMax, layout.priceTop, layout.priceH);
  ctx.strokeStyle = T.lastPrice;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.82;
  setLineDash(ctx, [8, 3, 2, 3]);
  ctx.beginPath();
  ctx.moveTo(layout.plotLeft, Math.round(y) + 0.5);
  ctx.lineTo(layout.plotRight, Math.round(y) + 0.5);
  ctx.stroke();
  setLineDash(ctx, null);
  ctx.globalAlpha = 1;
  drawAxisTag(ctx, layout.axisX, layout.axisW, y, fmtPrice(price), '#ffffff', true);
  return y;
}

export function bubbleAtPoint(
  layout: WhalesLayout,
  view: WhaleView,
  bubbles: readonly WhaleBubble[],
  x: number,
  y: number,
): WhaleBubble | null {
  let best: WhaleBubble | null = null;
  let bestDist = 14;
  for (const b of bubbles) {
    const bx = xForTime(b.t, view.start, view.end, layout.plotLeft, layout.plotRight - layout.plotLeft);
    const by = yForPrice(b.price, view.priceMin, view.priceMax, layout.priceTop, layout.priceH);
    const r = bubbleRadius(b.notional);
    const d = Math.hypot(bx - x, by - y);
    if (d <= Math.max(r + 3, 10) && d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

function drawBubbles(
  ctx: CanvasRenderingContext2D,
  layout: WhalesLayout,
  view: WhaleView,
  bubbles: readonly WhaleBubble[],
  opts: DrawOpts,
  t0: number | null,
): void {
  const vp: PlanViewport = {
    plotLeft: layout.plotLeft,
    plotRight: layout.plotRight,
    plotTop: layout.priceTop,
    plotBottom: layout.priceTop + layout.priceH,
    priceMin: view.priceMin,
    priceMax: view.priceMax,
    start: view.start,
    end: view.end,
  };
  const drawn = clusterBubbles(bubbles, vp, t0);
  const hoverBubble = opts.hover
    ? bubbleAtPoint(layout, view, bubbles, opts.hover.x, opts.hover.y)
    : null;
  const byId = new Map<string, DrawnBubble>();
  for (const d of drawn) byId.set(d.bubble.id, d);

  for (const d of drawn) {
    const { bubble: b, x, y, r } = d;
    const buyShare = b.notional > 0 ? b.buyUsd / b.notional : 0;

    ctx.globalAlpha = 0.95;
    ctx.fillStyle = 'rgba(217,69,61,0.6)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, r, -Math.PI / 2 + buyShare * Math.PI * 2, Math.PI * 1.5);
    ctx.closePath();
    ctx.fill();
    if (buyShare > 0) {
      ctx.fillStyle = 'rgba(38,166,91,0.6)';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + buyShare * Math.PI * 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const hovered = hoverBubble !== null && hoverBubble.id === b.id;
    if (hovered) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = T.whaleGreen;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  const { tags, labels } = planOverlays(drawn, vp, 3);
  for (const label of labels) {
    ctx.font = MONO_BOLD;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(10,14,23,0.9)';
    ctx.strokeText(label.text, label.x + label.w / 2, label.y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label.text, label.x + label.w / 2, label.y);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
  }
  for (const tag of tags) {
    const d = byId.get(tag.bubbleId);
    if (d) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(d.x - 4, d.y - d.r - 2);
      ctx.lineTo(d.x + 4, d.y - d.r - 2);
      ctx.lineTo(d.x, d.y - d.r - 10);
      ctx.closePath();
      ctx.fill();
    }
    ctx.font = MONO_BOLD;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(10,14,23,0.9)';
    ctx.strokeText(tag.text, tag.x, tag.y);
    ctx.fillStyle = tag.color;
    ctx.fillText(tag.text, tag.x, tag.y);
    ctx.textBaseline = 'alphabetic';
  }
}

export function drawWhales(
  ctx: CanvasRenderingContext2D,
  layout: WhalesLayout,
  s: DrawState,
  view: WhaleView,
  opts: DrawOpts,
): void {
  if (layout.w <= 0 || layout.h <= 0) return;
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, layout.w, layout.h);

  const plotW = layout.plotRight - layout.plotLeft;
  const span = Math.max(1, view.end - view.start);

  drawPanelSeparators(ctx, layout);
  drawPricePanel(ctx, layout, s, view, opts, plotW, span);
  drawBubbleHistogram(ctx, layout, s, view, opts.showVolProfile);
  if (opts.showVolume) drawVolumePanel(ctx, layout, s, view, plotW, span);
  if (opts.showBubbleNet) drawNetPanel(ctx, layout, s, view, plotW, span, opts.expectedNet);
  drawTimeAxis(ctx, layout, view, INTERVAL_MS[s.interval], plotW, span);
  if (opts.hover) drawCrosshair(ctx, layout, view, opts.hover);
}

function drawPanelSeparators(ctx: CanvasRenderingContext2D, layout: WhalesLayout): void {
  ctx.fillStyle = T.panel;
  ctx.fillRect(0, layout.volumeTop - 1, layout.w, 1);
  ctx.fillRect(0, layout.netTop - 1, layout.w, 1);
  ctx.fillStyle = '#0c111c';
  ctx.fillRect(layout.plotLeft, layout.volumeTop + 1, layout.w, layout.volumeH);
  ctx.fillRect(layout.plotLeft, layout.netTop + 1, layout.w, layout.netH);
  ctx.fillStyle = T.sep;
  ctx.fillRect(0, layout.volumeTop - 1, layout.w, 1);
  ctx.fillRect(0, layout.netTop - 1, layout.w, 1);
  ctx.fillRect(layout.gutterX - 1, layout.top, 1, layout.timeTop - layout.top);
  ctx.fillRect(layout.axisX - 1, layout.top, 1, layout.timeTop - layout.top);
  ctx.fillStyle = '#0b101b';
  ctx.fillRect(layout.gutterX, layout.gutterTop, layout.gutterW, layout.gutterH);
}

function drawPricePanel(
  ctx: CanvasRenderingContext2D,
  layout: WhalesLayout,
  s: DrawState,
  view: WhaleView,
  opts: DrawOpts,
  plotW: number,
  span: number,
): void {
  const y0 = layout.priceTop;
  const h = layout.priceH;
  const stepMs = INTERVAL_MS[s.interval];
  const barW = Math.max(1, (plotW / Math.max(1, span / stepMs)) * 0.7);

  const ticks = axisTicks(view.priceMin, view.priceMax, 200);
  ctx.font = MONO;
  ctx.fillStyle = T.muted;
  for (const tick of ticks.values) {
    const y = yForPrice(tick, view.priceMin, view.priceMax, y0, h);
    if (y < y0 + 4 || y > y0 + h - 3) continue;
    ctx.strokeStyle = 'rgba(107,118,134,0.14)';
    ctx.beginPath();
    ctx.moveTo(layout.plotLeft, Math.round(y) + 0.5);
    ctx.lineTo(layout.plotRight, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(107,118,134,0.5)';
    ctx.beginPath();
    ctx.moveTo(layout.axisX + 1, Math.round(y));
    ctx.lineTo(layout.axisX + 5, Math.round(y));
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtPrice(tick), layout.axisX + layout.axisW - 4, y);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
  }

  if (opts.showZones) {
    drawZones(ctx, layout, view, s.bubbles);
  }

  const firstVisible = Math.max(0, s.bars.findIndex((b) => b.t + stepMs >= view.start));
  for (let i = firstVisible; i < s.bars.length; i++) {
    const bar = s.bars[i];
    if (bar.t > view.end) break;
    const x = xForTime(bar.t + stepMs / 2, view.start, view.end, layout.plotLeft, plotW);
    if (x < layout.plotLeft - barW || x > layout.plotRight + barW) continue;
    const up = bar.c >= bar.o;
    const color = up ? T.up : T.down;
    const yH = yForPrice(bar.h, view.priceMin, view.priceMax, y0, h);
    const yL = yForPrice(bar.l, view.priceMin, view.priceMax, y0, h);
    const yO = yForPrice(bar.o, view.priceMin, view.priceMax, y0, h);
    const yC = yForPrice(bar.c, view.priceMin, view.priceMax, y0, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yH);
    ctx.lineTo(x, yL);
    ctx.stroke();
    const bodyTop = Math.min(yO, yC);
    const bodyH = Math.max(1, Math.abs(yC - yO));
    ctx.fillStyle = color;
    ctx.fillRect(x - barW / 2, bodyTop, barW, bodyH);
  }

  if (opts.showMa) {
    const drawMa = (values: readonly number[], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let i = firstVisible; i < s.bars.length && i < values.length; i++) {
        const bar = s.bars[i];
        if (bar.t > view.end) break;
        const x = xForTime(bar.t + stepMs / 2, view.start, view.end, layout.plotLeft, plotW);
        const y = yForPrice(values[i], view.priceMin, view.priceMax, y0, h);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    drawMa(s.maFast, T.maFast);
    drawMa(s.maSlow, T.maSlow);
  }

  if (opts.showLevels) {
    const lastY = s.lastPrice !== null && s.lastPrice > view.priceMin && s.lastPrice < view.priceMax
      ? yForPrice(s.lastPrice, view.priceMin, view.priceMax, y0, h)
      : null;
    drawLevels(ctx, layout, view, s.levels, opts, lastY);
  }

  if (s.t0 !== null && s.t0 > view.start && s.t0 < view.end) {
    const x0 = xForTime(s.t0, view.start, view.end, layout.plotLeft, plotW);
    ctx.strokeStyle = T.t0;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x0) + 0.5, layout.priceTop);
    ctx.lineTo(Math.round(x0) + 0.5, layout.priceTop + layout.priceH);
    ctx.stroke();
    const label = 'no trades recorded before \u25b8';
    ctx.font = MONO_BOLD;
    const tw = ctx.measureText(label).width;
    const lx = Math.max(layout.plotLeft + 4, x0 - tw - 10);
    ctx.fillStyle = T.gold;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx, layout.priceTop + 12);
    ctx.textBaseline = 'alphabetic';
  }

  let lastTagY: number | null = null;
  if (s.lastPrice !== null && s.lastPrice > view.priceMin && s.lastPrice < view.priceMax) {
    lastTagY = drawLastPrice(ctx, layout, view, s.lastPrice);
  }

  if (opts.showAvg) {
    drawBand(ctx, layout, view, s.bubbles, s.lastPrice, lastTagY);
  }

  if (opts.showBubbles) {
    drawBubbles(ctx, layout, view, s.bubbles, opts, s.t0);
  }
}

function drawZones(
  ctx: CanvasRenderingContext2D,
  layout: WhalesLayout,
  view: WhaleView,
  bubbles: readonly WhaleBubble[],
): void {
  const bands = zoneBands(bubbles, view.priceMin, view.priceMax, 140, 2);
  for (const band of bands) {
    const yHigh = yForPrice(band.high, view.priceMin, view.priceMax, layout.priceTop, layout.priceH);
    const yLow = yForPrice(band.low, view.priceMin, view.priceMax, layout.priceTop, layout.priceH);
    const top = Math.min(yHigh, yLow);
    const h = Math.max(2, Math.abs(yLow - yHigh));
    if (top + h < layout.priceTop || top > layout.priceTop + layout.priceH) continue;
    ctx.fillStyle = band.side === 'buy' ? 'rgba(38,166,91,0.10)' : 'rgba(217,69,61,0.10)';
    ctx.fillRect(layout.plotLeft, top, layout.plotRight - layout.plotLeft, h);
    ctx.strokeStyle = band.side === 'buy' ? 'rgba(61,220,132,0.35)' : 'rgba(217,69,61,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(layout.plotLeft, top, layout.plotRight - layout.plotLeft, h);
  }
}

/**
 * D8: the right gutter is ALWAYS the "bubbles/price" histogram (red-left /
 * green-right, rows >= 3px, longest bar ~90px). The Vol profile toggle draws a
 * faint blue candle-volume layer behind it, never in place of it.
 */
function drawBubbleHistogram(
  ctx: CanvasRenderingContext2D,
  layout: WhalesLayout,
  s: DrawState,
  view: WhaleView,
  showVolProfile: boolean,
): void {
  const gutterX = layout.gutterX;
  const gutterW = layout.gutterW;
  const rowH = 3;
  const rows = Math.max(8, Math.floor(layout.gutterH / rowH));
  const step = layout.gutterH / rows;
  const bubbleHist = priceHistogram(s.bubbles, view.priceMin, view.priceMax, rows);

  const maxLen = Math.min(90, gutterW - 8);
  let maxBubble = 1;
  for (let i = 0; i < rows; i++) maxBubble = Math.max(maxBubble, bubbleHist[i].buyUsd + bubbleHist[i].sellUsd);

  if (showVolProfile) {
    const vol = new Float64Array(rows);
    const stepMs = INTERVAL_MS[s.interval];
    for (const bar of s.bars) {
      if (bar.t + stepMs < view.start || bar.t > view.end) continue;
      const idx = clampNumber(Math.floor((view.priceMax - (bar.o + bar.c) / 2) / Math.max(1e-9, view.priceMax - view.priceMin) * rows), 0, rows - 1);
      vol[idx] += bar.qv ?? bar.v * ((bar.o + bar.c) / 2);
    }
    let maxVol = 1;
    for (let i = 0; i < rows; i++) maxVol = Math.max(maxVol, vol[i]);
    for (let i = 0; i < rows; i++) {
      if (vol[i] <= 0) continue;
      const len = Math.max(1, (vol[i] / maxVol) * maxLen);
      ctx.fillStyle = 'rgba(60,200,230,0.10)';
      ctx.fillRect(gutterX + gutterW - 4 - len, layout.gutterTop + i * step + 1, len, Math.max(2, step - 1));
    }
  }

  ctx.font = MONO_SMALL;
  ctx.fillStyle = T.muted;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(GUTTER_CAPTION, gutterX + gutterW - 4, layout.gutterTop + 9);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  for (let i = 0; i < rows; i++) {
    const row = bubbleHist[i];
    const yTop = layout.gutterTop + i * step;
    const total = row.buyUsd + row.sellUsd;
    if (total <= 0) continue;
    const len = Math.max(2, (total / maxBubble) * maxLen);
    const buyLen = row.buyUsd > 0 ? Math.max(1, (row.buyUsd / total) * len) : 0;
    const sellLen = len - buyLen;
    ctx.fillStyle = 'rgba(217,69,61,0.75)';
    ctx.fillRect(gutterX + gutterW - 4 - len, yTop + 1, sellLen, Math.max(2, step - 1));
    ctx.fillStyle = 'rgba(38,166,91,0.75)';
    ctx.fillRect(gutterX + gutterW - 4 - buyLen, yTop + 1, buyLen, Math.max(2, step - 1));
  }
}



function drawVolumePanel(
  ctx: CanvasRenderingContext2D,
  layout: WhalesLayout,
  s: DrawState,
  view: WhaleView,
  plotW: number,
  span: number,
): void {
  const stepMs = INTERVAL_MS[s.interval];
  const count = Math.max(1, span / stepMs);
  const slot = plotW / count;
  const barW = Math.max(1, slot - 1);
  let maxVol = 1;
  const visible = s.bars.filter((b) => b.t + stepMs >= view.start && b.t <= view.end);
  for (const bar of visible) {
    const stat = s.stats.get(bar.t);
    maxVol = Math.max(maxVol, stat ? stat.buyUsd + stat.sellUsd : (bar.qv ?? 1));
  }
  const bottom = layout.volumeTop + layout.volumeH - 4;
  for (const bar of visible) {
    const stat = s.stats.get(bar.t);
    const total = stat ? stat.buyUsd + stat.sellUsd : (bar.qv ?? 0);
    if (total <= 0) continue;
    const buy = stat ? stat.buyUsd : (bar.takerBuyQuote ?? total / 2);
    const x = xForTime(bar.t + stepMs / 2, view.start, view.end, layout.plotLeft, plotW);
    const h = (Math.min(total, maxVol) / maxVol) * (layout.volumeH - 8);
    const buyH = (buy / total) * h;
    ctx.fillStyle = 'rgba(38,166,91,0.55)';
    ctx.fillRect(x - barW / 2, bottom - buyH, barW, buyH);
    ctx.fillStyle = 'rgba(217,69,61,0.55)';
    ctx.fillRect(x - barW / 2, bottom - buyH - (h - buyH), barW, h - buyH);
  }
}

function drawNetPanel(
  ctx: CanvasRenderingContext2D,
  layout: WhalesLayout,
  s: DrawState,
  view: WhaleView,
  plotW: number,
  span: number,
  expectedNet: number | null,
): void {
  const stepMs = INTERVAL_MS[s.interval];
  const top = layout.netTop;
  const h = layout.netH;
  const baseline = top + h * 0.66;
  const floorT = s.t0 ?? -Infinity;
  const vp: PlanViewport = {
    plotLeft: layout.plotLeft,
    plotRight: layout.plotRight,
    plotTop: top,
    plotBottom: top + h,
    priceMin: view.priceMin,
    priceMax: view.priceMax,
    start: view.start,
    end: view.end,
  };
  const viewNet = netForView(s.netPoints.filter((p) => p.t >= floorT), vp);
  const points = viewNet.perCandle;

  let maxWhaleBar = 1;
  let maxEveryoneBar = 1;
  let maxWhaleCum = 1;
  let maxEveryoneCum = 1;
  let whaleCum = 0;
  let everyoneCum = 0;
  for (const p of points) {
    maxWhaleBar = Math.max(maxWhaleBar, Math.abs(p.whale));
    maxEveryoneBar = Math.max(maxEveryoneBar, Math.abs(p.everyone));
    whaleCum += p.whale;
    everyoneCum += p.everyone;
    maxWhaleCum = Math.max(maxWhaleCum, Math.abs(whaleCum));
    maxEveryoneCum = Math.max(maxEveryoneCum, Math.abs(everyoneCum));
  }
  const headerNet = expectedNet !== null ? expectedNet : viewNet.headerNet;
  maxWhaleCum = Math.max(maxWhaleCum, Math.abs(headerNet));

  const barW = Math.max(1, (plotW / Math.max(1, span / stepMs)) - 1);
  const yForWhaleBar = (v: number) => baseline - (v / Math.max(1, maxWhaleBar)) * (h * 0.45);
  const yForCum = (v: number, maxCum: number) => baseline - (v / Math.max(1, maxCum)) * (baseline - top - 4);

  ctx.fillStyle = 'rgba(107,118,134,0.18)';
  ctx.fillRect(layout.plotLeft, baseline, plotW, 1);

  for (const p of points) {
    if (p.whale === 0) continue;
    const x = xForTime(p.t + stepMs / 2, view.start, view.end, layout.plotLeft, plotW);
    const y = yForWhaleBar(p.whale);
    ctx.fillStyle = p.whale >= 0 ? 'rgba(61,220,132,0.5)' : 'rgba(217,69,61,0.5)';
    ctx.fillRect(x - barW / 2, Math.min(y, baseline), barW, Math.max(1, Math.abs(y - baseline)));
  }

  whaleCum = 0;
  everyoneCum = 0;
  const whalePath: Array<{ x: number; y: number; cum: number }> = [];
  const everyonePath: Array<{ x: number; y: number }> = [];
  for (const p of points) {
    whaleCum += p.whale;
    everyoneCum += p.everyone;
    const x = xForTime(p.t + stepMs / 2, view.start, view.end, layout.plotLeft, plotW);
    whalePath.push({ x, y: yForCum(whaleCum, maxWhaleCum), cum: whaleCum });
    everyonePath.push({ x, y: yForCum(everyoneCum, maxEveryoneCum) });
  }
  for (let i = 1; i < whalePath.length; i++) {
    const a = whalePath[i - 1];
    const b = whalePath[i];
    ctx.strokeStyle = a.cum >= 0 ? T.whaleGreen : T.down;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  if (everyonePath.length > 1) {
    ctx.strokeStyle = T.cyan;
    ctx.lineWidth = 1.2;
    setLineDash(ctx, [5, 4]);
    ctx.beginPath();
    ctx.moveTo(everyonePath[0].x, everyonePath[0].y);
    for (let i = 1; i < everyonePath.length; i++) ctx.lineTo(everyonePath[i].x, everyonePath[i].y);
    ctx.stroke();
    setLineDash(ctx, null);
  }

  ctx.font = MONO_SMALL;
  ctx.fillStyle = T.muted;
  const t0Label = s.t0 !== null ? prettyTime(s.t0) : '\u2014';
  const head = `bubble net (bought \u2212 sold in bubbles) since ${t0Label}: `;
  let cx = layout.plotLeft + 4;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(head, cx, top + 9);
  cx += ctx.measureText(head).width;
  ctx.fillStyle = headerNet >= 0 ? T.whaleGreen : T.down;
  const netText = fmtSignedUsd(headerNet);
  ctx.fillText(`${netText} `, cx, top + 9);
  cx += ctx.measureText(`${netText} `).width;
  ctx.fillStyle = T.muted;
  const midText = '. bars = per candle   ';
  ctx.fillText(midText, cx, top + 9);
  cx += ctx.measureText(midText).width;
  ctx.strokeStyle = T.cyan;
  ctx.lineWidth = 1;
  setLineDash(ctx, [5, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, top + 9);
  ctx.lineTo(cx + 34, top + 9);
  ctx.stroke();
  setLineDash(ctx, null);
  cx += 40;
  ctx.fillStyle = T.cyan;
  ctx.fillText(`everyone else: ${fmtSignedUsd(everyoneCum)} `, cx, top + 9);
  cx += ctx.measureText(`everyone else: ${fmtSignedUsd(everyoneCum)} `).width;
  ctx.fillStyle = T.muted;
  ctx.fillText('(own scale)', cx, top + 9);
  ctx.textBaseline = 'alphabetic';
}

function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  layout: WhalesLayout,
  view: WhaleView,
  stepMs: number,
  plotW: number,
  span: number,
): void {
  const baseStep = 10 * stepMs;
  const step = span / baseStep >= 2 ? baseStep : niceTimeStep(span, plotW);
  const first = Math.ceil(view.start / step) * step;
  ctx.font = MONO;
  ctx.fillStyle = TIME_LABEL_COLOR;
  for (let t = first; t <= view.end; t += step) {
    const x = xForTime(t, view.start, view.end, layout.plotLeft, plotW);
    if (x < layout.plotLeft + 20 || x > layout.plotRight - 20) continue;
    ctx.strokeStyle = 'rgba(107,118,134,0.12)';
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, layout.priceTop);
    ctx.lineTo(Math.round(x) + 0.5, layout.netTop + layout.netH);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(prettyTime(t), x, layout.timeTop + layout.timeH / 2);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = 'rgba(16,20,31,0.94)';
  ctx.fillRect(0, layout.timeTop, layout.w, layout.timeH);
  ctx.fillStyle = T.sep;
  ctx.fillRect(0, layout.timeTop, layout.w, 1);
}

function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  layout: WhalesLayout,
  view: WhaleView,
  hover: { x: number; y: number; price: number; time: number },
): void {
  ctx.strokeStyle = T.crosshair;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(hover.x) + 0.5, layout.priceTop);
  ctx.lineTo(Math.round(hover.x) + 0.5, layout.timeTop);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(layout.plotLeft, Math.round(hover.y) + 0.5);
  ctx.lineTo(layout.plotRight, Math.round(hover.y) + 0.5);
  ctx.stroke();

  const y = yForPrice(hover.price, view.priceMin, view.priceMax, layout.priceTop, layout.priceH);
  ctx.font = MONO_BOLD;
  const text = fmtPrice(hover.price);
  const width = Math.min(layout.axisW - 6, ctx.measureText(text).width + 14);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(layout.axisX + 3, y - 10, width, 20);
  ctx.fillStyle = '#0a0e17';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, layout.axisX + 3 + width / 2, y);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const timeLabel = prettyTime(hover.time, true);
  ctx.font = MONO_BOLD;
  const tw = ctx.measureText(timeLabel).width + 12;
  const tx = clampNumber(hover.x - tw / 2, layout.plotLeft + 2, layout.plotRight - tw - 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(tx, layout.timeTop + 2, tw, 14);
  ctx.fillStyle = '#0a0e17';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(timeLabel, tx + tw / 2, layout.timeTop + 9);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
}

export { ema, visiblePoc };
