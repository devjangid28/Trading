import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import type { TerminalInterval } from '../../../shared/types';
import { INTERVAL_MS } from '../math';
import {
  fpCompactQty, fpCompactUsd, fpPrice, fpRatio,
  fpRowSizeText, fpSignedPercent, fpSignedUsd, fpTimeLocal, scaleSize,
} from './format';
import { FOOTPRINT } from './settings';
import { resolveAutoRowSize } from './aggregate';
import type {
  FootprintCandle, FootprintDataset, FootprintRow, FootprintSettings,
} from './types';

const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const UI = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

const COLORS = {
  bg: '#05070d',
  info: '#8b93a1',
  muted: '#6b7280',
  faint: '#4f5b6b',
  line: '#1f2937',
  grid: 'rgba(31,41,55,0.55)',
  up: '#4ade80',
  down: '#f87171',
  amber: '#fcd34d',
  poc: '#facc15',
  ua: '#a78bfa',
  uaLine: '#c9b458',
  teal: '#2dd4bf',
  violet: '#c084fc',
  cellBg: '#171b24',
  cellText: '#9ca3af',
  bidBar: '#d6403f',
  askBar: '#22a559',
  volumeBar: '#475569',
  white: '#ffffff',
  axisText: '#6b7280',
  axisBg: '#05070d',
  gutter: 'rgba(5,7,13,0.85)',
  summaryNeutral: '#1f2937',
  summaryText: '#c3c9d3',
  rektLong: '#f87171',
  rektShort: '#34d399',
  record: 'rgba(248,113,113,0.6)',
};

interface Size {
  w: number;
  h: number;
  dpr: number;
}

interface ColumnLayout {
  candle: FootprintCandle;
  index: number;
  x: number;
  xRight: number;
  width: number;
  laneW: number;
  cellW: number;
  innerGap: number;
  seam: number;
  rowsTop: number;
}

interface CanvasLayout {
  w: number;
  h: number;
  infoH: number;
  headerH: number;
  summaryH: number;
  summaryRowH: number;
  plotTop: number;
  plotBottom: number;
  plotRight: number;
  axisX: number;
  axisW: number;
  gutterW: number;
  labelMargin: number;
  colPitch: number;
  colGap: number;
  laneW: number;
  rowH: number;
  rowSize: number;
  pxPerPrice: number;
  topPrice: number;
  lowPrice: number;
  highPrice: number;
  displayHigh: number;
  displayLow: number;
  columns: ColumnLayout[];
  allColumns: ColumnLayout[];
  summaryColumns: ColumnLayout[];
  maxCell: number;
  maxVolume: number;
  maxDelta: number;
  maxCum: number;
  autoRowSize: number;
  levelLabelBoxes: Array<{ x: number; y: number; w: number; h: number; id: string; action: 'remove' | 'offscreen' }>;
  rektBoxes: Array<{ x: number; y: number; w: number; h: number; id: string }>;
  notableBoxes: Array<{ x: number; y: number; w: number; h: number; candleT: number; id: string }>;
  annotationLabelBoxes: Array<{ x: number; y: number; w: number; h: number; id: string }>;
}

interface ViewState {
  zoom: number;
  zoomY: number;
  shiftX: number;
  priceShiftRows: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  shiftX: number;
  priceShiftRows: number;
  moved: boolean;
  onAxis: boolean;
}

interface HoverPoint {
  x: number;
  y: number;
  inside: boolean;
}

interface TooltipLine {
  text: string;
  color?: string;
}

interface TooltipState {
  x: number;
  y: number;
  lines: TooltipLine[];
}

export interface FootprintCanvasProps {
  symbol: string;
  dataset: FootprintDataset;
  settings: FootprintSettings;
  interval: TerminalInterval;
  rowSize: number;
  selectedT: number | null;
  mock: boolean;
  loading: boolean;
  error: string | null;
  onSelect: (t: number | null) => void;
  onAddLevel: (price: number) => void;
  onRemoveLevel: (id: string) => void;
  onAutoRowSize: (size: number) => void;
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

function setFont(ctx: CanvasRenderingContext2D, size: number, weight: string | number = 500, mono = true): void {
  ctx.font = `${weight} ${size}px ${mono ? MONO : UI}`;
}

function pathRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawPill(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  fill: string, stroke: string | null, text: string,
  textColor: string, font = 11, bold = false,
): void {
  pathRoundRect(ctx, x, y, w, h, 3);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.fillStyle = textColor;
  setFont(ctx, font, bold ? 700 : 600);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
}

function hexAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return hex;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`;
}

function rowY(layout: CanvasLayout, price: number): number {
  return layout.plotTop + (layout.topPrice - price) * layout.pxPerPrice;
}

function priceFromY(layout: CanvasLayout, y: number, snap = true): number {
  const raw = layout.topPrice - (y - layout.plotTop) / Math.max(1e-9, layout.pxPerPrice);
  if (!snap) return raw;
  return Math.round(raw / layout.rowSize) * layout.rowSize;
}

function formatCell(value: number, units: 'usd' | 'btc'): string {
  if (!(value > 0)) return '0';
  return units === 'btc' ? fpCompactQty(value) : fpCompactUsd(value);
}

function chooseAxisStep(pxPerPrice: number): number {
  const raw = pxPerPrice * FOOTPRINT.AXIS_TARGET_PX;
  const ladder = [1, 2, 5, 10, 25, 50, 100, 200, 500, 1_000];
  for (const step of ladder) if (step >= raw) return step;
  return ladder[ladder.length - 1];
}

function timeToX(layout: CanvasLayout, t: number, intervalMs: number): number | null {
  const columns = layout.allColumns;
  if (!columns.length) return null;
  let found: ColumnLayout | null = null;
  for (const column of columns) {
    if (t >= column.candle.t && t < column.candle.t + intervalMs) {
      found = column;
      break;
    }
  }
  if (!found) {
    const first = columns[0];
    const last = columns[columns.length - 1];
    if (t < first.candle.t) return first.x;
    if (t >= last.candle.t + intervalMs) return last.xRight;
    // Sparse candles: interpolate between the surrounding columns.
    for (let i = 0; i < columns.length - 1; i++) {
      const a = columns[i];
      const b = columns[i + 1];
      if (t >= a.candle.t && t < b.candle.t) {
        const f = (t - a.candle.t) / Math.max(1, b.candle.t - a.candle.t);
        return a.x + (b.x - a.x) * f;
      }
    }
    return null;
  }
  const fraction = clamp((t - found.candle.t) / intervalMs, 0, 1);
  return found.x + found.laneW + fraction * (found.width - found.laneW);
}

function displayLevelLabel(text: string, above: boolean, below: boolean): string {
  if (above) return `\u25b2 ${text}`;
  if (below) return `\u25bc ${text}`;
  return text;
}

export function FootprintCanvas(props: FootprintCanvasProps) {
  const {
    dataset, settings, interval, rowSize, selectedT, mock, loading, error,
    onSelect, onAddLevel, onRemoveLevel, onAutoRowSize,
  } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<CanvasLayout | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef(0);
  const drawRef = useRef<() => void>(() => {});
  const lastPointerRef = useRef<HoverPoint>({ x: 0, y: 0, inside: false });
  const lastAutoRef = useRef(0);
  const [size, setSize] = useState<Size>({ w: 0, h: 0, dpr: 1 });
  const [view, setView] = useState<ViewState>({ zoom: 1, zoomY: 1, shiftX: 0, priceShiftRows: 0 });
  const [hoverPoint, setHoverPoint] = useState<HoverPoint>({ x: 0, y: 0, inside: false });
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [offscreenExpanded, setOffscreenExpanded] = useState(false);

  const intervalMs = INTERVAL_MS[interval];
  const offLive = Math.abs(view.shiftX) > 2 || Math.abs(view.priceShiftRows) > 0.01 || Math.abs(view.zoom - 1) > 0.001;

  const schedule = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      drawRef.current();
    });
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      setSize({
        w: Math.max(1, Math.round(rect.width)),
        h: Math.max(1, Math.round(rect.height)),
        dpr,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w <= 0 || size.h <= 0) return;
    canvas.width = Math.round(size.w * size.dpr);
    canvas.height = Math.round(size.h * size.dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    schedule();
  }, [size, schedule]);

  useEffect(() => {
    setOffscreenExpanded(false);
  }, [props.symbol]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w <= 0 || size.h <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.textBaseline = 'alphabetic';
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, size.w, size.h);

    const w = size.w;
    const h = size.h;
    const infoH = FOOTPRINT.INFO_H;
    const headerH = settings.showBuySellPct ? FOOTPRINT.HEADER_H : 0;
    const summaryH = settings.showSummary ? FOOTPRINT.SUMMARY_H : 0;
    const compact = w < 720;
    const axisW = compact ? 58 : w < 820 ? 76 : FOOTPRINT.AXIS_W;
    const gutterW = compact ? 58 : w < 900 ? 92 : FOOTPRINT.GUTTER_W;
    const labelMargin = compact ? 12 : w < 900 ? 92 : FOOTPRINT.LABEL_MARGIN;
    const plotTop = infoH + headerH;
    const plotBottom = Math.max(plotTop + 40, h - summaryH);
    const plotRight = w - axisW;
    const plotH = Math.max(40, plotBottom - plotTop);
    const candles = dataset.candles;
    const n = candles.length;

    setFont(ctx, 11, 500);
    ctx.fillStyle = COLORS.info;
    ctx.textAlign = 'left';
    const merge = Math.max(1, Math.round(rowSize / FOOTPRINT.BASE_TICK));
    ctx.fillText(
      `rows ${fpRowSizeText(rowSize)} USDT (${merge}\u00d7 merged) \u00b7 ${interval === '1d' ? '1D' : interval} candles \u00b7 ${settings.units === 'usd' ? '$' : 'BTC'} volume`,
      12,
      14,
    );

    if (!n) {
      ctx.fillStyle = error ? COLORS.down : COLORS.muted;
      setFont(ctx, 12, 500);
      ctx.textAlign = 'center';
      ctx.fillText(error ?? (loading ? 'Loading trade history\u2026' : 'No captured trades yet.'), w / 2, plotTop + Math.min(120, plotH / 2));
      ctx.textAlign = 'left';
      return;
    }

    const basePitch = compact
      ? clamp((plotRight - gutterW - labelMargin) / 3, 72, FOOTPRINT.COL_PITCH)
      : FOOTPRINT.COL_PITCH;
    const colPitch = clamp(basePitch * view.zoom, compact ? 72 : FOOTPRINT.COL_MIN, FOOTPRINT.COL_MAX);
    const colGap = FOOTPRINT.COL_GAP;
    const colW = Math.max(34, colPitch - colGap);
    const laneW = Math.min(FOOTPRINT.LANE_W, Math.max(10, colW * 0.12));
    const innerGap = 2;
    const cellW = Math.max(10, (colW - laneW - innerGap) / 2);
    const rightEdge = plotRight - labelMargin + view.shiftX;
    const allColumns: ColumnLayout[] = [];
    for (let i = 0; i < n; i++) {
      const xRight = rightEdge - (n - 1 - i) * colPitch;
      const x = xRight - colW;
      allColumns.push({
        candle: candles[i],
        index: i,
        x,
        xRight,
        width: colW,
        laneW,
        cellW,
        innerGap,
        seam: x + laneW + cellW + innerGap / 2,
        rowsTop: plotTop,
      });
    }
    const columns = allColumns.filter((column) => column.xRight > -1 && column.x < plotRight);
    const rangeColumns = columns.length ? columns : allColumns.slice(-24);
    let high = -Infinity;
    let low = Infinity;
    for (const column of rangeColumns) {
      high = Math.max(high, column.candle.h);
      low = Math.min(low, column.candle.l);
    }
    if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) {
      high = dataset.lastPrice * 1.001;
      low = dataset.lastPrice * 0.999;
    }
    const autoRowSize = resolveAutoRowSize(rangeColumns.map((column) => column.candle), plotH);
    if (Math.abs(autoRowSize - lastAutoRef.current) > 1e-9) {
      lastAutoRef.current = autoRowSize;
      onAutoRowSize(autoRowSize);
    }
    let rowH: number;
    if (settings.rows === 'auto') {
      rowH = plotH / (Math.max(1, Math.ceil((high - low) / rowSize)) + 8);
      rowH = clamp(rowH, 5, 46);
    } else {
      rowH = clamp(FOOTPRINT.ROW_H_NOMINAL * (rowSize / Math.max(0.001, autoRowSize)), 0.32, 60);
    }
    rowH *= view.zoomY;
    const pxPerPrice = rowH / rowSize;
    const displayHigh = high + rowSize * 4 + view.priceShiftRows * rowSize;
    const center = (high + low) / 2 + view.priceShiftRows * rowSize;
    const topPrice = settings.rows === 'auto'
      ? displayHigh
      : center + (plotH / 2) / Math.max(1e-9, pxPerPrice);
    const displayLow = topPrice - plotH / pxPerPrice;

    let maxCell = 0;
    let maxVolume = 0;
    let maxDelta = 0;
    let maxCum = 0;
    for (const column of columns) {
      const candle = column.candle;
      maxVolume = Math.max(maxVolume, candle.volumeUsd);
      maxDelta = Math.max(maxDelta, Math.abs(candle.deltaUsd));
      maxCum = Math.max(maxCum, Math.abs(candle.cumDeltaUsd));
      for (const row of candle.rows) {
        maxCell = Math.max(maxCell, row.bidUsd, row.askUsd);
      }
    }

    const layout: CanvasLayout = {
      w, h, infoH, headerH, summaryH,
      summaryRowH: FOOTPRINT.SUMMARY_ROW_H,
      plotTop, plotBottom, plotRight, axisX: plotRight, axisW,
      gutterW, labelMargin, colPitch, colGap, laneW, rowH, rowSize,
      pxPerPrice, topPrice, lowPrice: low, highPrice: high,
      displayHigh: topPrice, displayLow,
      columns, allColumns, summaryColumns: columns,
      maxCell, maxVolume, maxDelta, maxCum, autoRowSize,
      levelLabelBoxes: [], rektBoxes: [], notableBoxes: [], annotationLabelBoxes: [],
    };
    layoutRef.current = layout;

    const yForPrice = (price: number) => rowY(layout, price);

    // Price grid (very faint) behind the cells.
    const axisStep = chooseAxisStep(pxPerPrice);
    ctx.strokeStyle = 'rgba(31,41,55,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const firstGrid = Math.ceil(displayLow / axisStep) * axisStep;
    for (let price = firstGrid; price <= displayHigh; price += axisStep) {
      const y = Math.round(yForPrice(price)) + 0.5;
      if (y < plotTop || y > plotBottom) continue;
      ctx.moveTo(0, y);
      ctx.lineTo(plotRight, y);
    }
    ctx.stroke();

    // Header band background.
    if (headerH > 0) {
      ctx.fillStyle = '#05070d';
      ctx.fillRect(0, infoH, plotRight, headerH);
    }

    const drawColourBar = (
      x: number, y: number, width: number, height: number,
      color: string, fraction: number, fromRight: boolean,
    ) => {
      if (!settings.showCellBars || fraction <= 0) return;
      const barW = Math.max(0, Math.min(width, fraction * width));
      ctx.fillStyle = color;
      ctx.fillRect(fromRight ? x + width - barW : x, y, barW, height);
    };

    const drawBidAsk = (column: ColumnLayout) => {
      const start = column.x + column.laneW;
      const leftX = start;
      const rightX = start + column.cellW + innerGap;
      for (const row of column.candle.rows) {
        const y = yForPrice(row.price) - rowH / 2;
        const height = Math.max(1, rowH - 2);
        if (y > plotBottom || y + height < plotTop) continue;
        const clippedY = Math.max(plotTop, y);
        const clippedH = Math.min(plotBottom, y + height) - clippedY;
        if (clippedH <= 0) continue;

        const bidMax = settings.units === 'btc' ? row.bidQty : row.bidUsd;
        const askMax = settings.units === 'btc' ? row.askQty : row.askUsd;
        const max = settings.units === 'btc' ? Math.max(1e-9, maxCell / Math.max(1, dataset.lastPrice)) : Math.max(1e-9, maxCell);
        const bidFrac = scaleSize(bidMax, max, settings.colorScale);
        const askFrac = scaleSize(askMax, max, settings.colorScale);
        const normalBid = Math.max(0.04, Math.min(1, bidFrac));
        const normalAsk = Math.max(0.04, Math.min(1, askFrac));

        ctx.fillStyle = COLORS.cellBg;
        ctx.fillRect(leftX, clippedY, column.cellW, clippedH);
        ctx.fillRect(rightX, clippedY, column.cellW, clippedH);

        drawColourBar(leftX, clippedY, column.cellW, clippedH, hexAlpha(COLORS.bidBar, 0.5 + 0.5 * normalBid), bidFrac, true);
        drawColourBar(rightX, clippedY, column.cellW, clippedH, hexAlpha(COLORS.askBar, 0.5 + 0.5 * normalAsk), askFrac, false);

        if (rowH >= 10) {
          const rowMax = Math.max(bidMax, askMax);
          const rowMaxFraction = max > 0 ? rowMax / max : 0;
          const bidText = formatCell(bidMax, settings.units);
          const askText = formatCell(askMax, settings.units);
          setFont(ctx, rowH >= 18 ? 11 : rowH >= 13 ? 10 : 9, row.buyImbalance || row.sellImbalance ? 700 : 500);
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'right';
          ctx.fillStyle = row.sellImbalance || rowMaxFraction >= FOOTPRINT.WHITE_TEXT_AT ? '#ffffff' : COLORS.cellText;
          if (bidMax > 0 && clippedH > 7) ctx.fillText(bidText, leftX + column.cellW - 4, clippedY + clippedH / 2);
          ctx.textAlign = 'left';
          ctx.fillStyle = row.buyImbalance || rowMaxFraction >= FOOTPRINT.WHITE_TEXT_AT ? '#ffffff' : COLORS.cellText;
          if (askMax > 0 && clippedH > 7) ctx.fillText(askText, rightX + 4, clippedY + clippedH / 2);
          ctx.textBaseline = 'alphabetic';
        }
      }
    };

    const drawDelta = (column: ColumnLayout) => {
      const x = column.x + column.laneW;
      const width = column.width - column.laneW;
      for (const row of column.candle.rows) {
        const y = yForPrice(row.price) - rowH / 2;
        const height = Math.max(1, rowH - 2);
        if (y > plotBottom || y + height < plotTop) continue;
        const clippedY = Math.max(plotTop, y);
        const clippedH = Math.min(plotBottom, y + height) - clippedY;
        if (clippedH <= 0) continue;
        const delta = settings.units === 'btc' ? row.askQty - row.bidQty : row.askUsd - row.bidUsd;
        const fraction = scaleSize(Math.abs(delta), settings.units === 'btc' ? Math.max(1e-9, maxCell / Math.max(1, dataset.lastPrice)) : Math.max(1e-9, maxCell), settings.colorScale);
        ctx.fillStyle = COLORS.cellBg;
        ctx.fillRect(x, clippedY, width, clippedH);
        const barW = fraction * width;
        const positive = delta >= 0;
        ctx.fillStyle = positive
          ? hexAlpha(COLORS.askBar, 0.55 + 0.45 * fraction)
          : hexAlpha(COLORS.bidBar, 0.55 + 0.45 * fraction);
        if (settings.showCellBars) {
          ctx.fillRect(positive ? x + width / 2 : x + width / 2 - barW, clippedY, positive ? barW : barW, clippedH);
        }
        if (rowH >= 10) {
          const text = settings.units === 'btc'
            ? `${delta >= 0 ? '+' : '\u2212'}${Math.abs(delta).toFixed(2)}`
            : fpSignedUsd(delta);
          setFont(ctx, rowH >= 18 ? 11 : rowH >= 13 ? 10 : 9, row.buyImbalance || row.sellImbalance ? 700 : 500);
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          ctx.fillStyle = fraction >= FOOTPRINT.WHITE_TEXT_AT ? '#ffffff' : COLORS.cellText;
          if (clippedH > 7) ctx.fillText(text, x + width / 2, clippedY + clippedH / 2);
          ctx.textBaseline = 'alphabetic';
        }
      }
    };

    const drawVolume = (column: ColumnLayout) => {
      const x = column.x + column.laneW;
      const width = column.width - column.laneW;
      for (const row of column.candle.rows) {
        const value = settings.units === 'btc' ? row.bidQty + row.askQty : row.bidUsd + row.askUsd;
        const y = yForPrice(row.price) - rowH / 2;
        const height = Math.max(1, rowH - 2);
        if (y > plotBottom || y + height < plotTop) continue;
        const clippedY = Math.max(plotTop, y);
        const clippedH = Math.min(plotBottom, y + height) - clippedY;
        if (clippedH <= 0) continue;
        const isPoc = Math.abs(row.price - column.candle.pocRowPrice) < 1e-9;
        const fraction = scaleSize(value, settings.units === 'btc'
          ? Math.max(1e-9, (maxCell * 2) / Math.max(1, dataset.lastPrice))
          : Math.max(1e-9, maxCell * 2), settings.colorScale);
        ctx.fillStyle = isPoc ? 'rgba(252,211,77,0.13)' : COLORS.cellBg;
        ctx.fillRect(x, clippedY, width, clippedH);
        if (settings.showCellBars) {
          ctx.fillStyle = isPoc ? 'rgba(252,211,77,0.45)' : hexAlpha(COLORS.volumeBar, 0.55 + 0.45 * fraction);
          ctx.fillRect(x, clippedY, fraction * width, clippedH);
        }
        if (isPoc) {
          ctx.strokeStyle = 'rgba(252,211,77,0.7)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, clippedY + 0.5, width - 1, Math.max(0.5, clippedH - 1));
        }
        if (rowH >= 10) {
          setFont(ctx, rowH >= 18 ? 11 : rowH >= 13 ? 10 : 9, isPoc ? 700 : 500);
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          ctx.fillStyle = isPoc ? '#fde68a' : (fraction >= FOOTPRINT.WHITE_TEXT_AT ? '#ffffff' : COLORS.cellText);
          if (clippedH > 7) {
            ctx.fillText(settings.units === 'btc' ? fpCompactQty(value) : fpCompactUsd(value), x + width / 2, clippedY + clippedH / 2);
          }
          ctx.textBaseline = 'alphabetic';
        }
      }
    };

    const drawProfile = (column: ColumnLayout) => {
      const x = column.x + column.laneW;
      const width = column.width - column.laneW;
      const seam = x + width / 2;
      for (const row of column.candle.rows) {
        const y = yForPrice(row.price) - rowH / 2;
        const height = Math.max(1.4, rowH - 2);
        if (y > plotBottom || y + height < plotTop) continue;
        const clippedY = Math.max(plotTop, y);
        const clippedH = Math.min(plotBottom, y + height) - clippedY;
        if (clippedH <= 0) continue;
        const bid = scaleSize(row.bidUsd, maxCell, settings.colorScale);
        const ask = scaleSize(row.askUsd, maxCell, settings.colorScale);
        if (settings.showCellBars) {
          ctx.fillStyle = hexAlpha(COLORS.bidBar, 0.8);
          ctx.fillRect(seam - bid * width / 2, clippedY, bid * width / 2, clippedH);
          ctx.fillStyle = hexAlpha(COLORS.askBar, 0.8);
          ctx.fillRect(seam, clippedY, ask * width / 2, clippedH);
        }
      }
      const vaTop = yForPrice(column.candle.valueAreaHigh);
      const vaBottom = yForPrice(column.candle.valueAreaLow);
      ctx.strokeStyle = 'rgba(226,232,240,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x + 0.5, Math.max(plotTop, vaTop), width - 1, Math.max(1, Math.min(plotBottom, vaBottom) - Math.max(plotTop, vaTop)));
      ctx.setLineDash([]);
    };

    const drawDeltaVolume = (column: ColumnLayout) => {
      const x = column.x + column.laneW;
      const leftW = column.cellW;
      const rightX = x + leftW + innerGap;
      const rightW = column.cellW;
      for (const row of column.candle.rows) {
        const y = yForPrice(row.price) - rowH / 2;
        const height = Math.max(1, rowH - 2);
        if (y > plotBottom || y + height < plotTop) continue;
        const clippedY = Math.max(plotTop, y);
        const clippedH = Math.min(plotBottom, y + height) - clippedY;
        if (clippedH <= 0) continue;
        const delta = settings.units === 'btc' ? row.askQty - row.bidQty : row.askUsd - row.bidUsd;
        const total = settings.units === 'btc' ? row.askQty + row.bidQty : row.askUsd + row.bidUsd;
        const deltaFrac = scaleSize(Math.abs(delta), Math.max(1e-9, maxCell), settings.colorScale);
        const volumeFrac = scaleSize(total, Math.max(1e-9, maxCell * 2), settings.colorScale);
        ctx.fillStyle = COLORS.cellBg;
        ctx.fillRect(x, clippedY, leftW, clippedH);
        ctx.fillRect(rightX, clippedY, rightW, clippedH);
        if (settings.showCellBars) {
          ctx.fillStyle = delta >= 0 ? hexAlpha(COLORS.askBar, 0.7) : hexAlpha(COLORS.bidBar, 0.7);
          const barW = deltaFrac * leftW;
          ctx.fillRect(delta >= 0 ? x + leftW - barW : x, clippedY, barW, clippedH);
          ctx.fillStyle = hexAlpha(COLORS.volumeBar, 0.75);
          ctx.fillRect(rightX, clippedY, volumeFrac * rightW, clippedH);
        }
        if (rowH >= 10) {
          setFont(ctx, rowH >= 18 ? 10 : 9, 500);
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          ctx.fillStyle = COLORS.cellText;
          if (clippedH > 7) {
            const deltaText = settings.units === 'btc'
              ? `${delta >= 0 ? '+' : '\u2212'}${Math.abs(delta).toFixed(2)}`
              : fpSignedUsd(delta);
            ctx.fillText(deltaText, x + leftW / 2, clippedY + clippedH / 2);
            ctx.fillText(settings.units === 'btc' ? fpCompactQty(total) : fpCompactUsd(total), rightX + rightW / 2, clippedY + clippedH / 2);
          }
          ctx.textBaseline = 'alphabetic';
        }
      }
    };

    // Cells first, so the lanes and summary can sit above them.
    for (const column of columns) {
      if (settings.show === 'bid-ask') drawBidAsk(column);
      else if (settings.show === 'delta') drawDelta(column);
      else if (settings.show === 'volume') drawVolume(column);
      else if (settings.show === 'profile') drawProfile(column);
      else drawDeltaVolume(column);
    }

    // Selection outline.
    const selected = selectedT === null
      ? columns[columns.length - 1]
      : columns.find((column) => column.candle.t === selectedT) ?? columns[columns.length - 1];
    if (selected) {
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        selected.x + 0.5,
        plotTop + 0.5,
        selected.width - 1,
        plotBottom - plotTop - 1,
      );
    }

    // Candle lane: wick, body, amber outline, POC tick, UA marks.
    for (const column of columns) {
      const candle = column.candle;
      const laneCenter = column.x + column.laneW / 2;
      const bodyW = Math.min(FOOTPRINT.BODY_W, Math.max(6, column.laneW - 3));
      const wickTop = yForPrice(candle.h);
      const wickBottom = yForPrice(candle.l);
      if (wickBottom >= plotTop && wickTop <= plotBottom) {
        ctx.strokeStyle = '#6b7280';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(laneCenter) + 0.5, Math.max(plotTop, wickTop));
        ctx.lineTo(Math.round(laneCenter) + 0.5, Math.min(plotBottom, wickBottom));
        ctx.stroke();
        const openY = yForPrice(candle.o);
        const closeY = yForPrice(candle.c);
        const bodyTop = Math.max(plotTop, Math.min(openY, closeY));
        const bodyBottom = Math.min(plotBottom, Math.max(openY, closeY));
        if (bodyBottom - bodyTop >= 0.5) {
          ctx.fillStyle = candle.c >= candle.o ? '#22c55e' : '#ef4444';
          ctx.fillRect(
            column.x + (column.laneW - bodyW) / 2,
            bodyTop,
            bodyW,
            bodyBottom - bodyTop,
          );
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(
            column.x + (column.laneW - bodyW) / 2,
            bodyTop,
            bodyW,
            bodyBottom - bodyTop,
          );
        }
      }
      if (settings.showPocTicks) {
        const pocY = yForPrice(candle.pocRowPrice);
        if (pocY >= plotTop - 10 && pocY <= plotBottom + 10) {
          ctx.fillStyle = COLORS.poc;
          ctx.fillRect(column.xRight - 4, pocY - 10, 4, 20);
        }
      }
      if (settings.showUaLines) {
        if (candle.uaHigh !== null) {
          const y = yForPrice(candle.uaHigh);
          if (y >= plotTop && y <= plotBottom) {
            ctx.strokeStyle = COLORS.ua;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(column.x, y + 0.5);
            ctx.lineTo(column.xRight, y + 0.5);
            ctx.stroke();
          }
        }
        if (candle.uaLow !== null) {
          const y = yForPrice(candle.uaLow);
          if (y >= plotTop && y <= plotBottom) {
            ctx.strokeStyle = COLORS.ua;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(column.x, y + 0.5);
            ctx.lineTo(column.xRight, y + 0.5);
            ctx.stroke();
          }
        }
      }
    }

    // B/S header band.
    if (settings.showBuySellPct && headerH > 0) {
      for (const column of columns) {
        const buy = column.candle.buyPct;
        const sell = column.candle.sellPct;
        const cx = column.x + column.width / 2;
        setFont(ctx, 11, 700);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = COLORS.up;
        ctx.fillText(`B ${Math.round(buy)}%`, cx, infoH + 11);
        ctx.fillStyle = COLORS.down;
        ctx.fillText(`S ${Math.round(sell)}%`, cx, infoH + 25);
        ctx.textBaseline = 'alphabetic';
      }
      ctx.fillStyle = 'rgba(31,41,55,0.7)';
      ctx.fillRect(0, infoH + headerH - 0.5, plotRight, 0.5);
    }

    // Levels: horizontal lines across the plot.
    const levelY: Array<{ level: FootprintDataset['levels'][number]; y: number }> = [];
    for (const level of dataset.levels) {
      const y = yForPrice(level.price);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, plotTop, plotRight, plotBottom - plotTop);
      ctx.clip();
      ctx.strokeStyle = level.color;
      ctx.lineWidth = level.width;
      ctx.setLineDash(level.dash);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(plotRight, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.restore();
      ctx.setLineDash([]);
      levelY.push({ level, y });
    }

    // UA / nPOC lines that start at their candle and run to the right edge.
    const annotationLabels: Array<{ y: number; text: string; color: string; id: string }> = [];
    const annotationSources: Array<{ annotation: FootprintDataset['annotations'][number]; y: number }> = [];
    for (const annotation of dataset.annotations) {
      const startX = timeToX(layout, annotation.fromT, intervalMs);
      if (startX === null) continue;
      const y = yForPrice(annotation.price);
      if (y < plotTop || y > plotBottom) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, plotTop, plotRight, plotBottom - plotTop);
      ctx.clip();
      ctx.strokeStyle = annotation.stale ? 'rgba(107,114,128,0.45)' : annotation.color;
      ctx.lineWidth = 1;
      ctx.setLineDash(annotation.kind === 'npoc' ? [6, 4] : [2, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.max(0, startX), Math.round(y) + 0.5);
      ctx.lineTo(plotRight - 4, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.restore();
      ctx.setLineDash([]);
      annotationSources.push({ annotation, y });
      if (!compact) {
        annotationLabels.push({
          y,
          text: annotation.label,
          color: annotation.stale ? '#6b7280' : annotation.kind === 'npoc' ? COLORS.poc : COLORS.uaLine,
          id: annotation.id,
        });
      }
    }

    // Annotate the visible right labels, stacked so they never collide.
    annotationLabels.sort((a, b) => a.y - b.y);
    let lastAnnotationY = -Infinity;
    for (const label of annotationLabels) {
      let y = Math.max(plotTop + 12, label.y);
      if (y - lastAnnotationY < 14) y = lastAnnotationY + 14;
      y = Math.min(plotBottom - 4, y);
      lastAnnotationY = y;
      setFont(ctx, 11, 500);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const textW = ctx.measureText(label.text).width;
      const x = plotRight - 10;
      ctx.fillStyle = 'rgba(5,7,13,0.78)';
      ctx.fillRect(x - textW - 4, y - 7, textW + 8, 14);
      ctx.fillStyle = label.color;
      ctx.fillText(label.text, x, y);
      layout.annotationLabelBoxes.push({ x: x - textW - 4, y: y - 7, w: textW + 8, h: 14, id: label.id });
    }
    ctx.textBaseline = 'alphabetic';

    // Summary strip.
    if (settings.showSummary && summaryH > 0) {
      const rowHSummary = FOOTPRINT.SUMMARY_ROW_H;
      const top = plotBottom;
      const labels = ['Volume', 'Delta', 'Delta %', 'Cum \u0394', 'Time'];
      ctx.fillStyle = '#060a10';
      ctx.fillRect(0, top, w, summaryH);
      ctx.strokeStyle = 'rgba(31,41,55,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, top + 0.5);
      ctx.lineTo(w, top + 0.5);
      ctx.stroke();
      for (let r = 0; r < 5; r++) {
        setFont(ctx, 10, 500);
        ctx.fillStyle = COLORS.faint;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(labels[r], plotRight + 6, top + r * rowHSummary + rowHSummary / 2);
      }
      for (const column of columns) {
        const candle = column.candle;
        const cellH = rowHSummary - 2;
        for (let r = 0; r < 5; r++) {
          const y = top + r * rowHSummary + 1;
          const x = column.x;
          const width = column.width;
          if (r === 0) {
            ctx.fillStyle = COLORS.summaryNeutral;
            ctx.fillRect(x, y, width, cellH);
            const fraction = maxVolume > 0 ? candle.volumeUsd / maxVolume : 0;
            ctx.fillStyle = 'rgba(148,163,184,0.42)';
            ctx.fillRect(x, y, width * clamp(fraction, 0, 1), cellH);
            setFont(ctx, width > 64 ? 10.5 : 9, 500);
            ctx.fillStyle = COLORS.summaryText;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(
              settings.units === 'btc' ? fpCompactQty(candle.volumeQty) : fpCompactUsd(candle.volumeUsd),
              x + width / 2,
              y + cellH / 2,
            );
            continue;
          }
          if (r === 4) {
            ctx.fillStyle = 'transparent';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            setFont(ctx, 10, 500);
            ctx.fillStyle = '#8b93a1';
            ctx.fillText(fpTimeLocal(candle.t), x + width / 2, y + cellH / 2);
            continue;
          }
          const value = r === 1 ? candle.deltaUsd : r === 2 ? (candle.volumeUsd > 0 ? (candle.deltaUsd / candle.volumeUsd) * 100 : 0) : candle.cumDeltaUsd;
          const unitValue = r === 1
            ? (settings.units === 'btc' ? candle.deltaQty : candle.deltaUsd)
            : (settings.units === 'btc' ? candle.cumDeltaQty : candle.cumDeltaUsd);
          const maximum = r === 1 ? maxDelta : r === 2 ? 100 : maxCum;
          const intensity = maximum > 0 ? clamp(Math.abs(value) / maximum, 0, 1) : 0;
          const positive = value >= 0;
          ctx.fillStyle = positive
            ? `rgba(22,163,74,${0.1 + intensity * 0.55})`
            : `rgba(185,28,28,${0.1 + intensity * 0.58})`;
          ctx.fillRect(x, y, width, cellH);
          setFont(ctx, width > 64 ? 10.5 : 9, intensity > 0.55 ? 700 : 500);
          ctx.fillStyle = intensity > 0.55 ? '#ffffff' : (positive ? '#86efac' : '#fca5a5');
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const text = r === 2
            ? fpSignedPercent(value)
            : settings.units === 'btc'
              ? fpCompactQty(unitValue, true)
              : fpSignedUsd(unitValue);
          ctx.fillText(text, x + width / 2, y + cellH / 2);
        }
      }

      // The summary repeats its row labels in the left gutter. Draw the gutter
      // after the cells so the oldest visible column cannot cover them.
      ctx.fillStyle = COLORS.gutter;
      ctx.fillRect(0, top, gutterW, 5 * rowHSummary);
      for (let r = 0; r < 5; r++) {
        setFont(ctx, 10, 500);
        ctx.fillStyle = COLORS.faint;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(labels[r], 8, top + r * rowHSummary + rowHSummary / 2);
      }
      ctx.textBaseline = 'alphabetic';
    }

    // Left gutter overlay: the oldest candles show faintly underneath.
    ctx.fillStyle = COLORS.gutter;
    ctx.fillRect(0, plotTop, gutterW, plotBottom - plotTop);

    // Level labels inside the gutter. On phones the plot is too narrow for the
    // label text; the level lines and axis tags still carry the price.
    const visibleHigh = topPrice;
    const visibleLow = displayLow;
    const above = levelY.filter(({ level }) => level.price > visibleHigh);
    const below = levelY.filter(({ level }) => level.price < visibleLow);
    const inView = levelY.filter(({ y }) => y >= plotTop && y <= plotBottom);

    const drawGutterLabel = (
      text: string, y: number, color: string, id: string,
      action: 'remove' | 'offscreen', align: CanvasTextAlign = 'left',
    ): void => {
      setFont(ctx, 12, 500);
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      const x = align === 'right' ? gutterW - 8 : 12;
      ctx.fillText(text, x, y);
      const width = ctx.measureText(text).width;
      layout.levelLabelBoxes.push({
        x: align === 'right' ? x - width : x - 2,
        y: y - 9,
        w: width + 4,
        h: 18,
        id,
        action,
      });
    };

    if (!compact) {
    let aboveLabels = above;
    let belowLabels = below;
    const collapsedAbove = !offscreenExpanded && above.length > FOOTPRINT.OFFSCREEN_COLLAPSE_AT;
    const collapsedBelow = !offscreenExpanded && below.length > FOOTPRINT.OFFSCREEN_COLLAPSE_AT;
    if (collapsedAbove) {
      aboveLabels = above.slice(0, 2);
    } else if (offscreenExpanded) {
      belowLabels = below;
    }
    if (collapsedBelow) {
      belowLabels = below.slice(0, 2);
    }

    aboveLabels.forEach(({ level }, index) => {
      const y = plotTop + 13 + index * FOOTPRINT.LABEL_STACK_PX;
      drawGutterLabel(displayLevelLabel(level.label, true, false), y, level.textColor, level.id, level.removable ? 'remove' : 'offscreen');
    });
    if (collapsedAbove) {
      const y = plotTop + 13 + aboveLabels.length * FOOTPRINT.LABEL_STACK_PX;
      drawGutterLabel(`\u25b2 +${above.length - aboveLabels.length} more`, y, COLORS.muted, 'offscreen-above', 'offscreen');
    }
    belowLabels.forEach(({ level }, index) => {
      const y = plotBottom - 13 - index * FOOTPRINT.LABEL_STACK_PX;
      drawGutterLabel(displayLevelLabel(level.label, false, true), y, level.textColor, level.id, level.removable ? 'remove' : 'offscreen');
    });
    if (collapsedBelow) {
      const y = plotBottom - 13 - belowLabels.length * FOOTPRINT.LABEL_STACK_PX;
      drawGutterLabel(`\u25bc +${below.length - belowLabels.length} more`, y, COLORS.muted, 'offscreen-below', 'offscreen');
    }
    if (!collapsedAbove && !collapsedBelow && offscreenExpanded && (above.length || below.length)) {
      drawGutterLabel('\u25b2 show less', plotTop + 13 + above.length * FOOTPRINT.LABEL_STACK_PX, COLORS.muted, 'offscreen-less', 'offscreen');
    }

    // In-view labels de-overlapped by 20 px. Draw from top down.
    inView.sort((a, b) => a.y - b.y);
    let lastLabelY = -Infinity;
    for (const { level, y } of inView) {
      let drawY = Math.max(plotTop + 12, y);
      if (drawY - lastLabelY < FOOTPRINT.LABEL_STACK_PX) drawY = lastLabelY + FOOTPRINT.LABEL_STACK_PX;
      drawY = Math.min(plotBottom - 10, drawY);
      lastLabelY = drawY;
      drawGutterLabel(level.label, drawY, level.textColor, level.id, level.removable ? 'remove' : 'offscreen');
    }
    }

    // Right-side summary labels are already drawn; gutter labels sit above.
    // Small border between the sticky gutter and the plot.
    ctx.strokeStyle = 'rgba(31,41,55,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gutterW + 0.5, plotTop);
    ctx.lineTo(gutterW + 0.5, h);
    ctx.stroke();

    // Right gutter labels for the summary strip (drawn above the plot area only).
    if (settings.showSummary && summaryH > 0) {
      setFont(ctx, 10, 500);
      ctx.fillStyle = COLORS.faint;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const labels = ['Volume', 'Delta', 'Delta %', 'Cum \u0394', 'Time'];
      for (let r = 0; r < 5; r++) {
        ctx.fillText(labels[r], plotRight + 6, plotBottom + r * FOOTPRINT.SUMMARY_ROW_H + FOOTPRINT.SUMMARY_ROW_H / 2);
      }
      ctx.textBaseline = 'alphabetic';
    }

    // Liquidation labels and markers.
    if (settings.showRekt) {
      const lastX = plotRight;
      const filtered = dataset.liqEvents.filter((event) => event.usd >= FOOTPRINT.MIN_REKT_USD);
      for (const event of filtered) {
        if (dataset.recordStart !== null && event.t < dataset.recordStart) continue;
        const x = timeToX(layout, event.t, intervalMs);
        if (x === null || x > lastX) continue;
        const y = yForPrice(event.price);
        if (y < plotTop || y > plotBottom) continue;
        const color = event.side === 'short' ? COLORS.rektShort : COLORS.rektLong;
        const amount = event.usd >= 1e6
          ? `$${(event.usd / 1e6).toFixed(1)}M`
          : event.usd >= 10_000
            ? `$${Math.round(event.usd / 1_000)}K`
            : event.usd >= 1_000
              ? `$${(event.usd / 1_000).toFixed(1).replace(/\.0$/, '')}K`
              : `$${Math.round(event.usd)}`;
        const text = `${event.side === 'short' ? 'shorts' : 'longs'} rekt ${event.usd >= 1_000 ? amount.replace('$', '') : Math.round(event.usd)}`;
        ctx.fillStyle = color;
        ctx.fillRect(x - 1, y - 7, 2, 14);
        if (!compact) {
          setFont(ctx, 12, 600);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const width = ctx.measureText(text).width;
          const textX = Math.min(plotRight - width - 2, x + 7);
          ctx.fillStyle = 'rgba(5,7,13,0.78)';
          ctx.fillRect(textX - 2, y - 8, width + 4, 16);
          ctx.fillStyle = color;
          ctx.fillText(text, textX, y);
          layout.rektBoxes.push({ x: textX - 2, y: y - 8, w: width + 4, h: 16, id: event.id });
        }
      }
    }
    ctx.textBaseline = 'alphabetic';

    // Recording start marker.
    if (dataset.recordStart !== null) {
      const x = timeToX(layout, dataset.recordStart, intervalMs);
      if (x !== null && x >= 0 && x <= plotRight) {
        ctx.strokeStyle = COLORS.record;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, plotTop);
        ctx.lineTo(x + 0.5, plotBottom);
        ctx.stroke();
        ctx.setLineDash([]);
        if (!compact) {
          setFont(ctx, 12, 500);
          ctx.fillStyle = 'rgba(248,113,113,0.85)';
          ctx.textAlign = 'left';
          ctx.fillText('REKT recorded from here \u25b8', Math.min(x + 6, plotRight - 160), plotBottom - 8);
        }
      }
    }

    // Current price line and tag.
    const liveY = yForPrice(dataset.lastPrice);
    if (liveY >= plotTop && liveY <= plotBottom) {
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(liveY) + 0.5);
      ctx.lineTo(plotRight, Math.round(liveY) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Price axis column.
    ctx.fillStyle = COLORS.axisBg;
    ctx.fillRect(plotRight, 0, axisW, h);
    ctx.strokeStyle = 'rgba(31,41,55,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotRight + 0.5, plotTop);
    ctx.lineTo(plotRight + 0.5, h);
    ctx.stroke();

    setFont(ctx, 12, 500);
    const firstLabel = Math.ceil(displayLow / axisStep) * axisStep;
    for (let price = firstLabel; price <= displayHigh; price += axisStep) {
      const y = yForPrice(price);
      if (y < plotTop + 8 || y > plotBottom - 6) continue;
      if (liveY >= plotTop && Math.abs(y - liveY) < 15) continue;
      ctx.fillStyle = COLORS.axisText;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u2013', plotRight + 8, y);
      ctx.fillText(fpPrice(price), plotRight + 22, y);
    }
    ctx.textBaseline = 'alphabetic';

    // Level axis tags, stacked when they collide.
    const tags = levelY
      .filter(({ level, y }) => level.axisTag && y >= plotTop && y <= plotBottom)
      .map(({ level, y }) => ({ level, y }))
      .sort((a, b) => a.y - b.y);
    let lastTagY = -Infinity;
    for (const tag of tags) {
      let y = tag.y - 11;
      if (y - lastTagY < 23) y = lastTagY + 23;
      y = Math.min(plotBottom - 22, y);
      lastTagY = y;
      const fill = tag.level.kind === 'user'
        ? 'rgba(5,7,13,0.92)'
        : 'rgba(5,7,13,0.86)';
      drawPill(ctx, plotRight + 5, y, Math.min(82, axisW - 8), 22, fill, tag.level.color, fpPrice(tag.level.price), tag.level.textColor, 10, true);
    }

    // Current price tag always wins over the axis labels and level tags.
    if (liveY >= plotTop - 2 && liveY <= plotBottom + 2) {
      const y = clamp(liveY - 11, 0, h - 22);
      drawPill(ctx, plotRight + 4, y, Math.min(82, axisW - 6), 22, '#ffffff', null, fpPrice(dataset.lastPrice), '#05070d', 11, true);
    }

    // Hovered price pill (white), drawn only if the pointer is inside the plot.
    if (hoverPoint.inside && hoverPoint.y >= plotTop && hoverPoint.y <= plotBottom) {
      const snapped = priceFromY(layout, hoverPoint.y, true);
      const y = clamp(hoverPoint.y - 10, 0, h - 20);
      if (Math.abs(hoverPoint.y - liveY) > 14) {
        drawPill(ctx, plotRight + 4, y, Math.min(82, axisW - 6), 20, 'rgba(255,255,255,0.92)', null, fpPrice(snapped), '#05070d', 10, true);
      }
    }

    // Notable-event dots sit on the outer edge of the cell so the printed
    // number stays legible.
    for (const column of columns) {
      for (const marker of column.candle.notable) {
        const row = column.candle.rows.find((item) => Math.abs(item.price - marker.price) < 1e-9);
        if (!row) continue;
        const y = yForPrice(row.price) - 1;
        if (y < plotTop || y > plotBottom) continue;
        const x = marker.side === 'ask'
          ? column.x + column.laneW + column.cellW + column.innerGap + column.cellW - 8
          : column.x + column.laneW + 8;
        if (rowH >= 8) {
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fillStyle = '#22c55e';
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          layout.notableBoxes.push({ x: x - 8, y: y - 8, w: 16, h: 16, candleT: column.candle.t, id: marker.id });
        }
      }
    }

    // Crosshair and row highlight.
    if (hoverPoint.inside && hoverPoint.x >= 0 && hoverPoint.x <= plotRight) {
      const x = hoverPoint.x;
      const y = hoverPoint.y;
      const snappedY = rowY(layout, priceFromY(layout, y, true));
      if (y >= plotTop && y <= plotBottom) {
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        ctx.fillRect(0, snappedY - rowH / 2, plotRight, rowH);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plotTop);
      ctx.lineTo(Math.round(x) + 0.5, plotBottom);
      if (y >= plotTop && y <= plotBottom) {
        ctx.moveTo(0, Math.round(snappedY) + 0.5);
        ctx.lineTo(plotRight, Math.round(snappedY) + 0.5);
      }
      ctx.stroke();
    }
  }, [
    dataset, settings, interval, intervalMs, rowSize, selectedT, size, view, hoverPoint,
    loading, error, onAutoRowSize,
  ]);

  drawRef.current = draw;

  useLayoutEffect(() => {
    schedule();
  }, [draw, schedule]);

  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
  }, []);

  const updateTooltip = useCallback((px: number, py: number) => {
    const layout = layoutRef.current;
    if (!layout) {
      setTooltip(null);
      return;
    }
    if (px > layout.plotRight || py < layout.infoH || py > layout.plotBottom) {
      setTooltip(null);
      return;
    }
    const clientX = px;
    const clientY = py;

    const rekt = layout.rektBoxes.find((box) => px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h);
    if (rekt) {
      const event = dataset.liqEvents.find((item) => item.id === rekt.id);
      if (event) {
        setTooltip({
          x: clientX,
          y: clientY,
          lines: [
            { text: `${event.side === 'short' ? 'SHORTS' : 'LONGS'} REKT`, color: event.side === 'short' ? COLORS.rektShort : COLORS.rektLong },
            { text: `${fpTimeLocal(event.t)} \u00b7 ${event.side === 'short' ? 'short' : 'long'} liquidation` },
            { text: `${fpCompactUsd(event.usd)} at ${fpPrice(event.price)}` },
          ],
        });
        return;
      }
    }

    const notable = layout.notableBoxes.find((box) => px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h);
    if (notable) {
      const candle = dataset.candles.find((item) => item.t === notable.candleT);
      const marker = candle?.notable.find((item) => item.id === notable.id);
      if (candle && marker) {
        setTooltip({
          x: clientX,
          y: clientY,
          lines: [
            { text: marker.label, color: marker.side === 'ask' ? COLORS.up : COLORS.down },
            { text: `${fpCompactUsd(marker.usd)} \u00b7 ${marker.side === 'ask' ? 'bought at ask' : 'sold at bid'}` },
            { text: `${fpPrice(marker.price)} \u00b7 ${fpTimeLocal(candle.t)}` },
          ],
        });
        return;
      }
    }

    const column = layout.columns.find((item) => px >= item.x && px <= item.xRight);
    if (!column) {
      setTooltip(null);
      return;
    }
    const candle = column.candle;
    if (py < layout.plotTop) {
      const delta = candle.deltaUsd;
      setTooltip({
        x: clientX,
        y: clientY,
        lines: [
          { text: `${fpTimeLocal(candle.t)} candle`, color: COLORS.white },
          { text: `O ${fpPrice(candle.o)}  H ${fpPrice(candle.h)}  L ${fpPrice(candle.l)}  C ${fpPrice(candle.c)}` },
          { text: `vol $${fpCompactUsd(candle.volumeUsd)}  \u0394 ${fpSignedUsd(delta)} (${fpSignedPercent(candle.volumeUsd > 0 ? (delta / candle.volumeUsd) * 100 : 0)})` },
          { text: `POC ${fpPrice(candle.pocPrice)}` },
        ],
      });
      return;
    }
    const snapped = priceFromY(layout, py, false);
    const row = candle.rows.reduce<FootprintRow | null>((best, item) => {
      if (Math.abs(item.price - snapped) <= layout.rowSize / 2) return item;
      if (!best) return best;
      return Math.abs(item.price - snapped) < Math.abs(best.price - snapped) && Math.abs(item.price - snapped) <= layout.rowSize
        ? item
        : best;
    }, null);
    if (!row) {
      setTooltip({
        x: clientX,
        y: clientY,
        lines: [
          { text: `${fpTimeLocal(candle.t)} candle`, color: COLORS.white },
          { text: `O ${fpPrice(candle.o)}  H ${fpPrice(candle.h)}  L ${fpPrice(candle.l)}  C ${fpPrice(candle.c)}` },
          { text: `vol $${fpCompactUsd(candle.volumeUsd)}  \u0394 ${fpSignedUsd(candle.deltaUsd)}` },
          { text: `POC ${fpPrice(candle.pocPrice)}` },
        ],
      });
      return;
    }
    const delta = row.askUsd - row.bidUsd;
    const ratio = row.bidUsd > 0 ? row.askUsd / row.bidUsd : row.askUsd > 0 ? Infinity : 1;
    const imbalance = row.buyImbalance
      ? `buy ${fpRatio(ratio)}`
      : row.sellImbalance
        ? `sell ${fpRatio(row.askUsd > 0 ? row.bidUsd / row.askUsd : Infinity)}`
        : 'none';
    setTooltip({
      x: clientX,
      y: clientY,
      lines: [
        { text: `${fpPrice(row.price)}  \u00b7  ${fpTimeLocal(candle.t)}`, color: COLORS.white },
        { text: `bid ${fpCompactUsd(row.bidUsd)}  \u00b7  ask ${fpCompactUsd(row.askUsd)}` },
        { text: `\u0394 ${fpSignedUsd(delta)}  \u00b7  ratio ${fpRatio(ratio)}`, color: delta >= 0 ? COLORS.up : COLORS.down },
        { text: `imbalance: ${imbalance}` },
      ],
    });
  }, [dataset]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    lastPointerRef.current = { x, y, inside: true };
    setHoverPoint({ x, y, inside: true });
    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) {
        setView((current) => ({
          ...current,
          shiftX: drag.shiftX + dx,
          priceShiftRows: drag.priceShiftRows - (dy / 22.5) * (current.zoomY || 1),
        }));
      }
      return;
    }
    updateTooltip(x, y);
  }, [updateTooltip]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const layout = layoutRef.current;
    if (!layout) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (event.button === 2) return;
    const label = layout.levelLabelBoxes.find((box) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h);
    if (label) {
      if (label.action === 'remove') onRemoveLevel(label.id);
      else if (label.id === 'offscreen-above' || label.id === 'offscreen-below') setOffscreenExpanded(true);
      else if (label.id === 'offscreen-less') setOffscreenExpanded(false);
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      shiftX: view.shiftX,
      priceShiftRows: view.priceShiftRows,
      moved: false,
      onAxis: x > layout.plotRight,
    };
    canvas.setPointerCapture(event.pointerId);
  }, [onRemoveLevel, view.shiftX, view.priceShiftRows]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (!drag || drag.moved) return;
    const layout = layoutRef.current;
    if (!layout) return;
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const column = layout.columns.find((item) => x >= item.x && x <= item.xRight);
    if (column && y >= layout.infoH && y <= layout.plotBottom) {
      onSelect(selectedT === column.candle.t ? null : column.candle.t);
    }
  }, [onSelect, selectedT]);

  const onPointerLeave = useCallback(() => {
    lastPointerRef.current = { ...lastPointerRef.current, inside: false };
    setHoverPoint((current) => ({ ...current, inside: false }));
    setTooltip(null);
  }, []);

  const onContextMenu = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const layout = layoutRef.current;
    const canvas = canvasRef.current;
    if (!layout || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const y = event.clientY - rect.top;
    if (y < layout.plotTop || y > layout.plotBottom) return;
    onAddLevel(priceFromY(layout, y, true));
  }, [onAddLevel]);

  const resetView = useCallback(() => {
    setView({ zoom: 1, zoomY: 1, shiftX: 0, priceShiftRows: 0 });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      const layout = layoutRef.current;
      if (!layout) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (y < layout.infoH || y > layout.plotBottom) return;
      event.preventDefault();
      if (event.shiftKey) {
        const factor = event.deltaY > 0 ? 0.92 : 1.08;
        setView((current) => ({
          ...current,
          zoomY: clamp(current.zoomY * factor, 0.55, 2.2),
        }));
        return;
      }
      setView((current) => {
        const nextZoom = clamp(current.zoom * (event.deltaY > 0 ? 0.92 : 1.08), FOOTPRINT.COL_MIN / FOOTPRINT.COL_PITCH, FOOTPRINT.COL_MAX / FOOTPRINT.COL_PITCH);
        const oldPitch = FOOTPRINT.COL_PITCH * current.zoom;
        const newPitch = FOOTPRINT.COL_PITCH * nextZoom;
        const world = (layout.plotRight - layout.labelMargin + current.shiftX - x) / Math.max(1, oldPitch);
        const shiftX = x + world * newPitch - (layout.plotRight - layout.labelMargin);
        return { ...current, zoom: nextZoom, shiftX };
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const layout = layoutRef.current;
    const step = layout?.colPitch ?? FOOTPRINT.COL_PITCH;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setView((current) => ({ ...current, shiftX: current.shiftX + step }));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setView((current) => ({ ...current, shiftX: current.shiftX - step }));
    } else if (event.key === 'Home' || event.key === 'Escape') {
      event.preventDefault();
      resetView();
    }
  }, [resetView]);

  const tooltipStyle = useMemo(() => {
    if (!tooltip) return undefined;
    const flipX = tooltip.x + 290 > size.w;
    const flipY = tooltip.y + 120 > size.h;
    return {
      left: `${flipX ? Math.max(6, tooltip.x - 280) : tooltip.x + 14}px`,
      top: `${flipY ? Math.max(6, tooltip.y - 100) : tooltip.y + 14}px`,
    };
  }, [tooltip, size]);

  return (
    <div className="fp-canvas-host" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="block h-full w-full cursor-crosshair select-none outline-none"
        tabIndex={0}
        role="img"
        aria-label="Footprint chart: order flow inside each candle"
        data-mock={mock ? 'true' : 'false'}
        onDoubleClick={resetView}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      />
      {offLive && (
        <button type="button" className="fp-back-live" onClick={resetView}>
          Back to live
        </button>
      )}
      {tooltip && (
        <div className="fp-tooltip" style={tooltipStyle} role="tooltip">
          {tooltip.lines.map((line, index) => (
            <div key={`${line.text}-${index}`} style={line.color ? { color: line.color } : undefined}>
              {line.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
