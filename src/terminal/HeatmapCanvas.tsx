import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Candle, LiqEvent, TerminalBook, TerminalInterval, TerminalTrade,
} from '../../shared/types';
import type { BookFrame, PullEvent } from './math';
import { INTERVAL_MS, nearestWalls, priceDecimals, pullEvents, snapPrice } from './math';
import type { BubblePoint, CellHit } from './heatmap';
import {
  bubblePoints, bubbleRadius, cellAt, clampNumber, frameAt, frameRowTotals, heatColor,
  localClock, nicePriceTicks, percentile, plainPrice, priceToY, rowCountFor, rowIndexForPrice,
  SPAN_MS, sparseIntensity, sparseThresholds, stepMsFor, timeToX, tooltipPosition,
  volumeBuckets, wallAt, xToTime, yToPrice,
} from './heatmap';
import type { HeatmapSettings } from './settings';
import {
  BUBBLE_FLOOR_PCT, BUBBLE_FLOOR_USD, BUBBLE_SCALE, MIN_WALL_USD, RANGE_PCT, WALL_NEAR_PCT,
} from './settings';
import type { GexSnapshot, LevelLine, PlanContext } from './levels';
import {
  gammaLines, liqClusters, liqLines, planLines, userLines,
} from './levels';
import { drawColumns, columnWidth } from './DepthColumns';
import { fmtUsd } from '../lib/format';

const TIME_H = 20;
const AXIS_W = 92;
const AXIS_W_SMALL = 76;
const HEADER_H = 36;
const MIN_AUTO_SPAN_PCT = 0.00018;
const WALL_MARGIN = 95;
const TOOLTIP_W = 300;

interface Geometry {
  w: number;
  h: number;
  top: number;
  plotRight: number;
  dataRight: number;
  dataW: number;
  wallMargin: number;
  axisX: number;
  axisW: number;
  plotW: number;
  timeTop: number;
  volumeTop: number;
  cvdTop: number;
  plotBottom: number;
  plotH: number;
  rows: number;
  rowH: number;
  colRows: number;
  colRowH: number;
  columns: HeatmapSettings['columns'];
  colsW: number;
  bottom: number;
}

interface Dims {
  w: number;
  h: number;
}

export interface LayerToggles {
  plan: boolean;
  gamma: boolean;
  liq: boolean;
}

export interface HeatmapCanvasProps {
  symbol: string;
  book: TerminalBook | null;
  frames: BookFrame[];
  trades: TerminalTrade[];
  candles: Candle[];
  interval: TerminalInterval;
  settings: HeatmapSettings;
  plan: PlanContext;
  layers: LayerToggles;
  gamma: GexSnapshot | null;
  gammaError: string | null;
  liqEvents: LiqEvent[];
  liqError: string | null;
  userLevels: number[];
  onToggleUserLevel: (price: number) => void;
  loading: boolean;
  error: string | null;
  tapeError: string | null;
  streamState: string;
  resolutionLabel: string;
  historyFrom: number | null;
}

interface HoverState {
  x: number;
  y: number;
  price: number;
  time: number;
  cell: CellHit | null;
  bubble: BubblePoint | null;
  pull: PullEvent | null;
  columnKey: string | null;
  columnLow: number | null;
  columnHigh: number | null;
}

interface DragState {
  x: number;
  y: number;
  end: number;
  center: number;
  span: number;
  moved: boolean;
  mode: 'time' | 'price';
}

interface HeatCache {
  key: string;
  canvas: HTMLCanvasElement | null;
}

interface LiquidityAdd {
  t: number;
  price: number;
  usd: number;
  side: 'bid' | 'ask';
}

function chooseTimeStep(spanMs: number, width: number): number {
  const candidates = [
    1_000, 5_000, 15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000,
    15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 3_600_000, 4 * 3_600_000,
    6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000, 2 * 86_400_000,
  ];
  for (const step of candidates) {
    if ((step / Math.max(1, spanMs)) * width >= 110) return step;
  }
  return candidates[candidates.length - 1];
}

function tickLabel(t: number): string {
  return localClock(t, false);
}

function niceRange(
  latest: BookFrame | null,
  mid: number,
  range: HeatmapSettings['range'],
  trades: readonly TerminalTrade[],
): { min: number; max: number } {
  if (!(mid > 0)) return { min: 0, max: 1 };
  if (range !== 'auto') {
    const pct = RANGE_PCT[range];
    const half = mid * pct;
    return { min: mid - half, max: mid + half };
  }
  let low = Infinity;
  let high = -Infinity;
  if (latest?.lattice) {
    const step = latest.lattice.binBps / 10_000;
    let lastBid = -1;
    let lastAsk = -1;
    for (let i = 0; i < latest.lattice.binsPerSide; i++) {
      if ((latest.lattice.bids[i] ?? 0) > 0) lastBid = i;
      if ((latest.lattice.asks[i] ?? 0) > 0) lastAsk = i;
    }
    if (lastBid >= 0) low = latest.mid * (1 - (lastBid + 1) * step);
    if (lastAsk >= 0) high = latest.mid * (1 + (lastAsk + 1) * step);
  } else if (latest && latest.bids.length) {
    for (const level of latest.bids.slice(0, 700)) low = Math.min(low, level.price);
    for (const level of latest.asks.slice(0, 700)) high = Math.max(high, level.price);
  }
  for (const trade of trades) {
    if (!(trade.price > 0)) continue;
    low = Math.min(low, trade.price);
    high = Math.max(high, trade.price);
  }
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    low = mid * (1 - 0.0008);
    high = mid * (1 + 0.0008);
  }
  const pad = Math.max((high - low) * 0.08, mid * MIN_AUTO_SPAN_PCT, mid * 0.00002);
  low -= pad;
  high += pad;
  return { min: low, max: high };
}

function priceText(price: number, min: number): string {
  const decimals = min >= 1_000 ? 2 : priceDecimals(min);
  return plainPrice(price, decimals);
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function prepare(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(w * dpr));
  const height = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

function drawChevron(ctx: CanvasRenderingContext2D, x: number, y: number, up: boolean, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < 2; i++) {
    const dy = up ? i * 4 : -i * 4;
    ctx.beginPath();
    ctx.moveTo(x - 5, y + dy + (up ? 3 : -3));
    ctx.lineTo(x, y + dy);
    ctx.lineTo(x + 5, y + dy + (up ? 3 : -3));
    ctx.stroke();
  }
  ctx.restore();
}

function formatWallUsd(usd: number): string {
  return `$${usd >= 1e6 ? `${(usd / 1e6).toFixed(1)}M` : `${(usd / 1e3).toFixed(0)}K`}`;
}

function drawWallBadge(
  ctx: CanvasRenderingContext2D,
  wall: { side: 'bid' | 'ask'; usd: number },
  x: number,
  y: number,
): void {
  const color = wall.side === 'bid' ? '#4ade80' : '#f87171';
  const text = formatWallUsd(wall.usd);
  const width = ctx.measureText(text).width + 8;
  ctx.fillStyle = 'rgba(5,7,13,0.74)';
  roundedRect(ctx, x - width, y - 7, width, 14, 3);
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, x - width + 4, y);
  ctx.textBaseline = 'alphabetic';
}

function standingText(ms: number): string {
  if (ms < 1_000) return 'under 1s';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1_000);
  if (secs === 0) return `${mins} min`;
  return `${mins}m ${secs}s`;
}

function nearestTick(value: number, ticks: readonly number[]): number {
  if (!ticks.length) return value;
  let best = ticks[0];
  for (const tick of ticks) if (Math.abs(tick - value) < Math.abs(best - value)) best = tick;
  return best;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface TipLine {
  text: string;
  color: string;
  font: string;
}

function drawTooltip(
  ctx: CanvasRenderingContext2D,
  hover: HoverState,
  priceMin: number,
  priceSpan: number,
  walls: ReturnType<typeof nearestWalls>,
  g: Geometry,
): void {
  const bodyW = TOOLTIP_W - 20;
  const lines: TipLine[] = [];
  const push = (text: string, color: string, font: string) => {
    ctx.font = font;
    for (const line of wrapText(ctx, text, bodyW)) lines.push({ text: line, color, font });
  };
  const mono = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  const bold = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
  const muted = '#8b93a1';

  if (hover.bubble) {
    const bubble = hover.bubble;
    push(
      `${bubble.side === 'buy' ? 'BUY' : 'SELL'} ${fmtUsd(bubble.usd)} \u00b7 ${bubble.qty.toFixed(2)} BTC @ ${priceText(bubble.price, priceMin)} \u00b7 ${localClock(bubble.t)}`,
      bubble.side === 'buy' ? '#86efac' : '#fca5a5',
      bold,
    );
    push(
      bubble.aggregated
        ? `aggregated over ${Math.max(1, Math.round((bubble.lastT - bubble.firstT) / 1_000))}s`
        : 'single aggregate print',
      muted,
      mono,
    );
  } else if (hover.pull) {
    push(
      `${hover.pull.side} pulled \u00b7 ${fmtUsd(hover.pull.usd)} \u00b7 stood ${standingText(hover.pull.standingMs)}`,
      hover.pull.side === 'bid' ? '#86efac' : '#fca5a5',
      bold,
    );
    push('No trade at this price between snapshots \u2014 a cancel, not a fill.', muted, mono);
  } else if (hover.cell) {
    const cell = hover.cell;
    push(
      cell.bidUsd <= 0 && cell.askUsd <= 0
        ? 'no resting size recorded at this price'
        : `resting at this price: ${[
          cell.bidUsd > 0 ? `bid ${fmtUsd(cell.bidUsd)}` : '',
          cell.askUsd > 0 ? `ask ${fmtUsd(cell.askUsd)}` : '',
        ].filter(Boolean).join(' \u00b7 ')}`,
      '#e5e7eb',
      bold,
    );
    push(
      `${priceText(cell.low, priceMin)} \u2013 ${priceText(cell.high, priceMin)} \u00b7 ${cell.frame.source === 'history' ? 'captured history' : 'recorded snapshot'}`,
      muted,
      mono,
    );
    const wall = wallAt(walls, hover.price, priceSpan * 0.0025);
    if (wall) push(`nearest wall ${fmtUsd(wall.usd)} at ${priceText(wall.price, priceMin)} (${wall.distanceBps.toFixed(1)} bps)`, muted, mono);
  } else if (hover.columnKey) {
    push(hover.columnKey.toUpperCase(), '#e5e7eb', bold);
    if (hover.columnLow !== null && hover.columnHigh !== null) {
      push(`${priceText(hover.columnLow, priceMin)} \u2013 ${priceText(hover.columnHigh, priceMin)}`, muted, mono);
    }
    push('Column rows share the heatmap price scale.', muted, mono);
  }

  const headH = 31;
  const lineH = 15;
  const height = headH + lines.length * lineH + 10;
  const tip = tooltipPosition(hover.x, hover.y, TOOLTIP_W, height, g.w, g.h, 14, 6);
  ctx.save();
  roundedRect(ctx, tip.left, tip.top, TOOLTIP_W, height, 5);
  ctx.fillStyle = 'rgba(9,12,20,0.97)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(148,163,184,0.22)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = bold;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e5e7eb';
  ctx.fillText(priceText(hover.bubble?.price ?? hover.pull?.price ?? hover.price, priceMin), tip.left + 10, tip.top + 13);
  ctx.font = mono;
  ctx.textAlign = 'right';
  ctx.fillStyle = muted;
  ctx.fillText(localClock(hover.bubble?.t ?? hover.pull?.t ?? hover.time), tip.left + TOOLTIP_W - 10, tip.top + 13);
  ctx.strokeStyle = 'rgba(148,163,184,0.16)';
  ctx.beginPath();
  ctx.moveTo(tip.left + 10, tip.top + headH - 1.5);
  ctx.lineTo(tip.left + TOOLTIP_W - 10, tip.top + headH - 1.5);
  ctx.stroke();

  ctx.textAlign = 'left';
  let y = tip.top + headH + 9;
  for (const line of lines) {
    ctx.font = line.font;
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, tip.left + 10, y);
    y += lineH;
  }
  ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

export function HeatmapCanvas(props: HeatmapCanvasProps) {
  const {
    book, frames, trades, candles, interval, settings, plan, layers, gamma,
    liqEvents, userLevels, onToggleUserLevel, loading, error, tapeError, streamState,
    resolutionLabel,
  } = props;

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const heatRef = useRef<HeatCache>({ key: '', canvas: null });
  const [size, setSize] = useState<Dims>({ w: 0, h: 0 });
  const [viewEnd, setViewEnd] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [priceScale, setPriceScale] = useState<{ center: number; span: number } | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; price: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const spacePressed = useRef(false);
  const geomRef = useRef<Geometry | null>(null);
  const viewRef = useRef({ start: 0, end: 0, priceMin: 0, priceMax: 0 });

  useEffect(() => {
    setViewEnd(null);
    setZoom(1);
    setPriceScale(null);
    setHover(null);
    setMenu(null);
  }, [props.symbol]);

  useEffect(() => {
    const onReset = () => {
      setViewEnd(null);
      setZoom(1);
      setPriceScale(null);
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') spacePressed.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') spacePressed.current = false;
    };
    window.addEventListener('heatmap-reset', onReset);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('heatmap-reset', onReset);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const latestTime = frames.length ? frames[frames.length - 1].asOf : book?.asOf ?? Date.now();
  const end = viewEnd ?? latestTime;
  const baseSpan = SPAN_MS[settings.span];
  const spanMs = Math.max(1_000, baseSpan / zoom);
  const start = end - spanMs;

  const shown = useMemo(() => {
    const out: BookFrame[] = [];
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      if (frame.asOf < start) break;
      if (frame.asOf <= end) out.push(frame);
    }
    return out.reverse();
  }, [frames, start, end]);

  const visibleFrame = useMemo(() => frameAt(shown, end) ?? shown[shown.length - 1] ?? null, [shown, end]);
  const currentPrice = (viewEnd === null ? book?.mid ?? visibleFrame?.mid : visibleFrame?.mid ?? book?.mid)
    ?? trades[trades.length - 1]?.price ?? plan.entry ?? 0;
  const shownTrades = useMemo(
    () => trades.filter((trade) => trade.t >= start && trade.t <= end),
    [trades, start, end],
  );
  const range = useMemo(
    () => niceRange(visibleFrame, currentPrice, settings.range, shownTrades),
    [visibleFrame, currentPrice, settings.range, shownTrades],
  );
  const priceMin = priceScale ? priceScale.center - priceScale.span / 2 : range.min;
  const priceMax = priceScale ? priceScale.center + priceScale.span / 2 : range.max;
  const priceSpan = Math.max(1e-12, priceMax - priceMin);
  const ticks = useMemo(
    () => nicePriceTicks(priceMin, priceMax, clampNumber(Math.round(size.h / 62), 4, 11)),
    [priceMin, priceMax, size.h],
  );

  const geom: Geometry = useMemo(() => {
    const w = Math.max(1, size.w);
    const h = Math.max(1, size.h);
    const axisW = w < 720 ? AXIS_W_SMALL : AXIS_W;
    const maxCols = w < 560 ? 0 : w < 700 ? 2 : settings.columns.length;
    const columns = settings.columns.slice(0, maxCols);
    const colsW = columns.reduce((sum, key) => sum + columnWidth(key), 0);
    const plotRight = Math.max(80, w - axisW - colsW);
    const wallMargin = plotRight >= 560 ? WALL_MARGIN : 0;
    const dataRight = Math.max(40, plotRight - wallMargin);
    const top = HEADER_H;
    const timeTop = h - TIME_H;
    const cvdH = settings.cvdStrip && h > 400 ? 24 : 0;
    const volH = settings.showVolume && h > 340 ? 46 : 0;
    const volumeTop = timeTop - volH;
    const cvdTop = volumeTop - cvdH;
    const plotBottom = Math.max(60, cvdTop);
    const plotH = plotBottom - top;
    const rows = rowCountFor(plotH, settings.rowPx);
    const colRows = clampNumber(Math.floor(plotH / 19), 4, 90);
    return {
      w, h, top, plotRight, dataRight, dataW: dataRight, wallMargin,
      axisX: plotRight + colsW, axisW, plotW: plotRight,
      timeTop, volumeTop, cvdTop, plotBottom, plotH, rows, rowH: plotH / rows,
      colRows, colRowH: plotH / colRows, columns, colsW, bottom: timeTop,
    };
  }, [size, settings.columns, settings.cvdStrip, settings.showVolume, settings.rowPx]);
  geomRef.current = geom;
  viewRef.current = { start, end, priceMin, priceMax };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bubbleFloor = useMemo(() => {
    const fixed = BUBBLE_FLOOR_USD[settings.bubbleFloor];
    if (fixed !== undefined) return fixed;
    const pct = BUBBLE_FLOOR_PCT[settings.bubbleFloor];
    if (pct === undefined) return 0;
    return percentile(shownTrades.map((trade) => trade.usd), pct);
  }, [settings.bubbleFloor, shownTrades]);

  const bubbleScale = BUBBLE_SCALE[settings.bubbleSize];

  const allBubbles = useMemo(() => bubblePoints(
    trades, start, end, settings.bubbles, settings.stepMode, bubbleFloor,
    priceMin, priceMax, geom.rows,
  ), [trades, start, end, settings.bubbles, settings.stepMode, bubbleFloor, priceMin, priceMax, geom.rows]);

  const bubbles = useMemo(() => {
    if (allBubbles.length <= 160) return allBubbles;
    return [...allBubbles].sort((a, b) => b.usd - a.usd).slice(0, 160).sort((a, b) => a.t - b.t);
  }, [allBubbles]);

  const ringBubbles = useMemo(() => {
    const count = Math.max(1, Math.ceil(bubbles.length * 0.15));
    return new Set([...bubbles].sort((a, b) => b.usd - a.usd).slice(0, count));
  }, [bubbles]);

  const labelBubbles = useMemo(() => {
    const top = [...bubbles].sort((a, b) => b.usd - a.usd).slice(0, 12);
    return new Set([...top, ...bubbles.filter((bubble) => bubble.usd >= 250_000)]);
  }, [bubbles]);

  const pulls = useMemo(
    () => pullEvents(frames, trades, Math.max(150_000, settings.minLiquidityUsd), 40),
    [frames, trades, settings.minLiquidityUsd],
  );

  const additions = useMemo<LiquidityAdd[]>(() => {
    const live: BookFrame[] = [];
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      if (frame.source === 'history' || !frame.bids.length || !frame.asks.length) break;
      live.push(frame);
    }
    live.reverse();
    const out: LiquidityAdd[] = [];
    for (let i = 1; i < live.length; i++) {
      const prev = live[i - 1];
      const seen = new Set([
        ...prev.bids.map((level) => `bid:${level.price}`),
        ...prev.asks.map((level) => `ask:${level.price}`),
      ]);
      for (const side of ['bid', 'ask'] as const) {
        for (const level of side === 'bid' ? live[i].bids : live[i].asks) {
          if (seen.has(`${side}:${level.price}`) || level.usd < 150_000) continue;
          out.push({ t: live[i].asOf, price: level.price, usd: level.usd, side });
        }
      }
    }
    return out.slice(-40);
  }, [frames]);

  const walls = useMemo(() => nearestWalls(frames, WALL_NEAR_PCT, 24, MIN_WALL_USD), [frames]);
  const wallCandidates = useMemo(() => {
    const latest = frames[frames.length - 1];
    if (!latest || !(latest.mid > 0)) return [];
    const near = (price: number) => Math.abs(price - latest.mid) / latest.mid <= WALL_NEAR_PCT;
    const bids = latest.bids.filter((level) => near(level.price) && level.usd >= MIN_WALL_USD).map((level) => ({ ...level, side: 'bid' as const }));
    const asks = latest.asks.filter((level) => near(level.price) && level.usd >= MIN_WALL_USD).map((level) => ({ ...level, side: 'ask' as const }));
    return [...bids, ...asks].sort((a, b) => b.usd - a.usd).slice(0, 6);
  }, [frames]);

  const allLevels = useMemo(() => {
    const out: LevelLine[] = [];
    if (layers.plan) out.push(...planLines(plan, priceMin, priceMax));
    if (layers.gamma) out.push(...gammaLines(gamma, priceMin, priceMax));
    if (layers.liq) out.push(...liqLines(liqClusters(liqEvents, currentPrice), priceMin, priceMax));
    out.push(...userLines(userLevels, priceMin, priceMax));
    return out;
  }, [layers, plan, gamma, liqEvents, currentPrice, userLevels, priceMin, priceMax]);

  const thresholds = useMemo(
    () => sparseThresholds(shown, priceMin, priceMax, geom.rows, settings.minLiquidityUsd),
    [shown, priceMin, priceMax, geom.rows, settings.minLiquidityUsd],
  );

  const drawBase = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const ctx = prepare(canvas, size.w, size.h);
    if (!ctx) return;
    const g = geom;
    const midY = priceToY(currentPrice, priceMin, priceMax, g.top, g.plotH);

    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, g.w, g.h);

    const timeStep = chooseTimeStep(spanMs, g.dataW);
    const firstTick = Math.ceil(start / timeStep) * timeStep;

    const heatKey = [
      frames.length, frames[0]?.asOf ?? 0, frames[frames.length - 1]?.asOf ?? 0,
      start, end, priceMin, priceMax, g.rows, g.dataW, g.top, g.plotH,
      settings.contrast, settings.minLiquidityUsd, thresholds.low, thresholds.max,
    ].join(':');
    if (heatRef.current.key !== heatKey) {
      let heat = heatRef.current.canvas;
      if (!heat) {
        heat = document.createElement('canvas');
        heatRef.current.canvas = heat;
      }
      if (heat.width !== canvas.width) heat.width = canvas.width;
      if (heat.height !== canvas.height) heat.height = canvas.height;
      const hctx = heat.getContext('2d');
      if (hctx) {
        const dpr = canvas.width / Math.max(1, size.w);
        hctx.setTransform(1, 0, 0, 1, 0, 0);
        hctx.clearRect(0, 0, heat.width, heat.height);
        hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const frameWidth = Math.max(1, g.dataW / Math.max(1, shown.length));
        for (let i = 0; i < shown.length; i++) {
          const frame = shown[i];
          const x = timeToX(frame.asOf, start, end, 0, g.dataW);
          const next = shown[i + 1];
          const x2 = next ? timeToX(next.asOf, start, end, 0, g.dataW) : g.dataW;
          const cellW = Math.max(frameWidth, x2 - x + 0.35);
          if (x + cellW < 0 || x > g.dataW) continue;
          const { bid, ask } = frameRowTotals(frame, priceMin, priceMax, g.rows, settings.minLiquidityUsd);
          for (let row = 0; row < g.rows; row++) {
            const usd = (bid[row] ?? 0) + (ask[row] ?? 0);
            if (usd <= 0) continue;
            const gain = settings.contrast === 'high' ? 1.12 : settings.contrast === 'low' ? 0.86 : 1;
            const intensity = sparseIntensity(usd, thresholds, gain);
            if (intensity <= 0) continue;
            hctx.fillStyle = heatColor(intensity, 1);
            const y = g.top + row * g.rowH;
            hctx.fillRect(x, y, cellW, g.rowH + 0.35);
          }
        }
        heatRef.current.key = heatKey;
      }
    }
    if (heatRef.current.canvas) ctx.drawImage(heatRef.current.canvas, 0, 0, g.w, g.h);

    const recordStart = frames[0]?.asOf ?? null;
    if (recordStart !== null && recordStart > start && recordStart < end) {
      const x = timeToX(recordStart, start, end, 0, g.dataW);
      ctx.save();
      ctx.strokeStyle = 'rgba(244,184,96,0.78)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, g.top);
      ctx.lineTo(Math.round(x) + 0.5, g.plotBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = 'order book recorded from here \u25b8';
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      const tw = ctx.measureText(label).width;
      const lx = x + tw + 16 < g.dataW ? x + 7 : x - tw - 7;
      const overlapsLegend = lx < 290 && lx + tw > 7;
      const labelY = overlapsLegend ? g.plotBottom - 10 : g.top + 14;
      ctx.fillStyle = 'rgba(5,7,13,0.70)';
      ctx.fillRect(lx - 2, labelY - 7, tw + 4, 14);
      ctx.fillStyle = '#f4b860';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx, labelY);
      ctx.restore();
      ctx.textBaseline = 'alphabetic';
    }

    if (settings.showCandles && candles.length) {
      const step = INTERVAL_MS[interval];
      const bodyW = clampNumber((step / spanMs) * g.dataW * 0.65, 1, 12);
      for (const candle of candles) {
        if (candle.closed !== true) continue;
        if (candle.t + step < start || candle.t > end) continue;
        const x = timeToX(candle.t + step / 2, start, end, 0, g.dataW);
        const yHigh = priceToY(candle.h, priceMin, priceMax, g.top, g.plotH);
        const yLow = priceToY(candle.l, priceMin, priceMax, g.top, g.plotH);
        const yOpen = priceToY(candle.o, priceMin, priceMax, g.top, g.plotH);
        const yClose = priceToY(candle.c, priceMin, priceMax, g.top, g.plotH);
        const up = candle.c >= candle.o;
        const color = up ? 'rgba(74,222,128,0.72)' : 'rgba(248,113,113,0.72)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, yHigh);
        ctx.lineTo(x, yLow);
        ctx.stroke();
        const bodyTop = Math.min(yOpen, yClose);
        const bodyH = Math.max(1, Math.abs(yClose - yOpen));
        ctx.fillStyle = up ? 'rgba(74,222,128,0.26)' : 'rgba(248,113,113,0.26)';
        ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
        ctx.strokeStyle = color;
        ctx.strokeRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
      }
    }

    // Price path under the bubbles.
    if (bubbles.length > 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.32)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < bubbles.length; i++) {
        const bubble = bubbles[i];
        const x = timeToX(bubble.t, start, end, 0, g.dataW);
        const y = priceToY(bubble.price, priceMin, priceMax, g.top, g.plotH);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    if (settings.showVolume) {
      const buckets = volumeBuckets(shownTrades, start, end, Math.max(20, Math.floor(g.dataW / 6)));
      const maxVol = Math.max(1, ...buckets.map((bucket) => bucket.total));
      const bw = g.dataW / buckets.length;
      ctx.fillStyle = 'rgba(5,7,13,0.45)';
      ctx.fillRect(0, g.volumeTop, g.dataW, Math.max(0, g.timeTop - g.volumeTop));
      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        if (bucket.total <= 0) continue;
        const h = (bucket.total / maxVol) * (g.timeTop - g.volumeTop - 6);
        const x = i * bw;
        const buyH = (bucket.buy / bucket.total) * h;
        const sellH = h - buyH;
        ctx.fillStyle = 'rgba(34,197,94,0.78)';
        ctx.fillRect(x + 0.5, g.timeTop - 2 - buyH, Math.max(1, bw - 1), buyH);
        ctx.fillStyle = 'rgba(239,68,68,0.78)';
        ctx.fillRect(x + 0.5, g.timeTop - 2 - buyH - sellH, Math.max(1, bw - 1), sellH);
      }
    }

    if (settings.cvdStrip && g.cvdTop < g.volumeTop) {
      let cvd = 0;
      const points: Array<{ x: number; v: number }> = [];
      for (const trade of shownTrades) {
        cvd += trade.side === 'buy' ? trade.usd : -trade.usd;
        points.push({ x: timeToX(trade.t, start, end, 0, g.dataW), v: cvd });
      }
      const maxAbs = Math.max(1, ...points.map((point) => Math.abs(point.v)));
      const mid = (g.cvdTop + g.volumeTop) / 2;
      const half = Math.max(4, (g.volumeTop - g.cvdTop) / 2 - 3);
      ctx.fillStyle = 'rgba(5,7,13,0.58)';
      ctx.fillRect(0, g.cvdTop, g.dataW, g.volumeTop - g.cvdTop);
      ctx.strokeStyle = 'rgba(148,163,184,0.18)';
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(g.dataW, mid + 0.5);
      ctx.stroke();
      if (points.length > 1) {
        ctx.strokeStyle = cvd >= 0 ? '#4ade80' : '#f87171';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        for (const point of points) ctx.lineTo(point.x, mid - (point.v / maxAbs) * half);
        ctx.stroke();
      }
    }

    // Right price axis and tidy ticks.
    ctx.fillStyle = '#05070d';
    ctx.fillRect(g.axisX, 0, g.axisW, g.timeTop);
    ctx.strokeStyle = 'rgba(148,163,184,0.14)';
    ctx.beginPath();
    ctx.moveTo(g.axisX + 0.5, 0);
    ctx.lineTo(g.axisX + 0.5, g.timeTop);
    ctx.stroke();
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const tick of ticks.values) {
      const y = priceToY(tick, priceMin, priceMax, g.top, g.plotH);
      if (y < g.top + 4 || y > g.plotBottom - 3) continue;
      ctx.fillStyle = '#7c8797';
      ctx.fillText(priceText(tick, priceMin), g.axisX + g.axisW - 5, y);
      ctx.strokeStyle = 'rgba(148,163,184,0.24)';
      ctx.beginPath();
      ctx.moveTo(g.axisX + 2, Math.round(y) + 0.5);
      ctx.lineTo(g.axisX + 6, Math.round(y) + 0.5);
      ctx.stroke();
    }
    ctx.textBaseline = 'alphabetic';

    const tagYs: number[] = [];
    const drawTag = (
      y: number,
      text: string,
      color: string,
      outline: boolean,
    ) => {
      if (y < g.top + 4 || y > g.timeTop - 8) return;
      if (tagYs.some((used) => Math.abs(used - y) < 13)) return;
      tagYs.push(y);
      ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      const width = Math.max(g.axisW - 6, ctx.measureText(text).width + 8);
      if (outline) {
        ctx.fillStyle = 'rgba(5,7,13,0.92)';
        ctx.fillRect(g.axisX + 3, y - 8, width, 16);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(g.axisX + 3, y - 8, width, 16);
      } else {
        ctx.fillStyle = color;
        roundedRect(ctx, g.axisX + 3, y - 8, width, 16, 3);
        ctx.fill();
      }
      ctx.fillStyle = outline ? color : '#05070d';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, g.axisX + 3 + width / 2, y);
      ctx.textBaseline = 'alphabetic';
    };

    if (currentPrice > 0) {
      drawTag(midY, priceText(currentPrice, priceMin), '#e5e7eb', false);
      ctx.strokeStyle = 'rgba(229,231,235,0.5)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, midY + 0.5);
      ctx.lineTo(g.dataRight, midY + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const labelYs: number[] = [];
    for (const line of allLevels) {
      const y = priceToY(line.price, priceMin, priceMax, g.top, g.plotH);
      if (y < g.top || y > g.plotBottom) continue;
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.width;
      ctx.setLineDash(line.dash);
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(g.dataRight, y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);

      const collides = labelYs.some((used) => Math.abs(used - y) < 12);
      if (!collides) {
        labelYs.push(y);
        const prefix = line.kind === 'user' ? (line.price >= currentPrice ? '\u25b2 ' : '\u25bc ') : '';
        const label = `${prefix}${line.label}`;
        ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(5,7,13,0.80)';
        roundedRect(ctx, 3, y - 8, tw + 6, 14, 2);
        ctx.fill();
        ctx.fillStyle = line.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 6, y);
        ctx.textBaseline = 'alphabetic';
      }

      const tagColor = line.kind === 'user' ? '#e5e7eb' : line.color;
      drawTag(y, priceText(line.price, priceMin), tagColor, true);
    }

    // Top wall labels in the right margin, red asks and green bids.
    ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    const wallYs: number[] = [];
    for (const wall of wallCandidates) {
      const y = priceToY(wall.price, priceMin, priceMax, g.top, g.plotH);
      if (y < g.top + 6 || y > g.plotBottom - 6) continue;
      if (wallYs.some((used) => Math.abs(used - y) < 12)) continue;
      wallYs.push(y);
      drawWallBadge(ctx, wall, g.plotRight - 5, y);
    }

    // Bubbles: saturated pies, notional diameter, path already underneath.
    const labelBoxes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const bubble of bubbles) {
      const x = timeToX(bubble.t, start, end, 0, g.dataW);
      const y = priceToY(bubble.price, priceMin, priceMax, g.top, g.plotH);
      const radius = bubbleRadius(bubble.usd, 0, bubbleScale);
      if (x < -radius || x > g.dataRight + radius || y < g.top - radius || y > g.plotBottom + radius) continue;
      const split = bubble.buyUsd > 0 && bubble.sellUsd > 0
        ? (Math.PI * 2) * (bubble.buyUsd / Math.max(1e-9, bubble.usd))
        : bubble.side === 'buy' ? Math.PI * 2 : 0;
      ctx.globalAlpha = 0.96;
      if (split > 0) {
        ctx.fillStyle = '#22c55e';
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + split);
        ctx.closePath();
        ctx.fill();
      }
      if (split < Math.PI * 2) {
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, radius, -Math.PI / 2 + split, Math.PI * 1.5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(5,7,13,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.2, radius), 0, Math.PI * 2);
      ctx.stroke();
      if (ringBubbles.has(bubble)) {
        ctx.strokeStyle = '#fde047';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2, radius + 1.2), 0, Math.PI * 2);
        ctx.stroke();
      }

      const deltaRatio = Math.abs(bubble.buyUsd - bubble.sellUsd) / Math.max(1e-9, bubble.usd);
      if (bubble.usd >= 250_000 && deltaRatio >= 0.6) {
        drawChevron(
          ctx,
          x,
          y + (bubble.buyUsd >= bubble.sellUsd ? -radius - 11 : radius + 11),
          bubble.buyUsd >= bubble.sellUsd,
          bubble.buyUsd >= bubble.sellUsd ? '#86efac' : '#fda4af',
        );
      }

      if (labelBubbles.has(bubble)) {
        const label = fmtUsd(bubble.usd);
        ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        const tw = ctx.measureText(label).width;
        const lx = clampNumber(x - tw / 2, 2, g.dataRight - tw - 2);
        let ly = y - radius - 18;
        if (ly < g.top + 12) ly = y + radius + 8;
        const box = { x1: lx - 3, y1: ly - 11, x2: lx + tw + 3, y2: ly + 2 };
        if (!labelBoxes.some((used) => box.x1 < used.x2 && box.x2 > used.x1 && box.y1 < used.y2 && box.y2 > used.y1)) {
          labelBoxes.push(box);
          ctx.fillStyle = 'rgba(5,7,13,0.76)';
          roundedRect(ctx, box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1, 2);
          ctx.fill();
          ctx.fillStyle = '#fef3c7';
          ctx.textAlign = 'left';
          ctx.fillText(label, lx, ly);
        }
      }
    }

    // Liquidity events: green additions and filled pulled-level marks.
    ctx.font = '700 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (const add of additions) {
      if (add.t < start || add.t > end) continue;
      const x = timeToX(add.t, start, end, 0, g.dataW);
      const y = priceToY(add.price, priceMin, priceMax, g.top, g.plotH);
      if (x < 3 || x > g.dataRight - 3 || y < g.top || y > g.plotBottom) continue;
      ctx.strokeStyle = 'rgba(34,197,94,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 4, y);
      ctx.lineTo(x + 4, y);
      ctx.moveTo(x, y - 4);
      ctx.lineTo(x, y + 4);
      ctx.stroke();
    }
    for (const pull of pulls) {
      if (pull.t < start || pull.t > end) continue;
      const x = timeToX(pull.t, start, end, 0, g.dataW);
      const y = priceToY(pull.price, priceMin, priceMax, g.top, g.plotH);
      if (x < 4 || x > g.dataRight - 4 || y < g.top || y > g.plotBottom) continue;
      ctx.fillStyle = pull.side === 'bid' ? 'rgba(34,197,94,0.92)' : 'rgba(239,68,68,0.92)';
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x - 2, y - 2);
      ctx.lineTo(x + 2, y + 2);
      ctx.moveTo(x + 2, y - 2);
      ctx.lineTo(x - 2, y + 2);
      ctx.stroke();
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Legend: a real ramp plus the measured thresholds behind it.
    const legendY = g.top + 7;
    ctx.fillStyle = 'rgba(5,7,13,0.72)';
    roundedRect(ctx, 7, legendY, 300, 54, 4);
    ctx.fill();
    const ramp = ctx.createLinearGradient(13, 0, 153, 0);
    for (let i = 0; i <= 10; i++) ramp.addColorStop(i / 10, heatColor(i / 10, 1));
    ctx.fillStyle = ramp;
    roundedRect(ctx, 13, legendY + 10, 140, 8, 2);
    ctx.fill();
    ctx.fillStyle = '#dfe7ef';
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      thresholds.cells > 0 ? `${fmtUsd(thresholds.low)} \u2026 ${fmtUsd(thresholds.max)}+ resting` : 'no recorded resting size',
      160,
      legendY + 14,
    );
    const cadence = resolutionLabel.startsWith('MOCK')
      ? '2-second'
      : resolutionLabel.includes('3 s') ? '3-second' : '1-second';
    const bubbleStep = Math.round(stepMsFor(spanMs, settings.stepMode) / 1_000);
    ctx.fillStyle = '#7c8797';
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(`${cadence} book columns \u00b7 bubbles every ${bubbleStep}s`, 13, legendY + 38);

    // Bottom time axis, full width, local 24-hour labels.
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, g.timeTop, g.w, TIME_H);
    ctx.fillStyle = 'rgba(148,163,184,0.14)';
    ctx.fillRect(0, g.timeTop, g.w, 1);
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let t = firstTick; t <= end; t += timeStep) {
      const x = timeToX(t, start, end, 0, g.dataW);
      if (x < 18 || x > g.dataW - 18) continue;
      ctx.fillStyle = '#6b7280';
      ctx.fillText(tickLabel(t), x, g.timeTop + TIME_H / 2);
      ctx.strokeStyle = 'rgba(148,163,184,0.18)';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, g.timeTop);
      ctx.lineTo(Math.round(x) + 0.5, g.timeTop + 3);
      ctx.stroke();
    }
    ctx.textBaseline = 'alphabetic';

    drawColumns({
      ctx,
      x: g.plotRight,
      width: g.colsW,
      headerH: HEADER_H,
      bodyTop: g.top,
      bodyH: g.plotBottom - g.top,
      bottom: g.timeTop,
      columns: g.columns,
      colRows: g.colRows,
      priceMin,
      priceMax,
      frames: shown,
      trades,
      latest: shown[shown.length - 1] ?? null,
      mid: currentPrice,
      start,
      end,
      spanLabel: settings.span,
      sizeUnit: settings.sizeUnit,
      volumeOver: settings.volumeOver,
      tapeMin: settings.tapeMin,
      hoverPrice: null,
    });

    if (hover) {
      const { x, y } = hover;
      ctx.strokeStyle = 'rgba(229,231,235,0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, g.top);
      ctx.lineTo(Math.round(x) + 0.5, g.timeTop);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(g.axisX, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      if (hover.columnKey && g.colsW > 0) {
        const row = clampNumber(Math.floor((y - g.top) / Math.max(1, g.colRowH)), 0, g.colRows - 1);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(g.plotRight, g.top + row * g.colRowH, g.colsW, g.colRowH);
      }
      if (hover.price > 0) {
        const label = priceText(hover.price, priceMin);
        ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        const width = Math.max(g.axisW - 6, ctx.measureText(label).width + 8);
        ctx.fillStyle = '#e5e7eb';
        roundedRect(ctx, g.axisX + 3, y - 8, width, 16, 3);
        ctx.fill();
        ctx.fillStyle = '#05070d';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, g.axisX + 3 + width / 2, y);
      }
      const timeLabel = localClock(hover.time);
      ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      const tw = ctx.measureText(timeLabel).width + 10;
      const tx = clampNumber(x - tw / 2, 2, g.dataRight - tw - 2);
      ctx.fillStyle = '#e5e7eb';
      roundedRect(ctx, tx, g.timeTop + 3, tw, 15, 2);
      ctx.fill();
      ctx.fillStyle = '#05070d';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(timeLabel, tx + tw / 2, g.timeTop + 10.5);
      ctx.textBaseline = 'alphabetic';
    }

    ctx.fillStyle = '#070a11';
    ctx.fillRect(0, 0, g.plotRight, HEADER_H);
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.beginPath();
    ctx.moveTo(0, HEADER_H + 0.5);
    ctx.lineTo(g.w, HEADER_H + 0.5);
    ctx.stroke();

    if (streamState === 'STALE' || streamState === 'DISCONNECTED' || streamState === 'OFFLINE') {
      ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = streamState === 'STALE' ? '#fcd34d' : '#f87171';
      ctx.fillText(
        streamState === 'STALE' ? 'STALE \u2014 no live depth event for 3 s' : 'OFFLINE \u2014 reconnecting',
        g.plotRight - 10,
        18,
      );
    } else if (tapeError) {
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#fcd34d';
      ctx.fillText('tape unavailable \u2014 bubbles are not a complete tape', g.plotRight - 10, 18);
    }

    if (!frames.length && !book) {
      ctx.font = '700 14px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#dfe7ef';
      ctx.fillText(
        loading ? 'Connecting to the Binance depth stream\u2026' : error ? 'Live book unavailable' : 'No captured book for this span',
        g.dataRight / 2,
        g.top + g.plotH * 0.42,
      );
      ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#8b93a1';
      ctx.fillText(
        error
          ? `${error}. No synthetic data is drawn.`
          : 'The chart begins when the first depth snapshot arrives.',
        g.dataRight / 2,
        g.top + g.plotH * 0.42 + 22,
      );
      ctx.textBaseline = 'alphabetic';
    }

    if (hover) drawTooltip(ctx, hover, priceMin, priceSpan, walls, g);
  }, [
    size, geom, priceMin, priceMax, priceSpan, settings, shown, start, end, spanMs, currentPrice,
    candles, interval, shownTrades, allLevels, wallCandidates, bubbles, ringBubbles,
    labelBubbles, additions, pulls, streamState, tapeError, resolutionLabel, frames, thresholds,
    ticks, hover, walls, book, loading, error, bubbleScale,
  ]);

  useEffect(() => {
    drawBase();
  }, [drawBase]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const g = geomRef.current;
      if (!g) return;
      const rect = el.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x > g.dataRight || y < g.top || y > g.plotBottom) return;
      event.preventDefault();
      const view = viewRef.current;
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        const center = (view.priceMin + view.priceMax) / 2;
        const span = view.priceMax - view.priceMin;
        const factor = event.deltaY > 0 ? 1.15 : 0.87;
        const nextSpan = clampNumber(span * factor, Math.max(1e-9, center * 1e-6), center * 0.5);
        const ratio = (y - g.top) / g.plotH;
        const anchor = view.priceMax - ratio * span;
        const nextMax = anchor + ratio * nextSpan;
        setPriceScale({ center: nextMax - nextSpan / 2, span: nextSpan });
      } else {
        const factor = event.deltaY > 0 ? 0.86 : 1.16;
        const nextZoom = clampNumber(zoom * factor, 1, 18);
        const tAt = xToTime(x, view.start, view.end, 0, g.dataW);
        const nextSpan = Math.max(1_000, baseSpan / nextZoom);
        const ratio = x / Math.max(1, g.dataW);
        const nextEnd = tAt + (1 - ratio) * nextSpan;
        setZoom(nextZoom);
        setViewEnd(nextEnd);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom, baseSpan]);

  const pointerPos = (event: React.PointerEvent | React.MouseEvent): { x: number; y: number } | null => {
    const el = canvasRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const updateHover = (pos: { x: number; y: number } | null) => {
    if (!pos) { setHover(null); return; }
    const { x, y } = pos;
    const g = geom;
    if (x <= g.dataRight && y >= g.top && y <= g.plotBottom) {
      const rawPrice = yToPrice(y, priceMin, priceMax, g.top, g.plotH);
      const price = nearestTick(rawPrice, ticks.values);
      const time = xToTime(x, start, end, 0, g.dataW);
      const row = rowIndexForPrice(price, priceMin, priceMax, g.rows);
      let bubble: BubblePoint | null = null;
      let best = 12;
      for (const candidate of bubbles) {
        const bx = timeToX(candidate.t, start, end, 0, g.dataW);
        const by = priceToY(candidate.price, priceMin, priceMax, g.top, g.plotH);
        const radius = bubbleRadius(candidate.usd, 0, bubbleScale);
        const distance = Math.hypot(bx - x, by - y);
        if (distance <= Math.max(6, radius) && distance < best) { best = distance; bubble = candidate; }
      }
      let pull: PullEvent | null = null;
      let bestPull = 7;
      for (const candidate of pulls) {
        if (candidate.t < start || candidate.t > end) continue;
        const px = timeToX(candidate.t, start, end, 0, g.dataW);
        const py = priceToY(candidate.price, priceMin, priceMax, g.top, g.plotH);
        const distance = Math.hypot(px - x, py - y);
        if (distance < bestPull) { bestPull = distance; pull = candidate; }
      }
      setHover({
        x, y, price, time,
        cell: cellAt(shown, time, row, priceMin, priceMax, g.rows),
        bubble,
        pull,
        columnKey: null,
        columnLow: null,
        columnHigh: null,
      });
      return;
    }
    if (g.colsW > 0 && x >= g.plotRight && x < g.axisX && y >= g.top && y <= g.timeTop) {
      let cx = g.plotRight;
      let key: string | null = null;
      for (const column of g.columns) {
        const width = columnWidth(column);
        if (column === 'book') {
          if (x >= cx && x < cx + width / 2) { key = 'bid $'; break; }
          if (x >= cx + width / 2 && x < cx + width) { key = 'ask $'; break; }
        } else if (x >= cx && x < cx + width) {
          key = column;
          break;
        }
        cx += width;
      }
      const row = clampNumber(Math.floor((y - g.top) / Math.max(1, g.colRowH)), 0, g.colRows - 1);
      const topPrice = priceMax - (row / g.colRows) * priceSpan;
      const bottomPrice = priceMax - ((row + 1) / g.colRows) * priceSpan;
      setHover({
        x, y,
        price: (topPrice + bottomPrice) / 2,
        time: xToTime(x, start, end, 0, g.dataW),
        cell: null,
        bubble: null,
        pull: null,
        columnKey: key,
        columnLow: bottomPrice,
        columnHigh: topPrice,
      });
      return;
    }
    setHover(null);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const pos = pointerPos(event);
    if (!pos || pos.y < geom.top || pos.y > geom.timeTop) return;
    const onAxis = pos.x >= geom.axisX && pos.x < geom.axisX + geom.axisW;
    const onPlot = pos.x <= geom.dataRight;
    if (!onAxis && !onPlot) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      x: pos.x,
      y: pos.y,
      end,
      center: (priceMin + priceMax) / 2,
      span: priceSpan,
      moved: false,
      mode: spacePressed.current || !onAxis ? 'time' : 'price',
    };
    setMenu(null);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pos = pointerPos(event);
    if (!pos) return;
    const drag = dragRef.current;
    if (drag) {
      const dx = pos.x - drag.x;
      const dy = pos.y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      if (drag.moved && drag.mode === 'time') {
        setViewEnd(drag.end - (dx / Math.max(1, geom.dataW)) * spanMs);
      } else if (drag.moved) {
        setPriceScale({
          center: drag.center + (dy / Math.max(1, geom.plotH)) * drag.span,
          span: drag.span,
        });
      }
    }
    updateHover(pos);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  const onPointerLeave = () => {
    if (!dragRef.current) setHover(null);
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = pointerPos(event);
    if (!pos) return;
    if (pos.y < geom.top || pos.y > geom.plotBottom || pos.x > geom.dataRight) return;
    setViewEnd(null);
    setZoom(1);
    setPriceScale(null);
    setMenu(null);
  };

  const onContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = pointerPos(event);
    if (!pos || pos.y < geom.top || pos.y > geom.plotBottom || pos.x > geom.dataRight) return;
    event.preventDefault();
    const price = yToPrice(pos.y, priceMin, priceMax, geom.top, geom.plotH);
    setMenu({ x: pos.x, y: pos.y, price: snapPrice(price, 10 ** -priceDecimals(priceMin)) });
  };

  return (
    <div ref={wrapRef} className="heatmap-canvas">
      <canvas
        ref={canvasRef}
        className="block h-full w-full cursor-crosshair select-none outline-none"
        tabIndex={0}
        aria-label="Market liquidity heatmap and trade flow"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />

      {(viewEnd !== null || priceScale !== null) && (
        <div className="heatmap-lock">
          <span className="heatmap-lock__badge">LOCKED VIEW</span>
          <button type="button" onClick={() => { setViewEnd(null); setZoom(1); setPriceScale(null); setMenu(null); }}>
            Back to live
          </button>
        </div>
      )}

      {menu && (
        <div
          className="heatmap-menu"
          style={{ left: clampNumber(menu.x, 4, Math.max(4, size.w - 190)), top: clampNumber(menu.y, 4, Math.max(4, size.h - 150)) }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="heatmap-menu__price">{priceText(menu.price, priceMin)}</div>
          <button type="button" onClick={() => { onToggleUserLevel(menu.price); setMenu(null); }}>Add / remove level</button>
          <button type="button" onClick={() => { setPriceScale(null); setViewEnd(null); setZoom(1); setMenu(null); }}>Reset view</button>
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(menu.price.toFixed(priceDecimals(priceMin))); setMenu(null); }}>Copy price</button>
        </div>
      )}

    </div>
  );
}
