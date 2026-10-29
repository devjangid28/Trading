import {
  useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent,
} from 'react';
import type { TerminalBook, TerminalSpan, TerminalTrade } from '../../shared/types';
import { TERMINAL_SPANS } from '../../shared/types';
import { clamp, fmtCompact, fmtPrice, fmtUsd } from '../lib/format';
import {
  nearestWalls, type BookFrame, type SideWall,
} from './math';
import {
  bubblePoints, bubbleRadius, cellAt, clampNumber, frameAt, frameIndexAt,
  frameRowTotals, heatColor, heatIntensity, liquidityScaleForFrame, nextLiquidityScale,
  percentile, priceToY, rowCountFor, rowIndexForPrice, SPAN_MS, stepMsFor, timeToX,
  tooltipPosition, volumeBuckets, wallAt, xToTime, yToPrice, ZOOM_MAX, ZOOM_MIN,
  type BubblePoint, type CellHit,
} from './heatmap';
import {
  BUBBLE_KEYS, COLUMN_KEYS, COLUMN_LABEL, CONTRAST_GAIN, CONTRAST_KEYS,
  DEFAULT_SETTINGS, loadSettings, RANGE_KEYS, RANGE_PCT, saveSettings, STEP_KEYS,
  type ColumnKey, type HeatmapSettings,
} from './settings';

const PM = '\u00b1';
const DOT = '\u00b7';
const DARK = '#05070b';
const spanText = (span: TerminalSpan) => span === '1d' ? '1D' : span;

function axisDigits(range: number): number {
  const step = Math.max(range / 6, 1e-12);
  return clamp(Math.ceil(-Math.log10(step)), 0, 8);
}

function timeLabel(t: number, spanMs: number): string {
  const d = new Date(t + 330 * 60_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (spanMs >= 86_400_000) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${hh}:${mm}`;
  }
  if (spanMs >= 3_600_000) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

function durations(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1_000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function signedUsd(v: number): string {
  if (Math.abs(v) < 0.5) return '$0';
  return `${v > 0 ? '+' : '-'}${fmtUsd(Math.abs(v))}`;
}

function fmtQty(v: number): string {
  if (!(v > 0)) return '-';
  if (v >= 1_000) return fmtCompact(v);
  const digits = v >= 1 ? 4 : v >= 0.01 ? 5 : 8;
  return v.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function fmtLevelPrice(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '-';
  if (v >= 100) {
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return fmtPrice(v);
}

function autoRangePct(
  book: TerminalBook | null,
  frames: readonly BookFrame[],
  start: number,
  end: number,
  mid: number,
): number {
  if (!(mid > 0)) return 0.0005;
  const distances: number[] = [];
  if (book && book.mid > 0) {
    for (const level of [...book.bids, ...book.asks]) {
      const distance = Math.abs(level.price - mid) / mid;
      if (distance > 0 && distance < 0.02) distances.push(distance);
    }
  }
  for (const frame of frames) {
    if (frame.asOf < start || frame.asOf > end) continue;
    const distance = Math.abs(frame.mid - mid) / mid;
    if (distance > 0 && distance < 0.02) distances.push(distance);
  }
  const edge = Math.max(percentile(distances, 0.98), 0.00008);
  return clamp(edge * 1.08, 0.00002, 0.02);
}

interface Geom {
  w: number;
  h: number;
  ml: number;
  t: number;
  bottom: number;
  plotW: number;
  plotH: number;
  right: number;
  priceAxisW: number;
  cols: ColumnKey[];
  colW: number;
  columnsX: number;
  start: number;
  end: number;
  spanMs: number;
  priceMin: number;
  priceMax: number;
  mid: number;
  latest: BookFrame;
  frame: BookFrame;
  shown: BookFrame[];
  visibleTrades: TerminalTrade[];
  rows: number;
  rowH: number;
  rowPx: number;
  volH: number;
  volTop: number;
  volBase: number;
  timeY: number;
  x: (time: number) => number;
  y: (price: number) => number;
}

function buildGeom(
  frames: BookFrame[],
  trades: TerminalTrade[],
  start: number,
  end: number,
  rangePct: number,
  columns: ColumnKey[],
  settings: Pick<HeatmapSettings, 'rowPx' | 'showVolume'>,
  size: { w: number; h: number },
): Geom | null {
  const latest = frames[frames.length - 1];
  if (!latest || latest.mid <= 0 || size.w <= 0 || size.h <= 0 || end <= start) return null;
  const frame = frameAt(frames, end) ?? latest;
  const spanMs = end - start;
  const cols = size.w >= 760 ? columns : [];
  const priceAxisW = size.w < 560 ? 54 : 72;
  const colW = cols.length ? (size.w < 1_000 ? 52 : 58) : 0;
  const ml = size.w < 560 ? 4 : 6;
  const mr = priceAxisW + cols.length * colW;
  const t = cols.length ? 22 : 8;
  const volH = settings.showVolume && trades.length ? (size.h < 320 ? 30 : 42) : 0;
  const timeAxisH = 26;
  const plotW = Math.max(20, size.w - ml - mr);
  const plotH = Math.max(20, size.h - t - timeAxisH - volH);
  const right = ml + plotW;
  const bottom = t + plotH;
  const priceMin = frame.mid * (1 - rangePct);
  const priceMax = frame.mid * (1 + rangePct);
  if (priceMax <= priceMin) return null;
  const shown = frames.filter((f) => f.asOf >= start && f.asOf <= end);
  const x = (time: number) => timeToX(time, start, end, ml, plotW);
  const y = (price: number) => priceToY(price, priceMin, priceMax, t, plotH);
  const visibleTrades = trades.filter(
    (tr) => tr.t >= start && tr.t <= end && tr.price >= priceMin && tr.price <= priceMax,
  );
  const rows = rowCountFor(plotH, settings.rowPx);
  return {
    w: size.w, h: size.h, ml, t, bottom, plotW, plotH, right,
    priceAxisW, cols, colW, columnsX: right + priceAxisW,
    start, end, spanMs, priceMin, priceMax, mid: frame.mid,
    latest, frame, shown, visibleTrades,
    rows, rowH: plotH / rows, rowPx: settings.rowPx,
    volH, volTop: bottom + 5, volBase: bottom + Math.max(5, volH - 2), timeY: size.h - 8,
    x, y,
  };
}

function drawColumns(ctx: CanvasRenderingContext2D, g: Geom, trades: TerminalTrade[]): void {
  if (!g.cols.length) return;
  const rows = clamp(Math.floor(g.plotH / 32), 6, 12);
  const rowH = g.plotH / rows;
  const bins = Array.from({ length: rows }, () => ({
    bid: 0, ask: 0, side: null as 'bid' | 'ask' | 'both' | null,
    volume: 0, delta: 0, count: 0,
    lastT: 0, lastUsd: 0, lastSide: null as 'buy' | 'sell' | null,
  }));
  const binAt = (price: number) => rowIndexForPrice(price, g.priceMin, g.priceMax, rows);
  const bookRows = frameRowTotals(g.frame, g.priceMin, g.priceMax, rows);
  for (let i = 0; i < rows; i++) {
    const b = bins[i];
    b.bid = bookRows.bid[i];
    b.ask = bookRows.ask[i];
    b.side = b.bid > 0 && b.ask > 0 ? 'both' : b.bid > 0 ? 'bid' : b.ask > 0 ? 'ask' : null;
  }
  for (const tr of trades) {
    if (tr.price < g.priceMin || tr.price > g.priceMax) continue;
    const b = bins[binAt(tr.price)];
    b.volume += tr.usd;
    b.delta += tr.side === 'buy' ? tr.usd : -tr.usd;
    b.count += 1;
    if (tr.t >= b.lastT) {
      b.lastT = tr.t;
      b.lastUsd = tr.usd;
      b.lastSide = tr.side;
    }
  }

  const midBin = binAt(g.mid);
  const cum = new Array<number>(rows).fill(0);
  let running = 0;
  for (let d = 0; d < rows; d++) {
    for (const i of new Set([midBin - d, midBin + d])) {
      if (i < 0 || i >= rows) continue;
      running += bins[i].bid + bins[i].ask;
      cum[i] = running;
    }
  }
  const cdelta = new Array<number>(rows).fill(0);
  let runningDelta = 0;
  for (let i = rows - 1; i >= 0; i--) {
    runningDelta += bins[i].delta;
    cdelta[i] = runningDelta;
  }

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  for (let c = 0; c < g.cols.length; c++) {
    const x = g.columnsX + c * g.colW;
    ctx.strokeStyle = 'rgba(96,165,250,0.12)';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, g.t);
    ctx.lineTo(x + 0.5, g.bottom);
    ctx.stroke();
    ctx.fillStyle = 'rgba(148,163,184,0.64)';
    ctx.fillText(COLUMN_LABEL[g.cols[c]], x + 4, 11);
  }
  ctx.strokeStyle = 'rgba(96,165,250,0.08)';
  for (let i = 0; i <= rows; i++) {
    const y = g.t + i * rowH;
    ctx.beginPath();
    ctx.moveTo(g.columnsX, y + 0.5);
    ctx.lineTo(g.w, y + 0.5);
    ctx.stroke();
  }
  for (let i = 0; i < rows; i++) {
    const b = bins[i];
    const y = g.t + (i + 0.5) * rowH;
    for (let c = 0; c < g.cols.length; c++) {
      const key = g.cols[c];
      let value = '-';
      let color = 'rgba(203,213,225,0.72)';
      if (key === 'book') {
        value = b.side === 'both' ? 'B/A' : b.side === 'bid' ? 'BID' : b.side === 'ask' ? 'ASK' : '-';
        color = b.side === 'bid' ? 'rgba(61,220,132,0.9)' : b.side === 'ask' ? 'rgba(248,113,113,0.9)' : color;
      } else if (key === 'size') {
        value = fmtUsd(b.bid + b.ask);
      } else if (key === 'cum') {
        value = fmtUsd(cum[i]);
      } else if (key === 'volume') {
        value = fmtUsd(b.volume);
      } else if (key === 'delta') {
        value = signedUsd(b.delta);
        color = b.delta > 0 ? 'rgba(61,220,132,0.9)' : b.delta < 0 ? 'rgba(248,113,113,0.9)' : color;
      } else if (key === 'cdelta') {
        value = signedUsd(cdelta[i]);
        color = cdelta[i] > 0 ? 'rgba(61,220,132,0.9)' : cdelta[i] < 0 ? 'rgba(248,113,113,0.9)' : color;
      } else if (key === 'tape') {
        value = b.lastSide ? `${b.lastSide === 'buy' ? '+' : '-'}${fmtUsd(b.lastUsd)}` : '-';
        color = b.lastSide === 'buy' ? 'rgba(61,220,132,0.9)' : b.lastSide === 'sell' ? 'rgba(248,113,113,0.9)' : color;
      }
      ctx.fillStyle = color;
      ctx.fillText(value, g.columnsX + c * g.colW + 4, y);
    }
  }
  ctx.restore();
}

interface Hover {
  mx: number;
  my: number;
  price: number;
  time: number;
  kind: 'bubble' | 'wall' | 'cell' | 'empty';
  bubble: BubblePoint | null;
  wall: SideWall | null;
  cell: CellHit | null;
}

interface ViewDrag {
  kind: 'time' | 'price';
  startX: number;
  startY: number;
  startEnd: number;
  startPriceScale: number;
}

export function LiquidityHeatmap({
  book,
  frames,
  trades,
  loading,
  error,
  tapeError,
  historyError,
  onSpanChange,
}: {
  book: TerminalBook | null;
  frames: BookFrame[];
  trades: TerminalTrade[];
  loading: boolean;
  error: string | null;
  tapeError: string | null;
  historyError?: string | null;
  onSpanChange?: (span: TerminalSpan) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const scaleRef = useRef({ key: '', value: 0, at: 0 });
  const [size, setSize] = useState({ w: 900, h: 430 });
  const [settings, setSettings] = useState<HeatmapSettings>(() => (
    loadSettings(typeof window === 'undefined' ? null : window.localStorage)
  ));
  const [zoom, setZoom] = useState(1);
  const [priceScale, setPriceScale] = useState(1);
  const [followLive, setFollowLive] = useState(true);
  const [lockedEnd, setLockedEnd] = useState<number | null>(null);
  const [drag, setDrag] = useState<ViewDrag | null>(null);
  const [axisHover, setAxisHover] = useState(false);
  const [menu, setMenu] = useState<'columns' | 'more' | 'help' | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        setSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
      }
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) setSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    saveSettings(settings, typeof window === 'undefined' ? null : window.localStorage);
  }, [settings]);

  useEffect(() => {
    onSpanChange?.(settings.span);
  }, [settings.span, onSpanChange]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const baseSpan = SPAN_MS[settings.span];
  const latest = frames[frames.length - 1] ?? null;
  const firstAt = frames[0]?.asOf ?? null;
  const effectiveSpan = baseSpan / zoom;
  const rawEnd = latest ? (followLive ? latest.asOf : lockedEnd ?? latest.asOf) : Date.now();
  const minEnd = latest
    ? Math.min(latest.asOf, (firstAt ?? latest.asOf) + effectiveSpan)
    : rawEnd;
  const end = latest ? clampNumber(rawEnd, minEnd, latest.asOf) : rawEnd;
  const start = end - effectiveSpan;
  const focusFrame = frameAt(frames, end) ?? latest;
  const focusMid = focusFrame?.mid ?? book?.mid ?? 0;
  const autoPct = autoRangePct(book, frames, start, end, focusMid);
  const baseRangePct = settings.range === 'auto' ? autoPct : RANGE_PCT[settings.range];
  const rangePct = clampNumber(baseRangePct / priceScale, 0.000005, 0.05);
  const geom = useMemo(
    () => buildGeom(frames, trades, start, end, rangePct, settings.columns, settings, size),
    [frames, trades, start, end, rangePct, settings, size],
  );
  const scaleCandidate = useMemo(
    () => geom
      ? liquidityScaleForFrame(
        geom.frame, geom.priceMin, geom.priceMax, geom.rows, settings.minLiquidityUsd,
      )
      : 1,
    [geom, settings.minLiquidityUsd],
  );

  useEffect(() => {
    if (!geom) return;
    const now = Date.now();
    const key = book?.symbol ?? 'unknown';
    const current = scaleRef.current;
    if (current.key !== key || current.value <= 0) {
      scaleRef.current = { key, value: scaleCandidate, at: now };
      setScale(scaleCandidate);
      return;
    }
    const next = nextLiquidityScale(current.value, scaleCandidate, now - current.at);
    if (next !== current.value) {
      scaleRef.current = { key, value: next, at: now };
      setScale(next);
    }
  }, [scaleCandidate, geom, book?.symbol]);

  const walls = useMemo(
    () => nearestWalls(frames, book?.wallNearPct ?? 0.005, book?.wallPeerLevels ?? 20),
    [frames, book?.wallNearPct, book?.wallPeerLevels],
  );
  const bubbles = useMemo(() => {
    if (!geom) return [];
    const bubbleRows = Math.max(6, Math.floor(geom.plotH / 28));
    return bubblePoints(
      trades,
      geom.start,
      geom.end,
      settings.bubbles,
      settings.stepMode,
      settings.minTradeUsd,
      geom.priceMin,
      geom.priceMax,
      bubbleRows,
    );
  }, [
    trades, geom, settings.bubbles, settings.stepMode, settings.minTradeUsd,
  ]);
  const bubbleReference = useMemo(
    () => Math.max(1, percentile(bubbles.map((point) => point.usd), 0.9)),
    [bubbles],
  );
  const bubbleHighlight = useMemo(
    () => bubbles.length >= 12 ? percentile(bubbles.map((point) => point.usd), 0.97) : Infinity,
    [bubbles],
  );

  const updateSettings = (patch: Partial<HeatmapSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  };

  const resetView = () => {
    setZoom(1);
    setPriceScale(1);
    setFollowLive(true);
    setLockedEnd(null);
    setHover(null);
  };

  const selectSpan = (span: HeatmapSettings['span']) => {
    updateSettings({ span });
    setZoom(1);
    setPriceScale(1);
    setFollowLive(true);
    setLockedEnd(null);
    setHover(null);
  };

  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
    resetView();
  };

  const moveColumn = (key: ColumnKey, direction: -1 | 1) => {
    setSettings((current) => {
      const index = current.columns.indexOf(key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.columns.length) return current;
      const next = current.columns.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return { ...current, columns: next };
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = size.w;
    const h = size.h;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = DARK;
    ctx.fillRect(0, 0, w, h);

    if (!geom) {
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(loading ? 'waiting for the first book snapshot...' : 'no order-book samples', w / 2, h / 2);
      return;
    }

    const g = geom;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const digits = axisDigits(g.priceMax - g.priceMin);
    const ticks = 6;
    for (let i = 0; i <= ticks; i++) {
      const price = g.priceMin + ((g.priceMax - g.priceMin) * i) / ticks;
      const py = Math.round(g.y(price)) + 0.5;
      ctx.strokeStyle = 'rgba(96,165,250,0.10)';
      ctx.beginPath();
      ctx.moveTo(g.ml, py);
      ctx.lineTo(g.right, py);
      ctx.stroke();
      ctx.fillStyle = 'rgba(186,230,253,0.62)';
      ctx.textAlign = 'left';
      ctx.fillText(
        price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }),
        g.right + 8, py,
      );
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const timeTicks = w < 560 ? 3 : 4;
    for (let i = 0; i <= timeTicks; i++) {
      const time = g.start + (g.spanMs * i) / timeTicks;
      const label = timeLabel(time, g.spanMs);
      const half = ctx.measureText(label).width / 2 + 3;
      const tx = clamp(g.x(time), g.ml + half, g.right - half);
      ctx.strokeStyle = 'rgba(96,165,250,0.08)';
      ctx.beginPath();
      ctx.moveTo(Math.round(g.x(time)) + 0.5, g.t);
      ctx.lineTo(Math.round(g.x(time)) + 0.5, g.volH ? g.volBase : g.bottom);
      ctx.stroke();
      ctx.fillStyle = 'rgba(186,230,253,0.52)';
      ctx.fillText(label, tx, h - 7);
    }

    const gain = CONTRAST_GAIN[settings.contrast];
    const colorScale = scale > 0 ? scale : scaleCandidate;
    ctx.save();
    ctx.beginPath();
    ctx.rect(g.ml, g.t, g.plotW, g.plotH);
    ctx.clip();

    for (let i = 0; i < g.shown.length; i++) {
      const frame = g.shown[i];
      const x0 = g.x(frame.asOf);
      const x1 = i + 1 < g.shown.length ? g.x(g.shown[i + 1].asOf) : g.right;
      const width = Math.max(1, x1 - x0);
      if (x0 < g.ml - 1 || x0 > g.right + 1) continue;
      const { bid: rowBid, ask: rowAsk } = frameRowTotals(
        frame, g.priceMin, g.priceMax, g.rows, settings.minLiquidityUsd,
      );
      for (let row = 0; row < g.rows; row++) {
        const usd = Math.max(rowBid[row], rowAsk[row]);
        if (usd <= 0) continue;
        const intensity = heatIntensity(usd, colorScale, gain);
        if (intensity < 0.02) continue;
        ctx.fillStyle = heatColor(intensity, settings.opacity);
        ctx.fillRect(x0, g.t + row * g.rowH, width, g.rowH + 0.35);
      }
    }

    ctx.strokeStyle = 'rgba(96,165,250,0.055)';
    ctx.beginPath();
    let lastX = -10;
    for (const frame of g.shown) {
      const px = Math.round(g.x(frame.asOf)) + 0.5;
      if (px - lastX < 6) continue;
      lastX = px;
      ctx.moveTo(px, g.t);
      ctx.lineTo(px, g.bottom);
    }
    ctx.stroke();

    if (g.shown.length) {
      ctx.strokeStyle = 'rgba(241,245,249,0.8)';
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      let previousY = g.y(g.shown[0].mid);
      ctx.moveTo(g.x(g.shown[0].asOf), previousY);
      for (let i = 1; i < g.shown.length; i++) {
        const px = g.x(g.shown[i].asOf);
        const py = g.y(g.shown[i].mid);
        ctx.lineTo(px, previousY);
        ctx.lineTo(px, py);
        previousY = py;
      }
      ctx.stroke();
    }

    const bestBidY = g.y(g.frame.bestBid);
    const bestAskY = g.y(g.frame.bestAsk);
    if (bestBidY >= g.t && bestBidY <= g.bottom) {
      ctx.strokeStyle = 'rgba(61,220,132,0.34)';
      ctx.beginPath();
      ctx.moveTo(g.ml, bestBidY + 0.5);
      ctx.lineTo(g.right, bestBidY + 0.5);
      ctx.stroke();
    }
    if (bestAskY >= g.t && bestAskY <= g.bottom) {
      ctx.strokeStyle = 'rgba(248,113,113,0.34)';
      ctx.beginPath();
      ctx.moveTo(g.ml, bestAskY + 0.5);
      ctx.lineTo(g.right, bestAskY + 0.5);
      ctx.stroke();
    }

    if (settings.bubbles !== 'off') {
      for (const point of bubbles) {
        const radius = bubbleRadius(point.usd, bubbleReference, settings.bubbleScale);
        const px = g.x(point.t);
        const py = g.y(point.price);
        if (px < g.ml - 12 || px > g.right + 12 || py < g.t - 12 || py > g.bottom + 12) continue;
        const exceptional = point.usd >= bubbleHighlight;
        ctx.beginPath();
        ctx.fillStyle = exceptional
          ? 'rgba(250,204,21,0.36)'
          : point.side === 'buy' ? 'rgba(61,220,132,0.62)' : 'rgba(248,113,113,0.62)';
        ctx.strokeStyle = exceptional
          ? 'rgba(250,204,21,0.98)'
          : point.side === 'buy' ? 'rgba(61,220,132,0.95)' : 'rgba(248,113,113,0.95)';
        ctx.lineWidth = exceptional ? 1.5 : 0.8;
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();

    if (g.volH > 0) {
      const buckets = volumeBuckets(g.visibleTrades, g.start, g.end, Math.max(24, Math.min(120, Math.floor(g.plotW / 6))));
      const maxVolume = Math.max(1, ...buckets.map((b) => b.total));
      const bucketW = g.plotW / buckets.length;
      const volHeight = Math.max(4, g.volBase - g.volTop);
      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        if (bucket.total <= 0) continue;
        const height = Math.max(1, (bucket.total / maxVolume) * volHeight);
        const x = g.ml + i * bucketW;
        const sellH = bucket.total > 0 ? height * (bucket.sell / bucket.total) : 0;
        const buyH = height - sellH;
        ctx.fillStyle = 'rgba(248,113,113,0.38)';
        ctx.fillRect(x, g.volBase - sellH, Math.max(1, bucketW - 0.6), sellH);
        ctx.fillStyle = 'rgba(61,220,132,0.38)';
        ctx.fillRect(x, g.volBase - height, Math.max(1, bucketW - 0.6), buyH);
      }
      ctx.strokeStyle = 'rgba(96,165,250,0.12)';
      ctx.beginPath();
      ctx.moveTo(g.ml, g.volBase + 0.5);
      ctx.lineTo(g.right, g.volBase + 0.5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(148,163,184,0.5)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText('VOL', g.ml + 4, g.volTop + 7);
    }

    const midY = clamp(g.y(g.mid), g.t + 8, g.bottom - 8);
    ctx.fillStyle = 'rgba(241,245,249,0.94)';
    ctx.fillRect(g.right + 2, midY - 8, g.priceAxisW - 6, 16);
    ctx.fillStyle = DARK;
    ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtLevelPrice(g.mid), g.right + 7, midY + 0.5);

    drawColumns(ctx, g, g.visibleTrades);

    ctx.strokeStyle = 'rgba(96,165,250,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(g.ml + 0.5, g.t + 0.5, g.plotW, g.plotH);
  }, [
    geom, size, loading, settings.contrast, settings.opacity, settings.minLiquidityUsd,
    settings.bubbles, settings.bubbleScale, settings.showVolume, bubbles, bubbleReference,
    bubbleHighlight, scale, scaleCandidate,
  ]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(size.w * dpr));
    canvas.height = Math.max(1, Math.round(size.h * dpr));
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (!geom || !hover) return;
    const g = geom;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(226,232,240,0.52)';
    ctx.beginPath();
    ctx.moveTo(g.ml, hover.my + 0.5);
    ctx.lineTo(g.w, hover.my + 0.5);
    ctx.moveTo(hover.mx + 0.5, g.t);
    ctx.lineTo(hover.mx + 0.5, g.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    if (hover.kind === 'bubble' && hover.bubble) {
      const radius = bubbleRadius(hover.bubble.usd, bubbleReference, settings.bubbleScale);
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(250,204,21,0.98)';
      ctx.lineWidth = 1.8;
      ctx.arc(g.x(hover.bubble.t), g.y(hover.bubble.price), radius + 3, 0, Math.PI * 2);
      ctx.stroke();
    } else if (hover.kind === 'wall' && hover.wall) {
      const wy = g.y(hover.wall.price);
      ctx.fillStyle = hover.wall.side === 'bid' ? 'rgba(61,220,132,0.16)' : 'rgba(248,113,113,0.16)';
      ctx.fillRect(g.ml, wy - 3, g.plotW, 6);
      ctx.strokeStyle = hover.wall.side === 'bid' ? 'rgba(61,220,132,0.85)' : 'rgba(248,113,113,0.85)';
      ctx.beginPath();
      ctx.moveTo(g.ml, wy + 0.5);
      ctx.lineTo(g.right, wy + 0.5);
      ctx.stroke();
    } else if (hover.cell) {
      const index = frameIndexAt(frames, hover.time);
      const next = index >= 0 ? frames[index + 1] : undefined;
      const cellX0 = clamp(g.x(hover.cell.frame.asOf), g.ml, g.right);
      const cellX1 = clamp(next ? g.x(next.asOf) : g.right, cellX0 + 1, g.right);
      const cellW = Math.max(1, cellX1 - cellX0);
      const cellY = g.t + hover.cell.row * g.rowH;
      ctx.fillStyle = hover.cell.levels.length
        ? 'rgba(226,232,240,0.08)'
        : 'rgba(148,163,184,0.045)';
      ctx.fillRect(cellX0, cellY, cellW, g.rowH);
      ctx.strokeStyle = 'rgba(226,232,240,0.3)';
      ctx.strokeRect(cellX0 + 0.5, cellY + 0.5, Math.max(1, cellW - 1), Math.max(1, g.rowH - 1));
    }

    const price = fmtLevelPrice(hover.price);
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const priceW = g.priceAxisW - 4;
    ctx.fillStyle = 'rgba(226,232,240,0.96)';
    ctx.fillRect(g.right + 2, hover.my - 7, priceW, 14);
    ctx.fillStyle = DARK;
    ctx.fillText(price, g.right + 5, hover.my + 0.5);
    const time = timeLabel(hover.time, g.spanMs);
    const timeW = ctx.measureText(time).width + 8;
    const timeY = g.timeY - 4;
    ctx.fillStyle = 'rgba(226,232,240,0.96)';
    ctx.fillRect(clamp(hover.mx - timeW / 2, g.ml, g.right - timeW), timeY - 6, timeW, 14);
    ctx.fillStyle = DARK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(time, clamp(hover.mx, g.ml + timeW / 2, g.right - timeW / 2), timeY + 1);
  }, [geom, hover, size, frames, bubbleReference, settings.bubbleScale]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || !geom) return;
    const onWheel = (event: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      if (mx < geom.ml || mx > geom.right) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.16 : 1 / 1.16;
      const nextZoom = clampNumber(zoom * factor, ZOOM_MIN, ZOOM_MAX);
      if (Math.abs(nextZoom - zoom) < 1e-6) return;
      if (!followLive) {
        const anchor = xToTime(mx, geom.start, geom.end, geom.ml, geom.plotW);
        const nextSpan = baseSpan / nextZoom;
        const fraction = clampNumber((mx - geom.ml) / geom.plotW, 0, 1);
        const nextEnd = anchor + (1 - fraction) * nextSpan;
        setLockedEnd(clampNumber(nextEnd, minEnd, latest?.asOf ?? nextEnd));
      }
      setZoom(nextZoom);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [geom, zoom, followLive, baseSpan, minEnd, latest?.asOf]);

  const pointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { mx: event.clientX - rect.left, my: event.clientY - rect.top };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!geom || event.button !== 0) return;
    const { mx, my } = pointer(event);
    if (my < geom.t || my > geom.bottom) return;
    if (mx > geom.right && mx <= geom.right + geom.priceAxisW) {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({
        kind: 'price', startX: mx, startY: my, startEnd: geom.end, startPriceScale: priceScale,
      });
      setHover(null);
      return;
    }
    if (mx < geom.ml || mx > geom.right) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      kind: 'time', startX: mx, startY: my, startEnd: geom.end, startPriceScale: priceScale,
    });
    setHover(null);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!geom) return;
    const { mx, my } = pointer(event);
    if (drag) {
      if (drag.kind === 'time') {
        const dx = mx - drag.startX;
        if (Math.abs(dx) < 1) return;
        const nextEnd = drag.startEnd - (dx / geom.plotW) * geom.spanMs;
        setFollowLive(false);
        setLockedEnd(clampNumber(nextEnd, minEnd, latest?.asOf ?? nextEnd));
      } else {
        const dy = my - drag.startY;
        setPriceScale(clampNumber(drag.startPriceScale * (1 - dy / Math.max(80, geom.plotH)), 0.2, 10));
      }
      return;
    }
    if (mx > geom.right && mx <= geom.right + geom.priceAxisW && my >= geom.t && my <= geom.bottom) {
      setAxisHover(true);
      setHover(null);
      return;
    }
    setAxisHover(false);
    if (mx < geom.ml || mx > geom.right || my < geom.t || my > geom.bottom) {
      setHover(null);
      return;
    }
    const price = yToPrice(my, geom.priceMin, geom.priceMax, geom.t, geom.plotH);
    const time = xToTime(mx, geom.start, geom.end, geom.ml, geom.plotW);

    let bubble: BubblePoint | null = null;
    let bubbleDistance = Infinity;
    for (const point of bubbles) {
      const dx = geom.x(point.t) - mx;
      const dy = geom.y(point.price) - my;
      const distance = Math.hypot(dx, dy);
      const radius = bubbleRadius(point.usd, bubbleReference, settings.bubbleScale) + 6;
      if (distance <= Math.max(radius, 8) && distance < bubbleDistance) {
        bubbleDistance = distance;
        bubble = point;
      }
    }

    const tolerance = Math.max((geom.priceMax - geom.priceMin) / geom.rows * 2.5, geom.mid * 1e-7);
    const wall = wallAt(walls, price, tolerance);
    const row = clampNumber(Math.floor((my - geom.t) / geom.rowH), 0, geom.rows - 1);
    const cell = cellAt(frames, time, row, geom.priceMin, geom.priceMax, geom.rows);

    setHover({
      mx, my, price, time,
      kind: bubble ? 'bubble' : wall ? 'wall' : cell ? 'cell' : 'empty',
      bubble,
      wall,
      cell,
    });
  };

  const finishDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDrag(null);
  };

  const lastAt = latest?.asOf ?? null;
  const coverage = firstAt !== null && lastAt !== null && effectiveSpan > 0
    ? (lastAt - firstAt) / effectiveSpan
    : 0;
  const rangeLabel = `${PM}${(rangePct * 100).toFixed(3)}%`;
  const stepMs = stepMsFor(effectiveSpan, settings.stepMode);
  const wallText = useMemo(() => {
    if (loading && !book) return 'Waiting for the first book snapshot.';
    if (!book && frames.length) {
      return 'Current book unavailable; captured history is shown without a live wall read.';
    }
    if (!book) return error ? `Book unavailable: ${error}` : 'No order-book samples yet.';
    const parts = (['bid', 'ask'] as const)
      .map((side) => walls[side])
      .filter((w): w is SideWall => Boolean(w))
      .map((w) => {
        const dir = w.side === 'bid' ? 'below' : 'above';
        const bps = w.distanceBps < 10 ? w.distanceBps.toFixed(1) : w.distanceBps.toFixed(0);
        const standing = w.standingMs <= 0
          ? 'just sampled'
          : w.standingSinceStart
            ? `standing >=${durations(w.standingMs)} (since capture)`
            : `standing ${durations(w.standingMs)}`;
        return `${w.side} wall ${fmtUsd(w.usd)} at ${fmtLevelPrice(w.price)} (${bps} bp ${dir}), ${standing}`;
      });
    if (!parts.length) return 'Nearest walls: no near-touch level was returned for either side.';
    return `Nearest walls: ${parts.join(` ${DOT} `)}.`;
  }, [book, error, frames.length, loading, walls]);

  const cellLevels = hover?.cell?.levels ?? [];
  const cellHasBins = Boolean(hover?.cell && !cellLevels.length
    && (hover.cell.bidUsd > 0 || hover.cell.askUsd > 0));
  const tipW = Math.min(250, Math.max(170, size.w - 16));
  const tipH = 76 + (hover?.bubble ? 38 : 0) + (hover?.wall ? 66 : 0)
    + (cellHasBins ? 62 : Math.min(3, cellLevels.length) * 22);
  const tip = hover
    ? tooltipPosition(hover.mx, hover.my, tipW, tipH, size.w, size.h)
    : { left: 0, top: 0 };
  const cursor = drag?.kind === 'price' || axisHover
    ? 'ns-resize'
    : drag?.kind === 'time'
      ? 'grabbing'
      : 'crosshair';

  return (
    <div className="terminal-heat">
      <div ref={toolbarRef} className="terminal-heat-toolbar">
        <div className="terminal-control">
          <span>Span</span>
          <div className="terminal-seg terminal-span-seg" role="group" aria-label="Heatmap span">
            {TERMINAL_SPANS.map((s) => (
              <button
                key={s}
                type="button"
                className={settings.span === s ? 'is-on' : ''}
                onClick={() => selectSpan(s)}
              >
                {spanText(s)}
              </button>
            ))}
          </div>
        </div>
        <div className="terminal-control">
          <span>Price range</span>
          <div className="terminal-seg" role="group" aria-label="Price range">
            {RANGE_KEYS.map((r) => (
              <button
                key={r}
                type="button"
                className={settings.range === r ? 'is-on' : ''}
                onClick={() => updateSettings({ range: r })}
              >
                {r === 'auto' ? 'Auto' : `${PM}${r}%`}
              </button>
            ))}
          </div>
        </div>
        <div className="terminal-control">
          <span>Contrast</span>
          <div className="terminal-seg" role="group" aria-label="Heatmap contrast">
            {CONTRAST_KEYS.map((c) => (
              <button
                key={c}
                type="button"
                className={settings.contrast === c ? 'is-on' : ''}
                onClick={() => updateSettings({ contrast: c })}
              >
                {c === 'med' ? 'Med' : c[0].toUpperCase() + c.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="terminal-control">
          <span>Bubbles</span>
          <div className="terminal-seg" role="group" aria-label="Trade bubbles">
            {BUBBLE_KEYS.map((b) => (
              <button
                key={b}
                type="button"
                className={settings.bubbles === b ? 'is-on' : ''}
                onClick={() => updateSettings({ bubbles: b })}
              >
                {b === 'auto' ? 'Auto' : b[0].toUpperCase() + b.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="terminal-menu-wrap">
          <button
            type="button"
            className={`terminal-toggle${menu === 'columns' ? ' is-on' : ''}`}
            onClick={() => setMenu((m) => m === 'columns' ? null : 'columns')}
            aria-expanded={menu === 'columns'}
            aria-haspopup="menu"
          >
            Columns ({settings.columns.length})
          </button>
          {menu === 'columns' && (
            <div className="terminal-popover terminal-columns-menu" role="menu" aria-label="Choose and order heatmap columns">
              <div className="terminal-popover-title">Right-hand columns</div>
              {COLUMN_KEYS.map((key) => {
                const index = settings.columns.indexOf(key);
                return (
                  <div key={key} className={`terminal-column-row${index >= 0 ? ' is-on' : ''}`}>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={index >= 0}
                      onClick={() => updateSettings({
                        columns: index >= 0
                          ? settings.columns.filter((c) => c !== key)
                          : [...settings.columns, key],
                      })}
                    >
                      <span className="terminal-check">{index >= 0 ? 'x' : ''}</span>
                      {COLUMN_LABEL[key]}
                    </button>
                    <button
                      type="button"
                      className="terminal-column-move"
                      aria-label={`Move ${COLUMN_LABEL[key]} left`}
                      disabled={index <= 0}
                      onClick={() => moveColumn(key, -1)}
                    >
                      &lt;
                    </button>
                    <button
                      type="button"
                      className="terminal-column-move"
                      aria-label={`Move ${COLUMN_LABEL[key]} right`}
                      disabled={index < 0 || index >= settings.columns.length - 1}
                      onClick={() => moveColumn(key, 1)}
                    >
                      &gt;
                    </button>
                  </div>
                );
              })}
              {size.w < 760 && <div className="terminal-popover-hint">Columns need a wider screen.</div>}
            </div>
          )}
        </div>
        <div className="terminal-menu-wrap">
          <button
            type="button"
            className={`terminal-toggle${menu === 'more' ? ' is-on' : ''}`}
            onClick={() => setMenu((m) => m === 'more' ? null : 'more')}
            aria-expanded={menu === 'more'}
          >
            More
          </button>
          {menu === 'more' && (
            <div className="terminal-popover terminal-more" role="note">
              <div className="terminal-popover-title">Heatmap settings</div>
              <div className="terminal-more-grid">
                <label>
                  <span>Row resolution <b>{settings.rowPx}px</b></span>
                  <input
                    type="range" min="1" max="6" step="1" value={settings.rowPx}
                    onChange={(e) => updateSettings({ rowPx: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>Opacity <b>{Math.round(settings.opacity * 100)}%</b></span>
                  <input
                    type="range" min="0.3" max="1" step="0.05" value={settings.opacity}
                    onChange={(e) => updateSettings({ opacity: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>Bubble scale <b>{settings.bubbleScale.toFixed(1)}x</b></span>
                  <input
                    type="range" min="0.5" max="2" step="0.1" value={settings.bubbleScale}
                    onChange={(e) => updateSettings({ bubbleScale: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>Min liquidity <b>{fmtUsd(settings.minLiquidityUsd)}</b></span>
                  <input
                    type="range" min="0" max="250000" step="5000" value={settings.minLiquidityUsd}
                    onChange={(e) => updateSettings({ minLiquidityUsd: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>Min trade <b>{fmtUsd(settings.minTradeUsd)}</b></span>
                  <input
                    type="range" min="0" max="250000" step="1000" value={settings.minTradeUsd}
                    onChange={(e) => updateSettings({ minTradeUsd: Number(e.target.value) })}
                  />
                </label>
                <label className="terminal-more-select">
                  <span>Step aggregation</span>
                  <select
                    value={settings.stepMode}
                    onChange={(e) => updateSettings({ stepMode: e.target.value as HeatmapSettings['stepMode'] })}
                  >
                    {STEP_KEYS.map((key) => <option key={key} value={key}>{key === 'auto' ? 'Auto' : key}</option>)}
                  </select>
                </label>
                <label className="terminal-more-check">
                  <input
                    type="checkbox"
                    checked={settings.showVolume}
                    onChange={(e) => updateSettings({ showVolume: e.target.checked })}
                  />
                  <span>Volume histogram</span>
                </label>
              </div>
              <button type="button" className="terminal-reset-settings" onClick={resetSettings}>
                Reset chart settings
              </button>
              <p>
                Binance returns at most {book?.bids.length ?? 1_000} levels per side and no historical spot
                book. This server records the live book from first observation, so wider spans show only the
                recorded window; earlier depth is left empty rather than reconstructed.
              </p>
              <p>
                Live tooltips read the exact sample under the pointer. Compact recorded samples retain the
                summed notional per price bin, which is why older cells show bins instead of individual
                levels. Step aggregation is {stepMs >= 1_000 ? `${Math.round(stepMs / 1_000)}s` : '<1s'} at
                this view. Wall standing time is a lower bound from captured samples.
              </p>
              {tapeError && <p className="is-warn">The tape is currently unavailable ({tapeError}); depth is still live.</p>}
            </div>
          )}
        </div>
        <div className="terminal-menu-wrap">
          <button
            type="button"
            className={`terminal-help${menu === 'help' ? ' is-on' : ''}`}
            onClick={() => setMenu((m) => m === 'help' ? null : 'help')}
            aria-expanded={menu === 'help'}
            aria-label="Heatmap help"
          >
            ?
          </button>
          {menu === 'help' && (
            <div className="terminal-popover terminal-help-panel" role="note">
              <div className="terminal-popover-title">Reading the heatmap</div>
              <p>
                Blue to cyan to yellow means more resting notional. The white step line is mid; the green
                and red dotted lines are best bid and ask. Green/red bubbles are aggressive buys/sells.
              </p>
              <p>
                Hover a cell for its captured timestamp and exact price levels. Bubbles and walls take hover
                priority. Drag to pan, wheel to zoom time, drag the price axis to change price scale, double-click
                to reset, or use Live to return to the newest sample.
              </p>
            </div>
          )}
        </div>
        <div className="terminal-view-actions">
          <span className={`terminal-view-state${followLive ? ' is-live' : ''}`}>
            {followLive ? 'LIVE' : 'HIST'}
            {zoom !== 1 && <em>{zoom.toFixed(1)}x</em>}
          </span>
          <button type="button" className="terminal-view-btn" onClick={resetView}>Reset</button>
          <button
            type="button"
            className="terminal-view-btn"
            disabled={followLive}
            onClick={() => { setFollowLive(true); setLockedEnd(null); }}
          >
            Live
          </button>
        </div>
      </div>

      <div ref={wrapRef} className="terminal-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="terminal-canvas"
          style={{ cursor }}
          role="img"
          tabIndex={0}
          aria-label={`Market liquidity heatmap and trade flow for ${book?.symbol ?? 'the selected market'}, ${spanText(settings.span)} span. Drag to pan, wheel to zoom, drag the price axis to scale.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onPointerLeave={() => { setHover(null); setAxisHover(false); }}
          onDoubleClick={resetView}
        />
        <canvas ref={overlayRef} className="terminal-canvas-overlay" aria-hidden="true" />
        {hover && (
          <div className="terminal-heat-tip" style={{ left: tip.left, top: tip.top, width: tipW }}>
            <div className="terminal-heat-tip-head">
              <b>{fmtLevelPrice(hover.price)}</b>
              <span>{timeLabel(hover.time, effectiveSpan)} IST</span>
            </div>
            {hover.kind === 'bubble' && hover.bubble && (
              <>
                <div className="terminal-heat-tip-kicker">
                  {hover.bubble.aggregated
                    ? `${hover.bubble.bucketMs ? 'CAPTURED BUCKET' : 'STEP'} ${hover.bubble.count} TRADES`
                    : 'TRADE'}
                </div>
                <div className={`terminal-heat-tip-row is-${hover.bubble.side}`}>
                  {hover.bubble.side === 'buy' ? 'Aggressive buy' : 'Aggressive sell'}{' '}
                  <b>{fmtUsd(hover.bubble.usd)}</b> {fmtQty(hover.bubble.qty)} @ {fmtLevelPrice(hover.bubble.price)}
                </div>
                <div className="terminal-heat-tip-row is-muted">
                  {hover.bubble.aggregated
                    ? `${timeLabel(hover.bubble.firstT, effectiveSpan)}-${timeLabel(hover.bubble.lastT, effectiveSpan)}`
                    : timeLabel(hover.bubble.t, effectiveSpan)} IST
                  {hover.bubble.aggregated ? ` ${DOT} VWAP of bucket` : ''}
                </div>
              </>
            )}
            {hover.kind === 'wall' && hover.wall && (
              <>
                <div className="terminal-heat-tip-kicker">{hover.wall.side.toUpperCase()} WALL</div>
                <div className={`terminal-heat-tip-row is-${hover.wall.side}`}>
                  <b>{fmtUsd(hover.wall.usd)}</b> at {fmtLevelPrice(hover.wall.price)}
                </div>
                <div className="terminal-heat-tip-row is-muted">
                  {hover.wall.distanceBps.toFixed(1)} bp from mid {DOT} {hover.wall.multiple.toFixed(1)}x peer median
                </div>
                <div className="terminal-heat-tip-row is-muted">
                  Standing {durations(hover.wall.standingMs)}{hover.wall.standingSinceStart ? ' (since capture)' : ''}
                  {hover.wall.pulls > 0 ? ` ${DOT} ${hover.wall.pulls} pull${hover.wall.pulls === 1 ? '' : 's'}` : ''}
                </div>
              </>
            )}
            {hover.kind === 'cell' && hover.cell && (
              <>
                <div className="terminal-heat-tip-kicker">
                  {hover.cell.frame.source === 'history' ? 'CAPTURED SAMPLE' : 'BOOK SAMPLE'} {DOT}{' '}
                  {Math.max(0, Math.round(((latest?.asOf ?? hover.cell.frame.asOf) - hover.cell.frame.asOf) / 1_000))}s OLD
                </div>
                {cellLevels.length === 0 && !cellHasBins && (
                  <div className="terminal-heat-tip-row is-muted">No recorded liquidity in this cell.</div>
                )}
                {cellHasBins && (
                  <>
                    {hover.cell.bidUsd > 0 && (
                      <div className="terminal-heat-tip-row is-bid">
                        Bid <b>{fmtUsd(hover.cell.bidUsd)}</b> across {hover.cell.bidBins} recorded bin{ hover.cell.bidBins === 1 ? '' : 's'}
                      </div>
                    )}
                    {hover.cell.askUsd > 0 && (
                      <div className="terminal-heat-tip-row is-ask">
                        Ask <b>{fmtUsd(hover.cell.askUsd)}</b> across {hover.cell.askBins} recorded bin{ hover.cell.askBins === 1 ? '' : 's'}
                      </div>
                    )}
                    <div className="terminal-heat-tip-row is-muted">
                      Compact capture: individual levels are summed, not reconstructed.
                    </div>
                  </>
                )}
                {cellLevels.slice(0, 3).map((entry) => (
                  <div key={`${entry.side}-${entry.level.price}`} className={`terminal-heat-tip-row is-${entry.side}`}>
                    {entry.side === 'bid' ? 'Bid' : 'Ask'} <b>{fmtUsd(entry.level.usd)}</b>{' '}
                    {entry.level.qty !== undefined ? fmtQty(entry.level.qty) : `~${fmtQty(entry.level.usd / entry.level.price)}`}{' '}
                    @ {fmtLevelPrice(entry.level.price)}
                  </div>
                ))}
                {cellLevels.length > 3 && (
                  <div className="terminal-heat-tip-row is-muted">+{cellLevels.length - 3} more levels in this row</div>
                )}
                <div className="terminal-heat-tip-row is-muted">
                  Source sample {timeLabel(hover.cell.frame.asOf, effectiveSpan)} IST
                </div>
              </>
            )}
            {hover.kind === 'empty' && (
              <div className="terminal-heat-tip-row is-muted">
                {firstAt !== null && hover.time < firstAt
                  ? 'Before captured book history.'
                  : 'No recorded book sample at this time.'}
              </div>
            )}
          </div>
        )}
        {!book && loading && (
          <div className="terminal-canvas-empty">waiting for the first book snapshot...</div>
        )}
        {!book && !loading && error && frames.length === 0 && (
          <div className="terminal-canvas-empty is-error">{error}</div>
        )}
        {coverage < 0.9 && (
          <div className="terminal-canvas-hint">
            Captured depth covers {Math.min(100, Math.round(coverage * 100))}% of this span.
            Earlier book history was not recorded and is not invented.
          </div>
        )}
      </div>

      <div className="chart-reading">
        <span className="terminal-wall-tag">WALL READ</span>
        <span>{wallText}</span>
      </div>

      <div className="terminal-heat-footer">
        <span>
          Bid depth <b>{book ? fmtUsd(book.bidUsd) : '-'}</b>
          <i className="terminal-depthbar">
            <em style={{ width: `${book ? clamp((book.bidUsd / Math.max(1, book.bidUsd + book.askUsd)) * 100, 0, 100) : 0}%` }} />
          </i>
          Ask depth <b>{book ? fmtUsd(book.askUsd) : '-'}</b>
        </span>
        <span>
          Imbalance <b>{book ? `${(book.imbalance * 100).toFixed(1)}%` : '-'}</b>
        </span>
        <span>
          Book history <b>{frames.length}</b> {frames.length === 1 ? 'sample' : 'samples'}
          {firstAt && lastAt ? ` ${DOT} ${timeLabel(firstAt, effectiveSpan)}-${timeLabel(lastAt, effectiveSpan)}` : ''}
        </span>
        <span>
          View <b>{followLive ? 'live' : 'historical'}</b> {DOT} {spanText(settings.span)} {DOT} {zoom.toFixed(2)}x
          {' '}{DOT} range <b>{rangeLabel}</b>
        </span>
        {error && <span className="is-error">refresh failed - showing last good sample</span>}
        {historyError && <span className="is-warn">history refresh failed - older captured samples may be missing</span>}
        {!error && tapeError && <span className="is-warn">trade tape unavailable - depth is still live</span>}
      </div>
    </div>
  );
}
