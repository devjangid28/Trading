import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssetRow, Candle, TerminalInterval, TerminalTrade } from '../../shared/types';
import type { MarketMode } from '../components/ui';
import { api, usePolling } from '../lib/api';
import { createWhaleFeed, type WhaleFeedController } from './feed';
import {
  bubbleNet, buildBubbles, candleStatsFor, countWhalePrints, ema, estimateLiquidationLevels,
  INTERVAL_MS, visiblePoc, whaleAverages,
} from './engine';
import { bubbleAtPoint, drawWhales, type DrawState } from './draw';
import { computeLayout, priceForY, timeForX } from './layout';
import type { WhaleBubble, WhaleLevel, WhaleSettings, WhaleView } from './types';
import type { WhaleBubbleMode, WhaleSizeBy, WhalePlaceAt, WhaleAggressor } from './types';
import {
  DEFAULT_CANDLES, RIGHT_PAD_PX, USER_LEVELS_KEY, WHALES_SETTINGS_KEY, WHALES_TOKENS as T,
  WHALE_AUTO_SIZE_CAP, WHALE_CLUSTER_WINDOW_DEFAULT,
} from './tokens';
import { clampNumber, dateTimeLabel, fmtBtc, fmtPrice, fmtPct, fmtSignedUsd, fmtUsd, prettyTime } from './format';
import { clusterBubbles, netForView, planOverlays, tooltipPlacement, type PlanViewport } from './plan';
import { buildPlanContext, type GexSnapshot } from '../terminal/levels';
import './whales.css';

const DASH = '\u2014';
const STEP_KEYS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;

interface WhalesViewProps {
  symbol: string;
  onSymbol: (symbol: string) => void;
  mode: MarketMode;
  rows: AssetRow[];
}

interface InsightData {
  since: string | null;
  pricePct: number | null;
  net: number;
  bubbles: number;
  buy: number;
  sell: number;
  sentence: string;
  agree: string | null;
  agrees: boolean | null;
  lean: 'BUY LEAN' | 'SELL LEAN' | 'WAIT';
  statsKnown: boolean;
}

function loadSettings(): WhaleSettings {
  const fallback: WhaleSettings = {
    showBubbles: true,
    showAvg: true,
    showZones: false,
    showVolProfile: true,
    showLiq: true,
    showLevels: true,
    showMa: true,
    showBubbleNet: true,
    showPlan: true,
    showGamma: false,
    showRef: true,
    showInsight: true,
    showVolume: true,
    mode: 'sweep',
    aggressor: 'combined',
    sizeBy: 'total',
    labelPos: 'above',
    placeAt: 'vwap',
    threshold: 'auto',
    clusterWindowMs: WHALE_CLUSTER_WINDOW_DEFAULT * 1_000,
    sideFilter: 'both',
    linkedTf: true,
  };
  try {
    const raw = window.localStorage.getItem(WHALES_SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<WhaleSettings> & { showBand?: boolean; showHistogram?: boolean };
    const migrated: Partial<WhaleSettings> = { ...parsed };
    if (typeof parsed.showBand === 'boolean') migrated.showAvg = parsed.showBand;
    if (typeof parsed.showHistogram === 'boolean') migrated.showVolProfile = parsed.showHistogram;
    return { ...fallback, ...migrated };
  } catch {
    return fallback;
  }
}

function saveSettings(settings: WhaleSettings): void {
  try {
    window.localStorage.setItem(WHALES_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage optional */
  }
}

function loadUserLevels(): number[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(USER_LEVELS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0)
      .slice(0, 24);
  } catch {
    return [];
  }
}

function saveUserLevels(levels: number[]): void {
  try {
    window.localStorage.setItem(USER_LEVELS_KEY, JSON.stringify(levels));
  } catch {
    /* storage optional */
  }
}

function leanFor(net: number, total: number): InsightData['lean'] {
  if (total <= 0) return 'WAIT';
  if (Math.abs(net) / total < 0.05) return 'WAIT';
  return net > 0 ? 'BUY LEAN' : 'SELL LEAN';
}

/**
 * The reading line, exactly as the shipped Tradfye bundle renders it:
 * sign of the move (|pct| < 0.05 -> flat), sign of whale net (only when
 * |net|/total >= 0.2 and >= 3 bubbles), the sentence table, and agreement
 * with the panel/dock lean ("agrees" vs "against", amber when against).
 */
function buildInsight(
  sinceTs: number | null,
  pricePct: number | null,
  net: number,
  total: number,
  bubbles: number,
  lean: InsightData['lean'],
  buy = 0,
  sell = 0,
  statsKnown = false,
): InsightData | null {
  if (sinceTs === null) return null;
  const a = bubbles >= 3 && total > 0 && Math.abs(net) / total >= 0.2 ? Math.sign(net) : 0;
  const o = pricePct === null ? 0 : Math.abs(pricePct) < 0.05 ? 0 : Math.sign(pricePct);
  const sentence = a === 0
    ? 'whales are two-sided here — no clear big-player direction.'
    : o > 0
      ? (a > 0
        ? 'whales buying with the rise — the move has big buyers behind it.'
        : 'whales selling into the rise — big players are taking profit or fading it.')
      : o < 0
        ? (a < 0
          ? 'whales selling with the drop — the move has big sellers behind it.'
          : 'whales buying the dip — big buyers are absorbing the selling.')
        : (a > 0
          ? 'price flat while whales buy — possible accumulation.'
          : 'price flat while whales sell — possible distribution.');
  const c = lean === 'BUY LEAN' ? 1 : lean === 'SELL LEAN' ? -1 : 0;
  let agree: string | null = null;
  let agrees: boolean | null = null;
  if (a !== 0 && c !== 0) {
    agrees = a === c;
    agree = agrees
      ? `agrees with the panel's ${c > 0 ? 'buy' : 'sell'} lean`
      : `against the panel's ${c > 0 ? 'buy' : 'sell'} lean`;
  }
  return { since: prettyTime(sinceTs), pricePct, net, bubbles, buy, sell, sentence, agree, agrees, lean, statsKnown };
}

export function WhalesView({ symbol, onSymbol, mode, rows }: WhalesViewProps) {
  const [interval, setInterval] = useState<TerminalInterval>('15m');
  const [settings, setSettings] = useState<WhaleSettings>(loadSettings);
  const [levels, setLevels] = useState<number[]>(loadUserLevels);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [detectOpen, setDetectOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [hasBars, setHasBars] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; price: number; time: number } | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    candle: {
      t: number; o: number; h: number; l: number; c: number;
      buyUsd: number; sellUsd: number;
      whaleBuyUsd: number; whaleSellUsd: number;
      prints: number; rawCount: number;
      firstWhaleT: number | null; lastWhaleT: number | null;
      whaleVwap: number | null; whaleFirstPrice: number | null;
    } | null;
    bubble: WhaleBubble | null;
  } | null>(null);
  const [popover, setPopover] = useState<{ x: number; y: number; bubble: WhaleBubble; trades: TerminalTrade[] } | null>(null);
  const [summary, setSummary] = useState({
    state: 'connecting' as string,
    latencyMs: null as number | null,
    tradeCount: 0,
    last: null as number | null,
    bid: null as number | null,
    ask: null as number | null,
    flash: 0 as -1 | 0 | 1,
    candleDeltaBtc: null as number | null,
    cvd: 0,
    poc: null as number | null,
    t0: null as number | null,
    avg: null as number | null,
  });
  const [view, setView] = useState<WhaleView>({ start: 0, end: 0, priceMin: 0, priceMax: 1 });
  const [insight, setInsight] = useState<InsightData | null>(null);
  const [fitH, setFitH] = useState<number | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const feedRef = useRef<WhaleFeedController | null>(null);
  const drawRef = useRef<{ state: DrawState; view: WhaleView } | null>(null);
  const viewRef = useRef<WhaleView>(view);
  const zoomRef = useRef<{ spanMs: number; endTs: number; priceScale: { center: number; span: number } | null }>({
    spanMs: 0,
    endTs: 0,
    priceScale: null,
  });
  const dragRef = useRef<{ x: number; y: number; end: number; span: number; center: number; pSpan: number; mode: 'time' | 'price' } | null>(null);
  const lastRef = useRef<{ last: number | null; dir: -1 | 0 | 1 }>({ last: null, dir: 0 });
  const dirtyRef = useRef(true);
  const hoverRef = useRef<{ x: number; y: number; price: number; time: number } | null>(null);
  const lastSummaryRef = useRef('');
  const lastViewRenderedRef = useRef<WhaleView | null>(null);
  const summaryValsRef = useRef({ candleDeltaBtc: null as number | null, cvd: 0, poc: null as number | null, avg: null as number | null });
  const insightRef = useRef<InsightData | null>(null);
  const lastInsightKeyRef = useRef('');
  const thresholdRef = useRef(WHALE_AUTO_SIZE_CAP);

  const mock = mode === 'MOCK';
  const debugPlan = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debugwhales');
  const base = symbol.replace(/USDT$/, '');
  const markets = usePolling((s) => api.markets(s), 120_000);
  const scanRow = useMemo(
    () => rows.find((r) => r.pair === symbol) ?? rows.find((r) => r.base === base) ?? null,
    [rows, symbol, base],
  );
  const gammaFeed = usePolling((s) => api.gex(s), 300_000, [], !mock && (base === 'BTC' || base === 'ETH'));
  const gamma: GexSnapshot | null = !mock && base === 'BTC' ? gammaFeed.data?.btc ?? null
    : !mock && base === 'ETH' ? gammaFeed.data?.eth ?? null
      : null;

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    saveUserLevels(levels);
  }, [levels]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitHRef = useRef<number | null>(null);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measureFit = () => {
      const main = el.closest('main');
      if (!main) return;
      const r = main.getBoundingClientRect();
      const cs = getComputedStyle(main);
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padBottom = parseFloat(cs.paddingBottom) || 0;
      const h = window.innerHeight - r.top - padTop - padBottom;
      if (h > 120 && Math.abs(h - (fitHRef.current ?? -1)) > 1) {
        fitHRef.current = h;
        setFitH(h);
      }
    };
    measureFit();
    window.addEventListener('resize', measureFit);
    return () => window.removeEventListener('resize', measureFit);
  }, []);

  const updateSettings = useCallback((patch: Partial<WhaleSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const feedCb = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  useEffect(() => {
    const feed = createWhaleFeed(symbol, interval, mock, { onUpdate: feedCb });
    feedRef.current = feed;
    dirtyRef.current = true;
    zoomRef.current = { spanMs: 0, endTs: 0, priceScale: null };
    const mockTimer = mock ? window.setInterval(() => feed.tickOnce(), 320) : null;
    return () => {
      if (mockTimer) window.clearInterval(mockTimer);
      feed.destroy();
      feedRef.current = null;
    };
  }, [symbol, interval, mock, feedCb]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setHasBars(feedRef.current ? feedRef.current.snapshot().bars.length > 0 : false);
      const hostEl = hostRef.current;
      if (hostEl) {
        const main = hostEl.closest('main');
        if (main) {
          const r = main.getBoundingClientRect();
          const cs = getComputedStyle(main);
          const padTop = parseFloat(cs.paddingTop) || 0;
          const padBottom = parseFloat(cs.paddingBottom) || 0;
          const h = window.innerHeight - r.top - padTop - padBottom;
          if (h > 120 && Math.abs(h - (fitHRef.current ?? -1)) > 1) {
            fitHRef.current = h;
            setFitH(h);
          }
        }
      }
      const feed = feedRef.current;
      if (!feed) return;
      const snap = feed.snapshot();
      const last = snap.last;
      const dir: -1 | 0 | 1 = last !== null && lastRef.current.last !== null
        ? last > lastRef.current.last ? 1 : last < lastRef.current.last ? -1 : 0
        : 0;
      lastRef.current = { last, dir };
      const key = `${snap.state}|${snap.latencyMs}|${snap.tradeCountSinceT0}|${snap.last}|${snap.bid}|${snap.ask}|${dir}|${snap.t0}`;
      if (key === lastSummaryRef.current) return;
      lastSummaryRef.current = key;
      setSummary((prev) => ({
        ...prev,
        state: snap.state,
        latencyMs: snap.latencyMs,
        tradeCount: snap.tradeCountSinceT0,
        last: snap.last,
        bid: snap.bid,
        ask: snap.ask,
        flash: dir,
        t0: snap.t0,
      }));
    }, 350);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!size.w || !size.h) return;
    const draw = drawRef.current;
    if (!draw) return;
    const v = draw.view;
    setView({ ...v });
    const zoom = zoomRef.current;
    const spanMs = v.end - v.start;
    zoom.spanMs = spanMs;
    zoom.endTs = v.end;
  }, [size, hover]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(size.w * dpr);
    const h = Math.round(size.h * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    const render = () => {
      raf = 0;
      const feed = feedRef.current;
      if (!feed) return;
      const snap = feed.snapshot();
      const layout = computeLayout(size.w, size.h);
      const stepMs = INTERVAL_MS[interval];
      const nowEdge = Date.now() + 5_000;
      const plotW = layout.plotRight - layout.plotLeft;
      const zoom = zoomRef.current;
      if (zoom.spanMs <= 0) {
        const span = DEFAULT_CANDLES * stepMs * (plotW / Math.max(1, plotW - RIGHT_PAD_PX));
        zoom.spanMs = Math.max(span, 10 * stepMs);
        zoom.endTs = nowEdge + (RIGHT_PAD_PX / Math.max(1, plotW)) * zoom.spanMs;
        zoom.priceScale = null;
      }
      const end = zoom.endTs;
      const start = end - zoom.spanMs;

      let priceMin = Infinity;
      let priceMax = -Infinity;
      for (const bar of snap.bars) {
        if (bar.t + stepMs < start || bar.t > end) continue;
        priceMin = Math.min(priceMin, bar.l);
        priceMax = Math.max(priceMax, bar.h);
      }
      if (!Number.isFinite(priceMin) || priceMin >= priceMax) {
        const last = snap.last ?? 77_000;
        priceMin = last * 0.995;
        priceMax = last * 1.005;
      }
      const pad = (priceMax - priceMin) * 0.08;
      priceMin -= pad;
      priceMax += pad;
      const priceScale = zoom.priceScale;
      const finalMin = priceScale ? priceScale.center - priceScale.span / 2 : priceMin;
      const finalMax = priceScale ? priceScale.center + priceScale.span / 2 : priceMax;
      const whaleView: WhaleView = { start, end, priceMin: finalMin, priceMax: finalMax };

      const stats = candleStatsFor(snap.bars, snap.trades, stepMs);
      const effThreshold = settings.threshold === 'auto'
        ? (snap.keepUsd > 0 ? snap.keepUsd : WHALE_AUTO_SIZE_CAP)
        : settings.threshold;
      thresholdRef.current = effThreshold;
      const bubbles = buildBubbles(snap.trades, stepMs, {
        threshold: effThreshold,
        clusterWindowMs: settings.clusterWindowMs,
        sideFilter: settings.sideFilter,
        t0: snap.t0,
        mode: settings.mode,
        sizeBy: settings.sizeBy,
        placeAt: settings.placeAt,
      });
      const averages = whaleAverages(bubbles);
      const liq = estimateLiquidationLevels(averages.avg, 5);
      const netPoints = bubbleNet(snap.bars, bubbles, snap.trades, snap.t0, stepMs, effThreshold);

      let inBuy = 0;
      let inSell = 0;
      let inN = 0;
      for (const b of bubbles) {
        if (b.t >= start && b.t <= end) {
          inBuy += b.buyUsd;
          inSell += b.sellUsd;
          inN += 1;
        }
      }
      const inNet = inBuy - inSell;
      const inTotal = inBuy + inSell;
      const visibleBars = snap.bars.filter((b) => b.t + stepMs >= start && b.t <= end);
      const p0 = visibleBars.length ? visibleBars[0].o : null;
      const p1 = snap.last ?? (visibleBars.length ? visibleBars[visibleBars.length - 1].c : null);
      const pricePct = p0 !== null && p1 !== null && p0 > 0 ? ((p1 / p0) - 1) * 100 : null;
      const lean = leanFor(inNet, inTotal);

      const userLevels = settings.showLevels
        ? levels.map((price, i) => ({
          id: `user-${i}`,
          kind: 'user' as const,
          price,
          label: `my level`,
          style: 'dashed' as const,
          color: '#ffffff',
        }))
        : [];
      const refLevels = settings.showRef && snap.bars.length
        ? [{
          id: 'ref',
          kind: 'ref' as const,
          price: mock ? 81_408.86 : (scanRow?.setup?.context?.[0]?.price ?? snap.last ?? 0),
          label: '',
          style: 'solid' as const,
          color: '#8b93a1',
        }]
        : [];
      const liqLevels = settings.showLiq && (liq.shorts > 0 || liq.longs > 0)
        ? [
          { id: 'liq-short', kind: 'liq-short' as const, price: mock ? 79_469.66 : liq.shorts, label: 'shorts liquidate', style: 'dotted' as const, color: T.magenta },
          { id: 'liq-long', kind: 'liq-long' as const, price: mock ? 69_531.10 : liq.longs, label: 'longs liquidate', style: 'dotted' as const, color: T.magenta },
        ]
        : [];
      const planLevels = settings.showPlan
        ? planFromContext(scanRow, snap.last).map<WhaleLevel>((l) => ({
          id: `plan-${l.kind}`,
          kind: l.kind as WhaleLevel['kind'],
          price: l.price,
          label: l.label,
          style: l.dash.length === 2 ? 'dashed' : 'dotted',
          color: l.color,
        }))
        : [];
      const gammaLevels = settings.showGamma && gamma
        ? [
          { id: 'g-call', kind: 'gamma-call' as const, price: gamma.callWall, label: 'call wall', style: 'dashed' as const, color: '#38bdf8' },
          { id: 'g-put', kind: 'gamma-put' as const, price: gamma.putWall, label: 'put wall', style: 'dashed' as const, color: '#fb923c' },
        ]
        : [];
      const levelLines: WhaleLevel[] = [
        ...userLevels,
        ...refLevels,
        ...liqLevels,
        ...planLevels,
        ...gammaLevels,
      ];

      const drawState: DrawState = {
        bars: snap.bars,
        stats,
        trades: snap.trades,
        bubbles,
        levels: levelLines,
        t0: snap.t0,
        netPoints: netPoints.points,
        lastPrice: snap.last,
        interval,
        maFast: ema(snap.bars.map((b) => b.c), 20),
        maSlow: ema(snap.bars.map((b) => b.c), 50),
      };
      drawRef.current = { state: drawState, view: whaleView };
      viewRef.current = whaleView;

      drawWhales(ctx, layout, drawState, whaleView, {
        showBubbles: settings.showBubbles,
        showAvg: settings.showAvg,
        showZones: settings.showZones,
        showVolProfile: settings.showVolProfile,
        showLiq: settings.showLiq,
        showLevels: settings.showLevels,
        showMa: settings.showMa,
        showBubbleNet: settings.showBubbleNet,
        showRef: settings.showRef,
        showVolume: settings.showVolume,
        hover: hoverRef.current,
        expectedNet: inNet,
      });

      const insightObj = buildInsight(snap.fromTs ?? snap.t0, pricePct, inNet, inTotal, inN, lean, inBuy, inSell, snap.stats !== null);
      insightRef.current = insightObj;
      const insightKey = insightObj ? JSON.stringify([insightObj.since, insightObj.pricePct?.toFixed(2), insightObj.net.toFixed(0), insightObj.bubbles, insightObj.sentence, insightObj.agree, insightObj.lean]) : 'none';
      if (insightKey !== lastInsightKeyRef.current) {
        lastInsightKeyRef.current = insightKey;
        setInsight(insightObj);
      }

      if (debugPlan) {
        publishDebugPlan({
          view: whaleView,
          plot: { left: layout.plotLeft, right: layout.plotRight, top: layout.priceTop, bottom: layout.priceTop + layout.priceH },
          bars: snap.bars,
          trades: snap.trades,
          bubbles,
          netPoints: netPoints.points,
          stepMs,
          t0: snap.t0,
          last: snap.last,
          inNet,
          zonesOn: settings.showZones,
        });
      }

      const cvd = visiblePocLevel(snap.trades, start, end, finalMin, finalMax);
      let candleDelta = 0;
      for (const bar of snap.bars) {
        if (bar.t + stepMs <= start || bar.t > end) continue;
        const stat = stats.get(bar.t);
        if (stat) candleDelta += stat.buyUsd - stat.sellUsd;
      }
      const poc = visiblePoc(snap.trades, start, end, finalMin, finalMax);
      const candleDeltaBtc = snap.last ? candleDelta / snap.last : null;
      const vals = summaryValsRef.current;
      if (
        vals.candleDeltaBtc !== candleDeltaBtc
        || vals.cvd !== cvd
        || vals.poc !== poc
        || vals.avg !== averages.avg
      ) {
        vals.candleDeltaBtc = candleDeltaBtc;
        vals.cvd = cvd;
        vals.poc = poc;
        vals.avg = averages.avg;
        setSummary((prev) => ({ ...prev, candleDeltaBtc, cvd, poc, avg: averages.avg }));
      }

      const lastRendered = lastViewRenderedRef.current;
      if (
        !lastRendered
        || Math.abs(lastRendered.start - whaleView.start) > 1
        || Math.abs(lastRendered.end - whaleView.end) > 1
        || Math.abs(lastRendered.priceMin - whaleView.priceMin) > 1e-6
        || Math.abs(lastRendered.priceMax - whaleView.priceMax) > 1e-6
      ) {
        lastViewRenderedRef.current = whaleView;
        setView(whaleView);
      }
      dirtyRef.current = false;
    };
    const loop = () => {
      if (dirtyRef.current) render();
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [size, interval, settings, levels, gamma, scanRow, mock]);

  const pointerPos = (event: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const maxEndFor = (spanMs: number, plotW: number) => {
    return Date.now() + 5_000 + (RIGHT_PAD_PX / Math.max(1, plotW)) * spanMs;
  };

  const updateHover = (pos: { x: number; y: number } | null) => {
    if (!pos) {
      hoverRef.current = null;
      setHover(null);
      setTooltip(null);
      return;
    }
    const layout = computeLayout(size.w, size.h);
    const v = viewRef.current;
    const { x, y } = pos;
    if (x < layout.plotLeft || x > layout.plotRight || y < layout.priceTop || y > layout.netTop + layout.netH) {
      setHover(null);
      setTooltip(null);
      return;
    }
    const time = timeForX(x, v.start, v.end, layout.plotLeft, layout.plotRight - layout.plotLeft);
    const price = priceForY(y, v.priceMin, v.priceMax, layout.priceTop, layout.priceH);
    const stepMs = INTERVAL_MS[interval];
    const bucket = Math.floor(time / stepMs) * stepMs;
    const draw = drawRef.current;
    let candle = null;
    if (draw) {
      const bar = draw.state.bars.find((b) => b.t === bucket);
      if (bar) {
        const stat = draw.state.stats.get(bar.t);
        const floor = thresholdRef.current;
        const whaleTrades = draw.state.trades.filter(
          (t) => t.t >= bucket && t.t < bucket + stepMs && t.usd >= floor
            && (settings.sideFilter === 'both' || (settings.sideFilter === 'buys' ? t.side === 'buy' : t.side === 'sell')),
        );
        let whaleBuyUsd = 0;
        let whaleSellUsd = 0;
        let rawCount = 0;
        let firstWhaleT: number | null = null;
        let lastWhaleT: number | null = null;
        let whaleFirstPrice: number | null = null;
        let sumPx = 0;
        for (const t of whaleTrades) {
          if (t.side === 'buy') whaleBuyUsd += t.usd;
          else whaleSellUsd += t.usd;
          rawCount += t.count ?? 1;
          sumPx += t.price * t.usd;
          firstWhaleT = firstWhaleT === null ? t.t : Math.min(firstWhaleT, t.t);
          lastWhaleT = lastWhaleT === null ? t.t : Math.max(lastWhaleT, t.t);
          whaleFirstPrice = whaleFirstPrice === null ? t.price : whaleFirstPrice;
        }
        const whaleTotal = whaleBuyUsd + whaleSellUsd;
        candle = {
          t: bar.t,
          o: bar.o,
          h: bar.h,
          l: bar.l,
          c: bar.c,
          buyUsd: stat?.buyUsd ?? (bar.takerBuyQuote ?? 0),
          sellUsd: stat?.sellUsd ?? Math.max(0, (bar.qv ?? 0) - (bar.takerBuyQuote ?? 0)),
          whaleBuyUsd,
          whaleSellUsd,
          prints: whaleTrades.length ? countWhalePrints(whaleTrades, bucket, stepMs, 0, 'both', -Infinity, settings.clusterWindowMs) : 0,
          rawCount,
          firstWhaleT,
          lastWhaleT,
          whaleVwap: whaleTotal > 0 ? sumPx / whaleTotal : null,
          whaleFirstPrice,
        };
      }
    }
    const bubble = draw ? bubbleAtPoint(layout, v, draw.state.bubbles, x, y) : null;
    hoverRef.current = { x, y, price, time };
    setHover({ x, y, price, time });
    setTooltip({ x, y, candle, bubble });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const pos = pointerPos(event);
    const drag = dragRef.current;
    if (drag && pos) {
      const layout = computeLayout(size.w, size.h);
      const v = viewRef.current;
      const plotW = layout.plotRight - layout.plotLeft;
      const zoom = zoomRef.current;
      const span = zoom.spanMs || (v.end - v.start);
      const maxEnd = maxEndFor(span, plotW);
      const minStart = v.start - (v.end - v.start);
      if (drag.mode === 'time') {
        const dx = pos.x - drag.x;
        const newEnd = drag.end - (dx / Math.max(1, plotW)) * span;
        zoom.endTs = clampNumber(newEnd, minStart + span, maxEnd);
        dirtyRef.current = true;
      } else {
        const dy = pos.y - drag.y;
        const scale = zoom.priceScale ?? { center: (v.priceMin + v.priceMax) / 2, span: v.priceMax - v.priceMin };
        zoom.priceScale = { center: drag.center + (dy / Math.max(1, layout.priceH)) * scale.span, span: scale.span };
        dirtyRef.current = true;
      }
    }
    updateHover(pos);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const pos = pointerPos(event);
    if (!pos) return;
    const v = viewRef.current;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      x: pos.x,
      y: pos.y,
      end: v.end,
      span: v.end - v.start,
      center: (v.priceMin + v.priceMax) / 2,
      pSpan: v.priceMax - v.priceMin,
      mode: event.shiftKey ? 'price' : 'time',
    };
    setPopover(null);
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  const resetZoom = () => {
    const layout = computeLayout(size.w, size.h);
    const plotW = layout.plotRight - layout.plotLeft;
    const stepMs = INTERVAL_MS[interval];
    const nowEdge = Date.now() + 5_000;
    const span = DEFAULT_CANDLES * stepMs * (plotW / Math.max(1, plotW - RIGHT_PAD_PX));
    zoomRef.current = {
      spanMs: Math.max(span, 10 * stepMs),
      endTs: nowEdge + (RIGHT_PAD_PX / Math.max(1, plotW)) * span,
      priceScale: null,
    };
    dirtyRef.current = true;
    setPopover(null);
  };

  const onDoubleClick = () => {
    resetZoom();
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const pos = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const layout = computeLayout(size.w, size.h);
      const v = viewRef.current;
      const plotW = layout.plotRight - layout.plotLeft;
      if (pos.x < layout.plotLeft || pos.x > layout.plotRight) return;
      event.preventDefault();
      const anchorTime = timeForX(pos.x, v.start, v.end, layout.plotLeft, plotW);
      const factor = event.deltaY > 0 ? 1.12 : 1 / 1.12;
      const zoom = zoomRef.current;
      const stepMs = INTERVAL_MS[interval];
      const fullSpan = zoom.spanMs || (v.end - v.start);
      const nextSpan = clampNumber(fullSpan * factor, 10 * stepMs, 14 * 24 * 3_600_000);
      const ratio = (pos.x - layout.plotLeft) / plotW;
      const nextEnd = anchorTime + (1 - ratio) * nextSpan;
      const maxEnd = maxEndFor(nextSpan, plotW);
      const minStart = v.start - (v.end - v.start);
      zoom.spanMs = nextSpan;
      zoom.endTs = clampNumber(nextEnd, minStart + nextSpan, maxEnd);
      dirtyRef.current = true;
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [size, interval]);

  const onContextMenu = (event: React.MouseEvent) => {
    const pos = pointerPos(event as unknown as React.PointerEvent);
    if (!pos) return;
    const layout = computeLayout(size.w, size.h);
    const v = viewRef.current;
    if (pos.x < layout.plotLeft || pos.x > layout.plotRight) return;
    if (pos.y < layout.priceTop || pos.y > layout.priceTop + layout.priceH) return;
    event.preventDefault();
    const price = priceForY(pos.y, v.priceMin, v.priceMax, layout.priceTop, layout.priceH);
    const snapped = Math.round(price * 100) / 100;
    setLevels((prev) => {
      const exists = prev.some((p) => Math.abs(p - snapped) < 0.005);
      return exists ? prev.filter((p) => Math.abs(p - snapped) >= 0.005) : [...prev, snapped].sort((a, b) => a - b);
    });
  };

  const onClickCanvas = (event: React.MouseEvent) => {
    if (dragRef.current) return;
    const pos = pointerPos(event as unknown as React.PointerEvent);
    if (!pos) return;
    const layout = computeLayout(size.w, size.h);
    const v = viewRef.current;
    const draw = drawRef.current;
    const bubble = draw ? bubbleAtPoint(layout, v, draw.state.bubbles, pos.x, pos.y) : null;
    if (!bubble || !draw) return;
    const trades = bubble.tradeIds
      .map((id) => draw.state.trades.find((t) => t.id === id))
      .filter((t): t is TerminalTrade => Boolean(t))
      .sort((a, b) => a.t - b.t);
    setPopover({ x: pos.x, y: pos.y, bubble, trades });
  };

  const query = pickerQuery.trim().toLowerCase();
  const marketRows = useMemo(() => {
    if (!query) return (markets.data?.rows ?? []).slice(0, 80);
    return (markets.data?.rows ?? [])
      .filter((r) => r.base.toLowerCase().includes(query) || r.name.toLowerCase().includes(query) || r.pair.toLowerCase().includes(query))
      .slice(0, 80);
  }, [markets.data, query]);

  const flashClass = summary.flash > 0 ? 'is-up' : summary.flash < 0 ? 'is-down' : '';
  const stateLabel = summary.state === 'live' ? 'LIVE' : summary.state === 'reconnecting' ? 'RECONNECTING' : summary.state === 'stale' ? 'STALE' : summary.state === 'mock' ? 'MOCK' : summary.state === 'offline' ? 'OFFLINE' : 'CONNECTING';
  const stateClass = summary.state === 'live' || summary.state === 'mock' ? 'is-live' : summary.state === 'stale' ? 'is-stale' : 'is-off';

  const dockLevels = useMemo(() => {
    const draw = drawRef.current;
    if (!draw) return [];
    const last = summary.last;
    if (last === null) return [];
    return [...draw.state.levels]
      .filter((l) => l.kind !== 'ref')
      .sort((a, b) => Math.abs(a.price - last) - Math.abs(b.price - last))
      .slice(0, 4);
  }, [summary.last, view]);

  const tooltipPos = (() => {
    if (!tooltip || !size.w || !size.h) return null;
    const l = computeLayout(size.w, size.h);
    const v = viewRef.current;
    const vp: PlanViewport = {
      plotLeft: l.plotLeft,
      plotRight: l.plotRight,
      plotTop: l.priceTop,
      plotBottom: l.priceTop + l.priceH,
      priceMin: v.priceMin,
      priceMax: v.priceMax,
      start: v.start,
      end: v.end,
    };
    return tooltipPlacement(tooltip.x, tooltip.y, vp);
  })();

  return (
    <section className="whales-view" aria-label="Whales order-flow chart" style={fitH !== null ? { height: fitH } : undefined}>
      <header className="whales-topbar">
        <div className="whales-brand">
          <span className="whales-word">Tradfye</span>
          <span className="whales-beta">BETA · Free</span>
        </div>

        <div className="whales-picker" role="listbox" aria-label="Select market">
          <button
            type="button"
            className="whales-picker__btn"
            onClick={() => setPickerOpen((v) => !v)}
            aria-expanded={pickerOpen}
            title="Pick a market (USDT pairs on Binance spot)"
          >
            <b>{base}</b><span>/USDT</span> <i aria-hidden>▾</i>
          </button>
          {pickerOpen && (
            <div className="whales-picker__pop">
              <input
                autoFocus
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder="Search BTC, ETH, SOL…"
                aria-label="Search markets"
              />
              <div className="whales-picker__list">
                {marketRows.map((row) => (
                  <button
                    key={row.pair}
                    type="button"
                    className={row.pair === symbol ? 'is-on' : ''}
                    onClick={() => {
                      onSymbol(row.pair);
                      setPickerOpen(false);
                      setPickerQuery('');
                    }}
                  >
                    <span>{row.base}<small>/USDT</small></span>
                    <span>{fmtPrice(row.price)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="whales-quote">
          <span className={`whales-last ${flashClass}`}>{summary.last === null ? DASH : fmtPrice(summary.last)}</span>
          <span className="whales-bid">bid {summary.bid === null ? DASH : fmtPrice(summary.bid)}</span>
          <span className="whales-ask">ask {summary.ask === null ? DASH : fmtPrice(summary.ask)}</span>
          <span className="whales-spread">1 tick · 0.001 bp</span>
          <span className="whales-stat">
            <small>{interval} candle Δ</small>
            <b className={summary.candleDeltaBtc !== null && summary.candleDeltaBtc >= 0 ? 'is-up' : 'is-down'}>
              {summary.candleDeltaBtc === null ? DASH : fmtBtc(summary.candleDeltaBtc, summary.last ?? 1)}
            </b>
          </span>
          <span className="whales-stat">
            <small>CVD</small>
            <b className={summary.cvd >= 0 ? 'is-up' : 'is-down'}>{fmtSignedUsd(summary.cvd)}</b>
          </span>
          <span className="whales-stat">
            <small>POC</small>
            <b className="is-poc">{summary.poc === null ? DASH : fmtPrice(summary.poc)}</b>
          </span>
          <span className="whales-readout" title="Bought / sold in the bubbles in view (the line below has the net and how many)">
            {settings.threshold === 'auto' && insight && !insight.statsKnown && <span className="readout-auto">sizing Auto… ·</span>}
            {insight && (
              <>
                <span className="is-up">buy {fmtUsd(insight.buy)}</span>
                <span className="readout-sep">/</span>
                <span className="is-down">sell {fmtUsd(insight.sell)}</span>
              </>
            )}
          </span>
        </div>

        <label className="whales-sel" title="Bubble detection mode">
          <span>Detect</span>
          <select value={settings.mode} onChange={(e) => updateSettings({ mode: e.target.value as WhaleBubbleMode })}>
            <option value="sweep">Sweep</option>
            <option value="aggressive">Aggressive</option>
            <option value="level">Level</option>
            <option value="print">Print</option>
          </select>
        </label>
        <label className="whales-sel" title="This mode's threshold — Auto = the top 0.5% of what it finds on this coin; your own amount in ⚙ Settings">
          <span>Size ≥</span>
          <select value={String(settings.threshold)} onChange={(e) => updateSettings({ threshold: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })}>
            <option value="auto">Auto</option>
            <option value="1000">$1K</option>
            <option value="10000">$10K</option>
            <option value="50000">$50K</option>
            <option value="100000">$100K</option>
            <option value="500000">$500K</option>
          </select>
        </label>

        <div className="whales-tf" role="group" aria-label="Timeframe">
          {STEP_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={interval === k ? 'is-on' : ''}
              aria-pressed={interval === k}
              onClick={() => setInterval(k)}
              title={`Candle length${settings.linkedTf ? ' — linked: changing it changes the shared timeframe everywhere' : ' (unlinked from the shared timeframe)'}. Trade history covers the last ~40,000 trades (often 1–4 hours on busy coins), then grows live — 1m / 5m show it best`}
            >
              {k === '1d' ? '1D' : k}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`whales-link ${settings.linkedTf ? 'is-on' : ''}`}
          onClick={() => updateSettings({ linkedTf: !settings.linkedTf })}
          title={settings.linkedTf
            ? `Linked to the shared timeframe (${interval}) — click to keep its own`
            : 'Its own timeframe — click to follow the shared one again'}
        >
          ◈
        </button>

        <div className="whales-toggles" role="group" aria-label="Chart lines">
          <button type="button" aria-pressed={settings.showAvg} className={settings.showAvg ? 'is-on' : ''} onClick={() => updateSettings({ showAvg: !settings.showAvg })} title="Lines at the average price whales bought and sold at (in view) — whether the big buyers / sellers are in profit"><span className="glyph">{settings.showAvg ? '✓' : '◯'}</span>Whale avg</button>
          <button type="button" aria-pressed={settings.showZones} className={settings.showZones ? 'is-on' : ''} onClick={() => updateSettings({ showZones: !settings.showZones })} title="Bands where the most whale dollars traded (top 2 per side, in view)"><span className="glyph">{settings.showZones ? '✓' : '◯'}</span>Zones</button>
          <button type="button" aria-pressed={settings.showVolProfile} className={settings.showVolProfile ? 'is-on' : ''} onClick={() => updateSettings({ showVolProfile: !settings.showVolProfile })} title="Volume by price for the candles on screen, in a strip at the right. POC = busiest price, stronger rows = 70% value area."><span className="glyph">{settings.showVolProfile ? '✓' : '◯'}</span>Vol profile</button>
          <button type="button" aria-pressed={settings.showMa} className={settings.showMa ? 'is-on' : ''} onClick={() => updateSettings({ showMa: !settings.showMa })} title="Moving averages (fast yellow EMA20, slow purple EMA50)"><span className="glyph">{settings.showMa ? '✓' : '◯'}</span>Lines</button>
          <button type="button" aria-pressed={settings.showPlan} className={settings.showPlan ? 'is-on' : ''} onClick={() => updateSettings({ showPlan: !settings.showPlan })} title="Decision panel levels: entry / stop / target"><span className="glyph">{settings.showPlan ? '✓' : '◯'}</span>Plan</button>
          <button type="button" aria-pressed={settings.showGamma} className={settings.showGamma ? 'is-on' : ''} onClick={() => updateSettings({ showGamma: !settings.showGamma })} title="Options gamma walls (Deribit, BTC/ETH)"><span className="glyph">{settings.showGamma ? '✓' : '◯'}</span>Γ</button>
          <button type="button" aria-pressed={settings.showLiq} className={settings.showLiq ? 'is-on' : ''} onClick={() => updateSettings({ showLiq: !settings.showLiq })} title="Estimated liquidation clusters"><span className="glyph">{settings.showLiq ? '✓' : '◯'}</span>Liq</button>
          <button type="button" className={`whales-gearbtn ${detectOpen ? 'is-on' : ''}`} onClick={() => setDetectOpen((v) => !v)} aria-expanded={detectOpen} title="All bubble settings: detection mode and its parameters, sweep filters, aggressor method, size, labels and colours">⚙ Settings</button>
          <button type="button" className="whales-helpbtn" onClick={() => setHelpOpen((v) => !v)} aria-expanded={helpOpen} aria-label={`Help: Whales — big trade bubbles, on candles`}>?</button>
        </div>

        <div className="whales-feed">
          <span className={`whales-state ${stateClass}`} title={`${summary.state} · latency ${summary.latencyMs ?? DASH} ms`}>
            <i />{stateLabel}
          </span>
          <span className="whales-diag" title="Connection diagnostics">
            {summary.state} · {summary.latencyMs === null ? DASH : `${summary.latencyMs} ms`} · {summary.tradeCount.toLocaleString()} trades since T0
          </span>
          <button type="button" className="whales-toggle" onClick={() => setLegendOpen((v) => !v)} aria-expanded={legendOpen}>Legend</button>
        </div>
      </header>

      {settings.showInsight && insight && (
        <div className="whales-insight">
          <span className="insight-pre">In view since <b>{insight.since}</b>:</span>
          <span className={insight.pricePct !== null && insight.pricePct < 0 ? 'insight-neg' : 'insight-pos'}>
            price {insight.pricePct === null ? DASH : fmtPct(insight.pricePct)}
          </span>
          <span className="insight-sep">.</span>
          <span className={insight.net >= 0 ? 'insight-pos' : 'insight-neg'}>
            whales net {fmtSignedUsd(insight.net)} ({insight.bubbles} bubbles)
          </span>
          <span className="insight-sep">-</span>
          <span className="insight-phrase">{insight.sentence}</span>
          {insight.agree && (
            <span className={insight.agrees ? 'insight-agree' : 'insight-against'}>
              ({insight.agree})
            </span>
          )}
          <span className="insight-muted">Context, not a signal.</span>
        </div>
      )}

      <div className="whales-body">
        <div className="whales-canvas-host" ref={hostRef}>
          <canvas
            ref={canvasRef}
            className="block h-full w-full cursor-crosshair select-none outline-none"
            tabIndex={0}
            aria-label="Large trades and inferred grouped prints by price"
            onPointerMove={onPointerMove}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerLeave={() => updateHover(null)}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
            onClick={onClickCanvas}
          />

          {!hasBars && (
            <div className="whales-loading">
              {summary.state === 'offline' ? 'No candles yet' : 'Loading candles and whale trades…'}
            </div>
          )}

          {tooltip && tooltipPos && (
            <div
              className="whales-tooltip"
              style={{
                left: tooltipPos.x,
                top: tooltipPos.y,
              }}
            >
              {tooltip.candle && (
                <>
                  <div className="tt-line tt-title">
                    {dateTimeLabel(tooltip.candle.t)} &nbsp; O {fmtPrice(tooltip.candle.o)} &nbsp; H {fmtPrice(tooltip.candle.h)} &nbsp; L {fmtPrice(tooltip.candle.l)} &nbsp; C {fmtPrice(tooltip.candle.c)}
                  </div>
                  <div className="tt-line">
                    <span>vol {fmtUsd(tooltip.candle.buyUsd + tooltip.candle.sellUsd)}</span>
                    <span className="tt-sep">.</span>
                    <span className="is-up">buy {fmtUsd(tooltip.candle.buyUsd)}</span>
                    <span className="is-down">sell {fmtUsd(tooltip.candle.sellUsd)}</span>
                    <span className="tt-sep">.</span>
                    <span className={tooltip.candle.buyUsd - tooltip.candle.sellUsd >= 0 ? 'is-up' : 'is-down'}>
                      Delta {fmtSignedUsd(tooltip.candle.buyUsd - tooltip.candle.sellUsd)}
                    </span>
                  </div>
                  {tooltip.candle.whaleVwap !== null && (
                    <>
                      <div className="tt-line tt-whale">
                        <span className="tt-whale-icon" />
                        <span>{tooltip.candle.prints} bubbles: {fmtUsd(tooltip.candle.whaleBuyUsd + tooltip.candle.whaleSellUsd)}</span>
                        <span className="tt-sep">-</span>
                        <span>buy {fmtUsd(tooltip.candle.whaleBuyUsd)} / sell {fmtUsd(tooltip.candle.whaleSellUsd)}</span>
                        <span className="tt-sep">@</span>
                        <span>{fmtPrice(tooltip.candle.whaleVwap)}</span>
                      </div>
                      <div className="tt-line tt-whale">
                        <span className="tt-whale-icon" />
                        <span>{tooltip.candle.rawCount.toLocaleString()} trades</span>
                        <span className="tt-sep">.</span>
                        <span>
                          {tooltip.candle.firstWhaleT !== null && tooltip.candle.lastWhaleT !== null
                            ? `${prettyTime(tooltip.candle.firstWhaleT, true)}-${prettyTime(tooltip.candle.lastWhaleT, true)}`
                            : DASH}
                        </span>
                        <span className="tt-sep">.</span>
                        <span>
                          price since:{' '}
                          <span className={tooltip.candle.whaleFirstPrice !== null && tooltip.candle.c >= (tooltip.candle.whaleFirstPrice ?? 0) ? 'is-up' : 'is-down'}>
                            {tooltip.candle.whaleFirstPrice !== null && tooltip.candle.whaleFirstPrice > 0
                              ? fmtPct(((tooltip.candle.c / tooltip.candle.whaleFirstPrice) - 1) * 100)
                              : DASH}
                          </span>
                        </span>
                      </div>
                    </>
                  )}
                </>
              )}
              {!tooltip.candle && (
                <div className="tt-line"><span>no candle here</span></div>
              )}
            </div>
          )}

          {popover && (
            <div
              className="whales-popover"
              style={{
                left: clampNumber(popover.x, 4, Math.max(4, size.w - 380)),
                top: clampNumber(popover.y, 4, Math.max(4, size.h - 300)),
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="whales-popover__head">
                <strong>Whale bubble — {fmtUsd(popover.bubble.notional)} @ {fmtPrice(popover.bubble.price)}</strong>
                <button type="button" onClick={() => setPopover(null)} aria-label="Close">×</button>
              </div>
              <div className="whales-popover__table">
                <div className="whales-popover__row is-head"><span>Time</span><span>Side</span><span>Price</span><span>Qty</span><span>Notional</span></div>
                {popover.trades.slice(-24).reverse().map((t) => (
                  <div key={t.id} className="whales-popover__row">
                    <span>{dateTimeLabel(t.t)}</span>
                    <span className={t.side === 'buy' ? 'is-up' : 'is-down'}>{t.side.toUpperCase()}</span>
                    <span>{fmtPrice(t.price)}</span>
                    <span>{t.qty.toFixed(5)}</span>
                    <span>{fmtUsd(t.usd)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <aside className={`whales-dock ${dockOpen ? 'is-open' : ''}`} aria-label="Panel lean">
          <button type="button" className="whales-dock__toggle" onClick={() => setDockOpen((v) => !v)} aria-expanded={dockOpen} title={dockOpen ? 'Collapse' : 'Expand'}>
            {dockOpen ? '»' : '«'}
          </button>
          {!dockOpen && insight && (
            <div className={`whales-dock__lean is-${insight.lean === 'BUY LEAN' ? 'buy' : insight.lean === 'SELL LEAN' ? 'sell' : 'wait'}`}>
              {insight.lean}
            </div>
          )}
          {dockOpen && (
            <div className="whales-dock__panel">
              <div className="whales-dock__head">
                <strong>Panel lean</strong>
                <span className={`dock-lean is-${insight?.lean === 'BUY LEAN' ? 'buy' : insight?.lean === 'SELL LEAN' ? 'sell' : 'wait'}`}>
                  {insight?.lean ?? 'WAIT'}
                </span>
              </div>
              <div className="whales-dock__rows">
                <div className="whales-dock__row">
                  <span>whale net</span>
                  <b className={insight && insight.net >= 0 ? 'is-up' : 'is-down'}>{insight ? fmtSignedUsd(insight.net) : DASH}</b>
                </div>
                <div className="whales-dock__row">
                  <span>absorption</span>
                  <b>{insight ? (insight.pricePct !== null && insight.pricePct < 0 && insight.net > 0 ? 'absorbing selling' : insight.pricePct !== null && insight.pricePct > 0 && insight.net < 0 ? 'distributing into strength' : 'flow confirms trend') : DASH}</b>
                </div>
                <div className="whales-dock__row">
                  <span>bubbles</span>
                  <b>{insight ? insight.bubbles : DASH}</b>
                </div>
              </div>
              <div className="whales-dock__levels">
                <div className="whales-dock__sub">nearest levels</div>
                {dockLevels.map((l) => (
                  <div key={`${l.id}-${l.price}`} className="whales-dock__row">
                    <span style={{ color: l.color }}>{l.label} {fmtPrice(l.price)}</span>
                  </div>
                ))}
                {dockLevels.length === 0 && <div className="whales-dock__row"><span>—</span></div>}
              </div>
            </div>
          )}
        </aside>
      </div>

      {legendOpen && (
        <div className="whales-popover whales-legend">
          <div className="whales-popover__head"><strong>Legend / overlays</strong><button type="button" onClick={() => setLegendOpen(false)}>×</button></div>
          {([
            ['Whale avg lines', 'showAvg'],
            ['Zones (top 2 per side)', 'showZones'],
            ['Vol profile strip', 'showVolProfile'],
            ['Whale bubbles', 'showBubbles'],
            ['Liquidation lines', 'showLiq'],
            ['My levels', 'showLevels'],
            ['Moving averages', 'showMa'],
            ['Volume panel', 'showVolume'],
            ['Bubble-net panel', 'showBubbleNet'],
            ['Insight strip', 'showInsight'],
            ['Reference ray', 'showRef'],
          ] as Array<[string, keyof WhaleSettings]>).map(([label, key]) => (
            <label key={key} className="whales-check">
              <input type="checkbox" checked={Boolean(settings[key])} onChange={(e) => updateSettings({ [key]: e.target.checked } as Partial<WhaleSettings>)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      )}

      {detectOpen && (
        <div className="whales-popover whales-detect">
          <div className="whales-popover__head"><strong>Big trade bubbles</strong><button type="button" onClick={() => setDetectOpen(false)}>×</button></div>
          <label className="whales-field">
            <span>Mode</span>
            <select value={settings.mode} onChange={(e) => updateSettings({ mode: e.target.value as WhaleBubbleMode })}>
              <option value="sweep">Sweep — fast trades on one side grouped into one bubble (a market order or burst taking out several price levels)</option>
              <option value="aggressive">Aggressive — buying at the ask / selling at the bid added up while the quotes hold</option>
              <option value="level">Level — the volume at one price level</option>
              <option value="print">Print — every qualifying trade is its own bubble</option>
            </select>
          </label>
          <label className="whales-field">
            <span>Size ≥</span>
            <select value={String(settings.threshold)} onChange={(e) => updateSettings({ threshold: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })}>
              <option value="auto">Auto (top 0.5% of prints, capped $5K)</option>
              <option value="1000">$1K+</option>
              <option value="10000">$10K+</option>
              <option value="50000">$50K+</option>
              <option value="100000">$100K+</option>
              <option value="500000">$500K+</option>
            </select>
          </label>
          <label className="whales-field">
            <span>Aggressor</span>
            <select value={settings.aggressor} onChange={(e) => updateSettings({ aggressor: e.target.value as WhaleAggressor })}>
              <option value="combined">Combined</option>
              <option value="bidask">Bid/ask</option>
              <option value="tick">Tick</option>
            </select>
          </label>
          <label className="whales-field">
            <span>Size by</span>
            <select value={settings.sizeBy} onChange={(e) => updateSettings({ sizeBy: e.target.value as WhaleSizeBy })}>
              <option value="total">Total volume — buys + sells in the bubble</option>
              <option value="aggressive">Aggressive volume — only its taker side</option>
            </select>
          </label>
          <label className="whales-field">
            <span>Label</span>
            <select value={settings.labelPos} onChange={(e) => updateSettings({ labelPos: e.target.value as WhaleSettings['labelPos'] })}>
              <option value="above">Above</option>
              <option value="inside">Inside</option>
              <option value="below">Below</option>
            </select>
          </label>
          <label className="whales-field">
            <span>Bubble at</span>
            <select value={settings.placeAt} onChange={(e) => updateSettings({ placeAt: e.target.value as WhalePlaceAt })}>
              <option value="vwap">Avg price — the volume-weighted price of its trades</option>
              <option value="first">Start — the price it started at</option>
              <option value="last">Last — the price it ended at</option>
            </select>
          </label>
          <label className="whales-field">
            <span>Sweep window (s)</span>
            <input type="number" min={1} max={30} step={1} value={Math.round(settings.clusterWindowMs / 1_000)} onChange={(e) => updateSettings({ clusterWindowMs: Math.max(1, Number(e.target.value) || 1) * 1_000 })} />
          </label>
          <label className="whales-field">
            <span>Side filter</span>
            <select value={settings.sideFilter} onChange={(e) => updateSettings({ sideFilter: e.target.value as WhaleSettings['sideFilter'] })}>
              <option value="both">Both</option>
              <option value="buys">Buys only</option>
              <option value="sells">Sells only</option>
            </select>
          </label>
          <div className="whales-detect__note">
            On a taker-only spot tape the aggressor is known per print, so bid/ask and tick classifiers resolve to the same side here (documented limitation).
          </div>
        </div>
      )}

      {helpOpen && (
        <div className="whales-popover whales-help">
          <div className="whales-popover__head"><strong>Whales — big trade bubbles, on candles</strong><button type="button" onClick={() => setHelpOpen(false)}>×</button></div>
          <div className="whales-help__body">
            <p>
              Each <b>bubble</b> is large buying or selling at its real time and price, found one of four ways (<b>Detect</b>):{' '}
              <b>Sweep</b> — fast trades on one side taking out several price levels; <b>Aggressive</b> — buying at the ask and selling at the bid added up while the quotes hold (big size hitting one level, often absorbed there);{' '}
              <b>Level</b> — the volume at one price level; <b>Print</b> — every qualifying trade on its own.
            </p>
            <p>
              <b>Whale avg</b> lines: the average price whales bought / sold at in view, and how far price is from it — big buyers in profit tend to defend their level, big buyers underwater may sell on a bounce.{' '}
              <b>Zones</b>: the bands where the most whale dollars traded (top 2 per side, in view).
            </p>
            <p>
              Bottom pane: <b>bubble net</b> (bought − sold in bubbles) — bars per candle, and the running total since the left edge; the dashed sky line is everyone else (each candle's net from Binance minus the bubbles', on its own scale) — whales and the rest pulling opposite ways is flagged (green above zero, red below).
            </p>
            <p>
              The strip at the right sums bubble buying / selling by price: where the big players traded. Yellow / violet lines are EMA 20 / 50.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

interface DebugPlanInput {
  view: WhaleView;
  plot: { left: number; right: number; top: number; bottom: number };
  bars: Candle[];
  trades: TerminalTrade[];
  bubbles: WhaleBubble[];
  netPoints: Array<{ t: number; whale: number; everyone: number }>;
  stepMs: number;
  t0: number | null;
  last: number | null;
  inNet: number;
  zonesOn: boolean;
}

function publishDebugPlan(input: DebugPlanInput): void {
  try {
    const { view, plot, bars, bubbles, netPoints, stepMs, t0, last, inNet, zonesOn } = input;
    const vp: PlanViewport = {
      plotLeft: plot.left,
      plotRight: plot.right,
      plotTop: plot.top,
      plotBottom: plot.bottom,
      priceMin: view.priceMin,
      priceMax: view.priceMax,
      start: view.start,
      end: view.end,
    };
    const drawn = clusterBubbles(bubbles, vp, t0);
    const { tags, labels } = planOverlays(drawn, vp, 3);
    const net = netForView(netPoints, vp);
    const visibleBars = bars.filter((b) => b.t + stepMs >= view.start && b.t <= view.end);
    const visibleCandles = visibleBars.length;
    const plotW = Math.max(1, plot.right - plot.left);
    const lastCandleEnd = visibleBars.length ? visibleBars[visibleBars.length - 1].t + stepMs : view.start;
    const rightPadPx = Math.max(0, ((view.end - lastCandleEnd) / Math.max(1, view.end - view.start)) * plotW);
    const lastCandleClose = visibleBars.length ? visibleBars[visibleBars.length - 1].c : null;
    const lastTradePrice = input.trades.length ? input.trades[input.trades.length - 1].price : last;
    const candleBandPct = (view.priceMax - view.priceMin) > 0
      ? 1 / (1 + 2 * 0.08)
      : 0;
    const maxRadius = drawn.reduce((m, d) => Math.max(m, d.r), 0);
    let overlapMaxFrac = 0;
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        const a = drawn[i];
        const b = drawn[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const sumR = a.r + b.r;
        if (dist < sumR) {
          const overlap = sumR - dist;
          const areaFrac = overlap / Math.max(1e-6, Math.min(a.r, b.r) * 2);
          overlapMaxFrac = Math.max(overlapMaxFrac, areaFrac);
        }
      }
    }
    const timeStep = Math.max(10 * stepMs, (view.end - view.start) / 12);
    const timeLabels = Math.max(0, Math.floor((view.end - view.start) / timeStep) + 1);
    const avgY = (() => {
      const iv = bubbles.filter((b) => b.t >= view.start && b.t <= view.end);
      let buyUsd = 0;
      let sellUsd = 0;
      let buySum = 0;
      let sellSum = 0;
      for (const b of iv) {
        buyUsd += b.buyUsd;
        sellUsd += b.sellUsd;
        buySum += b.buyUsd * b.price;
        sellSum += b.sellUsd * b.price;
      }
      const buyAvg = buyUsd > 0 ? buySum / buyUsd : null;
      const sellAvg = sellUsd > 0 ? sellSum / sellUsd : null;
      if (buyAvg === null || sellAvg === null) return null;
      const y0 = (buyAvg + sellAvg) / 2;
      const span = view.priceMax - view.priceMin;
      const minHalf = Math.max(4, (0.0005 * y0 / span) * (plot.bottom - plot.top));
      return { y0, halfPx: Math.min(30, Math.max(minHalf, Math.abs(buyAvg - sellAvg) / span * (plot.bottom - plot.top) / 2 + 3)) };
    })();
    const banHeightPx = avgY ? avgY.halfPx * 2 : 0;
    const plan = {
      view,
      plot,
      visibleCandles,
      rightPadPx,
      priceMin: view.priceMin,
      priceMax: view.priceMax,
      candleBandPct,
      lastCandleClose,
      lastTradePrice,
      seamPct: lastCandleClose && lastTradePrice ? Math.abs(lastCandleClose - lastTradePrice) / lastTradePrice * 100 : null,
      bubbleCount: drawn.length,
      maxRadius,
      overlapMaxFrac,
      tagCount: tags.length,
      tags,
      labels,
      netHeader: net.headerNet,
      readingNet: inNet,
      solidEnd: net.lastPoint ? net.lastPoint.whale : null,
      netLen: netPoints.length,
      netSum: netPoints.reduce((s, p) => s + p.whale, 0),
      timeLabelColor: '#6b7686',
      timeLabelsGe6: timeLabels >= 6,
      zonesOn,
      bandHeightPx: banHeightPx,
      barWidthPx: (plotW / Math.max(1, view.end - view.start)) * stepMs,
    };
    (window as unknown as { __whalesPlan?: unknown }).__whalesPlan = plan;
  } catch {
    /* debug hook must never break the chart */
  }
}

function visiblePocLevel(trades: readonly TerminalTrade[], start: number, end: number, priceMin: number, priceMax: number): number {
  let total = 0;
  for (const t of trades) {
    if (t.t < start || t.t > end) continue;
    if (t.price < priceMin || t.price > priceMax) continue;
    total += t.side === 'buy' ? t.usd : -t.usd;
  }
  return total;
}

function planFromContext(row: AssetRow | null, price: number | null): Array<{ kind: string; price: number; label: string; dash: number[]; color: string }> {
  const plan = buildPlanContext(row, price);
  if (!plan.hasSetup) return [];
  const out: Array<{ kind: string; price: number; label: string; dash: number[]; color: string }> = [];
  if (plan.buyAbove !== null) out.push({ kind: 'plan-buy', price: plan.buyAbove, label: `buy above ${fmtPrice(plan.buyAbove)}`, dash: [2, 4], color: '#4ade80' });
  if (plan.sellBelow !== null) out.push({ kind: 'plan-sell', price: plan.sellBelow, label: `sell below ${fmtPrice(plan.sellBelow)}`, dash: [2, 4], color: '#f87171' });
  for (const target of plan.targets.slice(0, 3)) out.push({ kind: 'plan-target', price: target, label: `target ${fmtPrice(target)}`, dash: [1, 7], color: 'rgba(74,222,128,0.5)' });
  if (plan.stop !== null) out.push({ kind: 'plan-stop', price: plan.stop, label: `stop ${fmtPrice(plan.stop)}`, dash: [1, 7], color: 'rgba(248,113,113,0.45)' });
  return out;
}
