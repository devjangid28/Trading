import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Candle, TerminalInterval } from '../../shared/types';
import type { MarketMode } from '../components/ui';
import { useLivePrice } from '../lib/priceStore';
import { fmtPrice, fmtUsd, istClock } from '../lib/format';
import { estimateLiquidationLevels } from '../whales/engine';
import { RIGHT_PAD_PX, USER_LEVELS_KEY } from '../whales/tokens';
import { useVolCandles } from './store';
import { SessionVwapCache } from './sessions';
import {
  barFingerprint, binSizeFor, buildProfile, ProfileCache, rangeFingerprint, sessionLabel, thinIndices, timeframeLabel,
} from './profiles';
import { computeLayout, priceForY, tForX, xForT, yForPrice } from './layout';
import {
  barCapForProfile, drawVolOverlay, drawVolScene, profileRowAt, scaleForProfiles, type DrawState,
} from './render';
import { VolToolbar } from './toolbar';
import { RightPane } from './rightPane';
import {
  CANDLE_STEP_MS, DATA_RENDER_INTERVAL_MS, DEFAULT_SETTINGS, DRAWN_PROFILE_CAP,
  RANGE_EDGE_GRAB_PX, RANGE_TOP_BTN_R, VP_RANGES_KEY, VP_STORAGE_KEY,
} from './tokens';
import type {
  HoverState, LevelSpec, Profile, ProfileHit, VolRange, VolSettings, ViewState,
} from './types';
import './volprofile.css';

const signedUsd = (v: number): string => `${v >= 0 ? '+' : '−'}${fmtUsd(v)}`;

const TF_MS: Record<TerminalInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

interface VolProfileViewProps {
  symbol: string;
  timeframe: TerminalInterval;
  mode: MarketMode;
}

function loadSettings(): VolSettings {
  try {
    const raw = window.localStorage.getItem(VP_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<VolSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadRanges(): VolRange[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VP_RANGES_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is VolRange => (
        typeof r === 'object' && r !== null
        && typeof (r as VolRange).id === 'string'
        && Number.isFinite((r as VolRange).t0)
        && Number.isFinite((r as VolRange).t1)
      ))
      .map((r) => ({ id: r.id, t0: r.t0, t1: Math.max(r.t0, r.t1) }));
  } catch {
    return [];
  }
}

function loadUserLevels(): number[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(USER_LEVELS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0);
  } catch {
    return [];
  }
}

interface Payload {
  layout: ReturnType<typeof computeLayout>;
  view: ViewState;
  profiles: Profile[];
  paneProfiles: Profile[];
  scales: Map<string, number>;
  caps: Map<string, number>;
  sessions: ReturnType<SessionVwapCache['get']>;
  levels: LevelSpec[];
  source: string;
  count: number;
  lean: string;
}

interface DragState {
  kind: 'pan' | 'price' | 'select' | 'edgeL' | 'edgeR';
  id?: string;
  x0: number;
  y0: number;
  end?: number;
  span?: number;
  center?: number;
  pSpan?: number;
  t0?: number;
}

export function VolProfileView({ symbol, timeframe, mode }: VolProfileViewProps) {
  const mock = mode === 'MOCK';
  const data = useVolCandles(symbol, mock);
  const livePrice = useLivePrice(symbol);

  const [settings, setSettings] = useState<VolSettings>(loadSettings);
  const [settingsSanitized, setSettingsSanitized] = useState(false);
  useEffect(() => {
    if (settingsSanitized) return;
    const next: VolSettings = {
      ...settings,
      binSize: settings.binSize === 'auto' ? 'auto' : Number.isFinite(Number(settings.binSize)) && Number(settings.binSize) > 0 ? Number(settings.binSize) : 'auto',
      valueAreaPct: Number.isFinite(Number(settings.valueAreaPct)) ? Math.max(5, Math.min(100, Number(settings.valueAreaPct))) : 70,
      barOpacity: Number.isFinite(Number(settings.barOpacity)) ? Math.max(0.1, Math.min(1, Number(settings.barOpacity))) : 0.55,
    };
    if (next.binSize !== settings.binSize || next.valueAreaPct !== settings.valueAreaPct || next.barOpacity !== settings.barOpacity) {
      setSettings(next);
    }
    setSettingsSanitized(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);
  const [ranges, setRanges] = useState<VolRange[]>(loadRanges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0, cw: 0, ch: 0 });
  const [hover, setHover] = useState<HoverState | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    candle: { t: number; o: number; h: number; l: number; c: number; v: number; qv: number; buy: number; sell: number } | null;
    hit: ProfileHit | null;
  } | null>(null);
  const [dragSel, setDragSel] = useState<{ t0: number; t1: number } | null>(null);
  const [hoveredRange, setHoveredRange] = useState<VolRange | null>(null);
  const [userLevels, setUserLevels] = useState<number[]>(loadUserLevels);
  const [lean, setLean] = useState('WAIT');

  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dirtyRef = useRef(true);
  const interactiveDirtyRef = useRef(true);
  const lastPaintRef = useRef(0);
  const viewRef = useRef<ViewState>({ start: 0, end: 1, priceMin: 0, priceMax: 1 });
  const zoomRef = useRef<{ spanMs: number; endTs: number; priceScale: { center: number; span: number } | null; ready: boolean }>({
    spanMs: 0,
    endTs: 0,
    priceScale: null,
    ready: false,
  });
  const dragRef = useRef<DragState | null>(null);
  const hoverRef = useRef<HoverState | null>(null);
  const profileHitRef = useRef<ProfileHit | null>(null);
  const dragSelRef = useRef<{ t0: number; t1: number } | null>(null);
  const hoveredRangeRef = useRef<VolRange | null>(null);
  const payloadRef = useRef<Payload | null>(null);
  const vwapCacheRef = useRef<SessionVwapCache>(new SessionVwapCache());
  const profileCacheRef = useRef<ProfileCache>(new ProfileCache());
  const lastLeanRef = useRef('');
  const renderErrorLoggedRef = useRef(false);
  const lastHoverPosRef = useRef({ x: -1, y: -1 });
  const lastEmitKeyRef = useRef('');
  const sceneCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastSceneKeyRef = useRef('');

  const liveLast = livePrice ? livePrice.price : null;
  const stRef = useRef({ data, settings, ranges, selectedId, hover, dragSel, hoveredRange, userLevels, timeframe, liveLast });
  stRef.current = { data, settings, ranges, selectedId, hover, dragSel, hoveredRange, userLevels, timeframe, liveLast };

  useEffect(() => {
    try {
      window.localStorage.setItem(VP_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage optional */
    }
  }, [settings]);

  useEffect(() => {
    try {
      window.localStorage.setItem(VP_RANGES_KEY, JSON.stringify(ranges));
    } catch {
      /* storage optional */
    }
  }, [ranges]);

  useEffect(() => {
    try {
      window.localStorage.setItem(USER_LEVELS_KEY, JSON.stringify(userLevels));
    } catch {
      /* storage optional */
    }
  }, [userLevels]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => {
      const c = canvasRef.current;
      setSize({
        w: el.clientWidth,
        h: el.clientHeight,
        cw: c ? c.clientWidth : 0,
        ch: c ? c.clientHeight : 0,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const markInteractive = useCallback(() => {
    interactiveDirtyRef.current = true;
    dirtyRef.current = true;
  }, []);

  useEffect(() => {
    zoomRef.current = { spanMs: 0, endTs: 0, priceScale: null, ready: false };
    markInteractive();
  }, [symbol, timeframe, markInteractive]);

  useEffect(() => {
    dirtyRef.current = true;
  }, [settings, ranges, selectedId, hover, dragSel, hoveredRange, userLevels, data.candles, data.status, data.count, data.error, livePrice]);

  const updateSettings = useCallback((patch: Partial<VolSettings>) => {
    markInteractive();
    setSettings((prev) => ({ ...prev, ...patch }));
  }, [markInteractive]);

  const fitAll = useCallback(() => {
    const st = stRef.current;
    const candles = st.data.candles;
    if (!candles.length) return;
    const l = computeLayout(size.w, size.h);
    const pw = Math.max(1, l.plotRight - l.plotLeft);
    const first = candles[0].t;
    const last = candles[candles.length - 1].t;
    const spanMs = Math.max(10 * CANDLE_STEP_MS, last - first + 2 * CANDLE_STEP_MS);
    const endTs = last + CANDLE_STEP_MS + (RIGHT_PAD_PX / pw) * spanMs;
    zoomRef.current = { spanMs, endTs, priceScale: null, ready: true };
    markInteractive();
  }, [size, markInteractive]);

  useEffect(() => {
    if (size.w > 0 && data.candles.length > 0 && !zoomRef.current.ready) fitAll();
  }, [data.candles, size, fitAll]);

  const buildLevels = (
    candles: readonly Candle[],
    sessions: Payload['sessions'],
    levelsUser: number[],
    live: number | null,
  ): LevelSpec[] => {
    const lastClose = candles.length ? candles[candles.length - 1].c : null;
    const lastVwap = sessions.length
      ? sessions[sessions.length - 1].points[sessions[sessions.length - 1].points.length - 1]?.vwap ?? lastClose
      : lastClose;
    const avg = lastVwap ?? live ?? lastClose ?? 0;
    const liq = estimateLiquidationLevels(avg, 5);
    const out: LevelSpec[] = [];
    for (let i = 0; i < levelsUser.length; i++) {
      out.push({ id: `user-${i}`, kind: 'user', price: levelsUser[i], label: 'my level' });
    }
    if (Number.isFinite(avg) && avg > 0) {
      out.push({ id: 'ref', kind: 'ref', price: avg, label: '' });
    }
    if (liq.shorts > 0) {
      out.push({ id: 'liq-short', kind: 'liq-short', price: liq.shorts, label: 'shorts liquidate' });
    }
    if (liq.longs > 0) {
      out.push({ id: 'liq-long', kind: 'liq-long', price: liq.longs, label: 'longs liquidate' });
    }
    const lastPrice = live ?? lastClose ?? 0;
    if (Number.isFinite(lastPrice) && lastPrice > 0) {
      out.push({ id: 'last', kind: 'last', price: lastPrice, label: '' });
    }
    return out;
  };

  const computeLean = (candles: readonly Candle[], view: ViewState): string => {
    let buy = 0;
    let sell = 0;
    for (const c of candles) {
      if (c.t < view.start || c.t > view.end) continue;
      const tp = (c.h + c.l + c.c) / 3;
      const qv = c.qv && c.qv > 0 ? c.qv : c.v * tp;
      const b = c.takerBuyQuote && c.takerBuyQuote > 0 ? c.takerBuyQuote : 0;
      buy += b;
      sell += Math.max(0, qv - b);
    }
    const total = buy + sell;
    if (total <= 0 || Math.abs(buy - sell) / total < 0.05) return 'WAIT';
    return buy > sell ? 'BUY LEAN' : 'SELL LEAN';
  };

  const collectProfiles = useCallback((): { visible: Profile[]; pane: Profile[] } => {
    const st = stRef.current;
    const candles = st.data.candles;
    if (!candles.length) return { visible: [], pane: [] };
    const v = viewRef.current;
    const refPrice = candles[candles.length - 1].c;
    const bins = binSizeFor(st.settings.binSize, refPrice);
    const opts = { binSize: bins, valueAreaPct: st.settings.valueAreaPct };
    const cache = profileCacheRef.current;
    const kind = st.settings.profiles;

    if (kind === 'custom') {
      const pane = st.ranges
        .map((r) => cache.get(
          `custom:${r.id}:${bins.toFixed(4)}:${opts.valueAreaPct}`,
          rangeFingerprint(candles, r.t0, r.t1, true),
          () => buildProfile(candles, 'custom', '', r.t0, r.t1, 'right', opts),
        ))
        .sort((a, b) => b.t1 - a.t1);
      const visible = pane.filter((p) => p.t1 >= v.start && p.t0 <= v.end);
      return { visible, pane };
    }

    if (kind === 'session') {
      const sessions = vwapCacheRef.current.get(candles);
      const pane = sessions
        .map((s) => cache.get(
          `session:${s.t0}:${bins.toFixed(4)}:${opts.valueAreaPct}`,
          rangeFingerprint(candles, s.t0, s.t1, true),
          () => buildProfile(
            candles, 'session', sessionLabel(s.t0, s.t1), s.t0, s.t1, 'right', opts,
          ),
        ))
        .sort((a, b) => b.t1 - a.t1);
      const visible = pane.filter((p) => p.t1 >= v.start && p.t0 <= v.end);
      return { visible, pane };
    }

    const step = TF_MS[st.timeframe];
    const firstBar = Math.floor(v.start / step) * step;
    const lastBar = Math.floor(v.end / step) * step;
    const barTimes: number[] = [];
    for (let bt = firstBar; bt <= lastBar; bt += step) barTimes.push(bt);

    // Build only the thinned, drawn subset — never all visible bars. Each bar
    // is cached against its own fingerprint, so live ticks rebuild only the
    // forming bar instead of every bar in the window.
    const visible: Profile[] = [];
    for (const idx of thinIndices(barTimes.length, DRAWN_PROFILE_CAP)) {
      const bt = barTimes[idx];
      visible.push(cache.get(
        `tf:${bt}:${bins.toFixed(4)}:${opts.valueAreaPct}`,
        barFingerprint(candles, bt, step),
        () => buildProfile(candles, 'timeframe', timeframeLabel(bt), bt, bt + step, 'left', opts, false),
      ));
    }

    const pane: Profile[] = [];
    const lastT = candles[candles.length - 1].t;
    const paneCount = 24;
    for (let bt = Math.floor(lastT / step) * step; pane.length < paneCount && bt > 0; bt -= step) {
      pane.push(cache.get(
        `tf:${bt}:${bins.toFixed(4)}:${opts.valueAreaPct}`,
        barFingerprint(candles, bt, step),
        () => buildProfile(candles, 'timeframe', timeframeLabel(bt), bt, bt + step, 'left', opts, false),
      ));
    }
    pane.sort((a, b) => b.t1 - a.t1);
    return { visible, pane };
  }, [size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h || !size.cw || !size.ch) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // The canvas element is the plot+axis area (body minus pane/dock); the
    // backing store must match IT, not the full body, or the right edge where
    // profile anchors live gets scaled/clipped.
    const w = Math.round(size.cw * dpr);
    const h = Math.round(size.ch * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    const render = () => {
      raf = 0;
      const st = stRef.current;
      const l = computeLayout(size.w, size.h);
      const candles = st.data.candles;
      if (!candles.length) {
        ctx.clearRect(0, 0, l.axisRight, l.plotBottom + l.timeH);
        return;
      }
      if (!zoomRef.current.ready) {
        fitAll();
        return;
      }
      const zoom = zoomRef.current;
      const nowEdge = Date.now() + 5_000;
      const end = Math.min(zoom.endTs, nowEdge + (RIGHT_PAD_PX / Math.max(1, l.plotRight - l.plotLeft)) * zoom.spanMs);
      const start = end - zoom.spanMs;

      let priceMin = Infinity;
      let priceMax = -Infinity;
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        if (c.t + CANDLE_STEP_MS < start || c.t > end) continue;
        if (c.l < priceMin) priceMin = c.l;
        if (c.h > priceMax) priceMax = c.h;
      }
      if (!Number.isFinite(priceMin) || priceMin >= priceMax) {
        const last = candles[candles.length - 1].c;
        priceMin = last * 0.995;
        priceMax = last * 1.005;
      }
      const pad = (priceMax - priceMin) * 0.03;
      priceMin -= pad;
      priceMax += pad;
      const ps = zoom.priceScale;
      const finalMin = ps ? ps.center - ps.span / 2 : priceMin;
      const finalMax = ps ? ps.center + ps.span / 2 : priceMax;
      const view: ViewState = { start, end, priceMin: finalMin, priceMax: finalMax };
      viewRef.current = view;

      const sessions = vwapCacheRef.current.get(candles);
      const { visible, pane } = collectProfiles();
      const drawn = visible;
      const scales = scaleForProfiles(drawn, st.settings, view, st.selectedId);
      const caps = new Map<string, number>();
      for (const p of drawn) caps.set(p.id, barCapForProfile(p, view, l));
      const levels = buildLevels(candles, sessions, st.userLevels, st.liveLast);
      const source = st.data.status === 'loading' ? 'loading...' : st.data.status === 'cache' ? 'from the cache' : 'live';
      const lean = computeLean(candles, view);
      if (lean !== lastLeanRef.current) {
        lastLeanRef.current = lean;
        setLean(lean);
      }
      payloadRef.current = { layout: l, view, profiles: drawn, paneProfiles: pane, scales, caps, sessions, levels, source, count: st.data.count, lean };

      const hit = profileHitRef.current;
      let hitMarker: HoverState | null = null;
      if (hit && hoverRef.current) {
        hitMarker = {
          x: hoverRef.current.x,
          y: yForPrice(hit.row.price, view, l),
          price: hit.row.price,
          time: hoverRef.current.time,
        };
      }

      const ds: DrawState = {
        candles,
        view,
        profiles: drawn,
        sessions,
        levels,
        settings: st.settings,
        scales,
        caps,
        hover: hoverRef.current,
        profileHit: hitMarker,
        hoveredRange: st.hoveredRange,
        selRange: st.dragSel,
        customRanges: st.settings.profiles === 'custom' ? st.ranges : [],
        candleCount: st.data.count,
        source,
      };

      // Scene layer, cached until data/view/settings change.
      const lastC = candles[candles.length - 1];
      const sceneKey = [
        `${candles.length}:${lastC.t}:${lastC.h}:${lastC.l}:${lastC.c}`,
        st.settings.profiles, st.settings.mode, st.settings.delta, st.settings.atScale,
        st.settings.binSize, st.settings.valueAreaPct, st.settings.barOpacity.toFixed(3),
        st.settings.showVwapBands, st.settings.showPoc, st.settings.showVahVal,
        st.settings.colorRow, st.settings.colorAsk, st.settings.colorBid, st.settings.colorPoc,
        drawn.length, st.selectedId ?? '',
        Math.round(view.start / 2000), Math.round(view.end / 2000),
        Math.round(view.priceMin * 100), Math.round(view.priceMax * 100),
      ].join('|');

      try {
        let scene = sceneCanvasRef.current;
        if (!scene) {
          scene = document.createElement('canvas');
          sceneCanvasRef.current = scene;
        }
        if (scene.width !== w) {
          scene.width = w;
          scene.height = h;
        }
        const sctx = scene.getContext('2d');
        if (sctx && sceneKey !== lastSceneKeyRef.current) {
          sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawVolScene(sctx, l, ds);
          ctx.clearRect(0, 0, l.axisRight, l.plotBottom + l.timeH);
          ctx.drawImage(scene, 0, 0, l.axisRight, l.plotBottom + l.timeH);
          lastSceneKeyRef.current = sceneKey;
        }

        let overlay = overlayCanvasRef.current;
        if (!overlay) {
          overlay = document.createElement('canvas');
          overlayCanvasRef.current = overlay;
        }
        if (overlay.width !== w) {
          overlay.width = w;
          overlay.height = h;
        }
        const octx = overlay.getContext('2d');
        if (octx) {
          octx.setTransform(dpr, 0, 0, dpr, 0, 0);
          octx.clearRect(0, 0, l.axisRight, l.plotBottom + l.timeH);
          drawVolOverlay(octx, l, ds);
        }
      } catch (err) {
        if (!renderErrorLoggedRef.current) {
          renderErrorLoggedRef.current = true;
          console.error('[volprofile] render failed:', err);
        }
      }
      dirtyRef.current = false;
    };
    const loop = () => {
      if (document.hidden) {
        raf = window.requestAnimationFrame(loop);
        return;
      }
      const now = performance.now();
      if (dirtyRef.current && (interactiveDirtyRef.current || now - lastPaintRef.current >= DATA_RENDER_INTERVAL_MS)) {
        render();
        lastPaintRef.current = now;
        interactiveDirtyRef.current = false;
      }
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [size, collectProfiles, fitAll]);

  const pointerPos = (event: React.PointerEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const updateHover = (pos: { x: number; y: number } | null) => {
    if (!pos) {
      lastHoverPosRef.current = { x: -1, y: -1 };
      hoverRef.current = null;
      profileHitRef.current = null;
      setHover(null);
      setTooltip(null);
      markInteractive();
      return;
    }
    const lastPos = lastHoverPosRef.current;
    if (Math.abs(pos.x - lastPos.x) < 0.6 && Math.abs(pos.y - lastPos.y) < 0.6) return;
    lastHoverPosRef.current = { x: pos.x, y: pos.y };
    const pl = payloadRef.current;
    if (!pl) return;
    const { layout: l, view: v, profiles, scales, caps } = pl;
    if (pos.x < l.plotLeft || pos.x > l.plotRight || pos.y < l.plotTop || pos.y > l.plotBottom) {
      hoverRef.current = null;
      profileHitRef.current = null;
      setHover(null);
      setTooltip(null);
      markInteractive();
      return;
    }
    const time = tForX(pos.x, v, l);
    const price = priceForY(pos.y, v, l);
    const bucket = Math.floor(time / CANDLE_STEP_MS) * CANDLE_STEP_MS;
    const st = stRef.current;
    const candleRaw = st.data.candles.find((c) => c.t === bucket) ?? null;
    const candle = candleRaw
      ? {
        t: candleRaw.t,
        o: candleRaw.o,
        h: candleRaw.h,
        l: candleRaw.l,
        c: candleRaw.c,
        v: candleRaw.v,
        qv: candleRaw.qv ?? candleRaw.v * ((candleRaw.h + candleRaw.l + candleRaw.c) / 3),
        buy: candleRaw.takerBuyQuote ?? 0,
        sell: Math.max(0, (candleRaw.qv ?? candleRaw.v * ((candleRaw.h + candleRaw.l + candleRaw.c) / 3)) - (candleRaw.takerBuyQuote ?? 0)),
      }
      : null;
    const hit = profileRowAt(l, v, profiles, scales, caps, pos.x, pos.y);
    hoverRef.current = { x: pos.x, y: pos.y, price, time };
    profileHitRef.current = hit;
    // React state only when the hovered candle/bin changes; the canvas reads the
    // refs, so tiny moves repaint without re-rendering React.
    const emitKey = `${Math.round(pos.x / 2)}:${Math.round(pos.y / 2)}:${bucket}:${hit ? hit.row.index : '-'}`;
    if (emitKey !== lastEmitKeyRef.current) {
      lastEmitKeyRef.current = emitKey;
      setHover({ x: pos.x, y: pos.y, price, time });
      setTooltip({ x: pos.x, y: pos.y, candle, hit });
    }
    markInteractive();
  };

  const hitHandle = (
    x: number,
    y: number,
    l: ReturnType<typeof computeLayout>,
    v: ViewState,
  ): { kind: 'delete' | 'edgeL' | 'edgeR'; id: string } | null => {
    const st = stRef.current;
    for (const r of st.ranges) {
      const x0 = xForT(r.t0, v, l);
      const x1 = xForT(r.t1, v, l);
      if (x1 < l.plotLeft || x0 > l.plotRight) continue;
      const mid = (x0 + x1) / 2;
      const dTop = Math.hypot(x - mid, y - (l.plotTop + 12));
      if (dTop <= RANGE_TOP_BTN_R) return { kind: 'delete', id: r.id };
      if (Math.abs(x - x0) <= RANGE_EDGE_GRAB_PX) return { kind: 'edgeL', id: r.id };
      if (Math.abs(x - x1) <= RANGE_EDGE_GRAB_PX) return { kind: 'edgeR', id: r.id };
    }
    return null;
  };

  const resizeEdge = (id: string, kind: 'edgeL' | 'edgeR', x: number) => {
    const pl = payloadRef.current;
    if (!pl) return;
    const step = CANDLE_STEP_MS;
    const t = Math.floor(tForX(x, pl.view, pl.layout) / step) * step;
    setRanges((prev) => prev.map((r) => {
      if (r.id !== id) return r;
      if (kind === 'edgeL') return { ...r, t0: Math.min(t, r.t1 - step) };
      return { ...r, t1: Math.max(t, r.t0 + step) };
    }));
    markInteractive();
  };

  const commitSelect = () => {
    const sel = dragSelRef.current;
    if (!sel) return;
    const t0 = Math.min(sel.t0, sel.t1);
    const t1 = Math.max(sel.t0, sel.t1);
    if (t1 - t0 < CANDLE_STEP_MS) {
      dragSelRef.current = null;
      setDragSel(null);
      return;
    }
    const id = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const next = [...stRef.current.ranges, { id, t0, t1 }];
    setRanges(next);
    dragSelRef.current = null;
    setDragSel(null);
    markInteractive();
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const pos = pointerPos(event);
    if (!pos) return;
    const l = computeLayout(size.w, size.h);
    const v = viewRef.current;
    const inPlot = pos.x >= l.plotLeft && pos.x <= l.plotRight && pos.y >= l.plotTop && pos.y <= l.plotBottom;
    event.currentTarget.setPointerCapture(event.pointerId);
    markInteractive();

    if (inPlot) {
      if (stRef.current.settings.profiles === 'custom' && event.shiftKey) {
        const t0 = Math.floor(tForX(pos.x, v, l) / CANDLE_STEP_MS) * CANDLE_STEP_MS;
        dragRef.current = { kind: 'select', x0: pos.x, y0: pos.y, t0 };
        dragSelRef.current = { t0, t1: t0 };
        setDragSel({ t0, t1: t0 });
        return;
      }
      if (stRef.current.settings.profiles === 'custom') {
        const handle = hitHandle(pos.x, pos.y, l, v);
        if (handle) {
          if (handle.kind === 'delete') {
            setRanges((prev) => prev.filter((r) => r.id !== handle.id));
            return;
          }
          dragRef.current = { kind: handle.kind, id: handle.id, x0: pos.x, y0: pos.y };
          return;
        }
      }
      if (event.ctrlKey || pos.x >= l.axisLeft) {
        dragRef.current = {
          kind: 'price',
          x0: pos.x,
          y0: pos.y,
          center: (v.priceMin + v.priceMax) / 2,
          pSpan: v.priceMax - v.priceMin,
        };
        return;
      }
      dragRef.current = { kind: 'pan', x0: pos.x, y0: pos.y, end: v.end, span: v.end - v.start };
      return;
    }
    if (pos.x >= l.axisLeft && pos.x <= l.axisRight) {
      dragRef.current = {
        kind: 'price',
        x0: pos.x,
        y0: pos.y,
        center: (v.priceMin + v.priceMax) / 2,
        pSpan: v.priceMax - v.priceMin,
      };
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const pos = pointerPos(event);
    const drag = dragRef.current;
    if (drag && pos) {
      const l = computeLayout(size.w, size.h);
      const v = viewRef.current;
      const pw = Math.max(1, l.plotRight - l.plotLeft);
      const ph = Math.max(1, l.plotBottom - l.plotTop);
      const zoom = zoomRef.current;
      if (drag.kind === 'pan') {
        const span = drag.span ?? (v.end - v.start);
        const maxEnd = Date.now() + 5_000 + (RIGHT_PAD_PX / pw) * span;
        const minStart = v.start - span;
        const dx = pos.x - drag.x0;
        const newEnd = (drag.end ?? v.end) - (dx / pw) * span;
        zoom.endTs = Math.max(minStart + span, Math.min(maxEnd, newEnd));
        zoom.spanMs = span;
        markInteractive();
      } else if (drag.kind === 'price') {
        const span = drag.pSpan ?? (v.priceMax - v.priceMin);
        const dy = pos.y - drag.y0;
        const center = (drag.center ?? (v.priceMin + v.priceMax) / 2) + (dy / ph) * span;
        zoom.priceScale = { center, span };
        markInteractive();
      } else if (drag.kind === 'select') {
        const t1 = Math.floor(tForX(pos.x, v, l) / CANDLE_STEP_MS) * CANDLE_STEP_MS;
        const t0 = drag.t0 ?? t1;
        const prev = dragSelRef.current;
        if (!prev || prev.t0 !== t0 || prev.t1 !== t1) {
          dragSelRef.current = { t0, t1 };
          setDragSel({ t0, t1 });
          markInteractive();
        }
      } else if (drag.kind === 'edgeL' || drag.kind === 'edgeR') {
        if (drag.id) resizeEdge(drag.id, drag.kind, pos.x);
      }
    }
    updateHover(pos);
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const drag = dragRef.current;
    if (drag && drag.kind === 'select') commitSelect();
    dragRef.current = null;
  };

  const onPointerLeave = () => updateHover(null);

  const onDoubleClick = () => {
    markInteractive();
    fitAll();
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const pos = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const l = computeLayout(size.w, size.h);
      const v = viewRef.current;
      const pw = Math.max(1, l.plotRight - l.plotLeft);
      if (pos.x < l.plotLeft || pos.x > l.plotRight) return;
      event.preventDefault();
      const anchorTime = tForX(pos.x, v, l);
      const factor = event.deltaY > 0 ? 1.12 : 1 / 1.12;
      const zoom = zoomRef.current;
      const fullSpan = zoom.spanMs || (v.end - v.start);
      const nextSpan = Math.max(10 * CANDLE_STEP_MS, Math.min(14 * 24 * 3_600_000, fullSpan * factor));
      const ratio = (pos.x - l.plotLeft) / pw;
      const nextEnd = anchorTime + (1 - ratio) * nextSpan;
      const maxEnd = Date.now() + 5_000 + (RIGHT_PAD_PX / pw) * nextSpan;
      const minStart = v.start - (v.end - v.start) - nextSpan;
      zoom.spanMs = nextSpan;
      zoom.endTs = Math.max(minStart + nextSpan, Math.min(maxEnd, nextEnd));
      markInteractive();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [size, markInteractive]);

  const onContextMenu = (event: React.MouseEvent) => {
    const pos = pointerPos(event as unknown as React.PointerEvent);
    if (!pos) return;
    const l = computeLayout(size.w, size.h);
    const v = viewRef.current;
    if (pos.x < l.plotLeft || pos.x > l.plotRight || pos.y < l.plotTop || pos.y > l.plotBottom) return;
    event.preventDefault();
    markInteractive();
    const price = priceForY(pos.y, v, l);
    const snapped = Math.round(price * 100) / 100;
    setUserLevels((prev) => {
      const exists = prev.some((p) => Math.abs(p - snapped) < 0.005);
      return exists ? prev.filter((p) => Math.abs(p - snapped) >= 0.005) : [...prev, snapped].sort((a, b) => a - b);
    });
  };

  const tooltipPos = (() => {
    if (!tooltip || !size.w || !size.h) return null;
    const w = 270;
    const h = 150;
    const x = Math.min(size.w - w - 8, Math.max(8, tooltip.x + 14));
    const y = tooltip.y + 28 > size.h - h ? Math.max(8, tooltip.y - h - 14) : tooltip.y + 14;
    return { left: x, top: y };
  })();

  const paneProfiles = useMemo(
    () => payloadRef.current?.paneProfiles ?? [],
    [ranges, selectedId, settings.profiles, settings.binSize, settings.valueAreaPct, data.candles, data.status],
  );

  const hintVisible = settings.profiles === 'custom' && ranges.length === 0 && data.count > 0;

  return (
    <section className="vp-view" aria-label="Volume profile chart">
      <VolToolbar settings={settings} onSettings={updateSettings} mock={mock} />
      <div className="vp-body" ref={hostRef}>
        <div className="vp-canvas-wrap">
          <canvas
            ref={canvasRef}
            className="vp-canvas"
            tabIndex={0}
            aria-label="1m candles with volume profiles, session VWAP and overlay levels"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerLeave}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
          />
          <canvas ref={overlayCanvasRef} className="vp-canvas vp-overlay" aria-hidden="true" />
        </div>

        {hintVisible && (
          <div className="vp-hint" role="note">
            Shift+drag across the chart to pick a time range - a profile is built for it
          </div>
        )}

        {data.count === 0 && !data.error && (
          <div className="vp-loading">{data.status === 'loading' ? 'Loading 1m candles…' : 'No candles yet'}</div>
        )}
        {data.count === 0 && data.error && (
          <div className="vp-loading is-error">
            <strong>No candles</strong>
            <span>{data.error}</span>
            <button type="button" className="vp-retry" onClick={() => data.refresh()}>Retry</button>
          </div>
        )}

        {tooltip && tooltipPos && (
          <div className="vp-tooltip" style={{ left: tooltipPos.left, top: tooltipPos.top }}>
            {tooltip.candle && (
              <>
                <div className="vp-tt-line">{istClock(tooltip.candle.t)}</div>
                <div className="vp-tt-line">
                  O {fmtPrice(tooltip.candle.o)} · H {fmtPrice(tooltip.candle.h)} · L {fmtPrice(tooltip.candle.l)} · C {fmtPrice(tooltip.candle.c)}
                </div>
                <div className="vp-tt-line">
                  vol {fmtUsd(tooltip.candle.qv)} · {tooltip.candle.v.toFixed(4)} BTC
                </div>
                <div className="vp-tt-line">
                  <span className="is-up">buy {fmtUsd(tooltip.candle.buy)}</span>
                  <span className="vp-tt-sep">/</span>
                  <span className="is-down">sell {fmtUsd(tooltip.candle.sell)}</span>
                  <span className="vp-tt-sep">·</span>
                  <span className={tooltip.candle.buy - tooltip.candle.sell >= 0 ? 'is-up' : 'is-down'}>
                    Δ {signedUsd(tooltip.candle.buy - tooltip.candle.sell)}
                  </span>
                </div>
              </>
            )}
            {tooltip.hit && (
              <>
                <div className="vp-tt-line vp-tt-title">profile bin {fmtPrice(tooltip.hit.row.price)}</div>
                <div className="vp-tt-line">
                  vol {fmtUsd(tooltip.hit.row.vol)} · {tooltip.hit.row.base.toFixed(4)} BTC
                </div>
                <div className="vp-tt-line">
                  {settings.mode === 'bidask' ? (
                    <>
                      <span className="is-up">ask {fmtUsd(tooltip.hit.row.buy)}</span>
                      <span className="vp-tt-sep">/</span>
                      <span className="is-down">bid {fmtUsd(tooltip.hit.row.sell)}</span>
                    </>
                  ) : (
                    <>
                      <span className="is-up">buy {fmtUsd(tooltip.hit.row.buy)}</span>
                      <span className="vp-tt-sep">/</span>
                      <span className="is-down">sell {fmtUsd(tooltip.hit.row.sell)}</span>
                    </>
                  )}
                </div>
                <div className="vp-tt-line">
                  <span className={tooltip.hit.row.delta >= 0 ? 'is-up' : 'is-down'}>
                    delta {signedUsd(tooltip.hit.row.delta)}
                  </span>
                  <span className="vp-tt-sep">·</span>
                  <span>
                    {tooltip.hit.profile.totalUsd > 0
                      ? ((tooltip.hit.row.vol / tooltip.hit.profile.totalUsd) * 100).toFixed(1)
                      : '0'}% of profile
                  </span>
                </div>
              </>
            )}
            {!tooltip.candle && !tooltip.hit && <div className="vp-tt-line">hover a candle or profile row</div>}
          </div>
        )}

        <RightPane
          profiles={paneProfiles}
          selectedId={selectedId}
          onSelect={(id) => { markInteractive(); setSelectedId(id); }}
          onHover={(p) => {
            const range = p && settings.profiles === 'custom'
              ? stRef.current.ranges.find((r) => Math.abs(r.t0 - p.t0) < 1 && Math.abs(r.t1 - p.t1) < 1) ?? null
              : null;
            hoveredRangeRef.current = range;
            setHoveredRange(range);
            markInteractive();
          }}
          empty={settings.profiles === 'custom' && ranges.length === 0}
        />

        <aside className="vp-dock" aria-label="Panel lean">
          <span className={`vp-dock-text is-${lean === 'BUY LEAN' ? 'buy' : lean === 'SELL LEAN' ? 'sell' : 'wait'}`}>
            {lean}
          </span>
        </aside>
      </div>
    </section>
  );
}
