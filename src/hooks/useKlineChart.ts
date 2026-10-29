import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  ActionType,
  CandleType,
  LineType,
  TooltipShowRule,
  YAxisPosition,
  YAxisType,
  dispose,
  init,
  type Chart,
  type DeepPartial,
  type KLineData,
  type Styles,
} from 'klinecharts';
import type { Candle } from '../../shared/types';
import { registerChartExtensions } from '../charts/extensions';
import type {
  ChartType,
  CrosshairState,
  DrawingTool,
  IndicatorConfig,
  ScaleType,
  SessionId,
  VisibleRangeState,
} from '../charts/types';

const OVERLAY_BY_TOOL: Partial<Record<DrawingTool, string>> = {
  trend: 'segment',
  ray: 'horizontalRayLine',
  hline: 'horizontalStraightLine',
  rect: 'rectZone',
  fib: 'fibonacciLine',
  long: 'longPosition',
  short: 'shortPosition',
  text: 'textNote',
};

const MAIN_INDICATORS = ['EMA', 'SMA', 'BOLL', 'VWAP_CUSTOM', 'SESSION_BANDS'];
const PANE_INDICATORS = ['pane_rsi', 'pane_macd', 'pane_vol'];

const BASE_STYLES: DeepPartial<Styles> = {
  grid: {
    show: true,
    horizontal: { color: '#1a202b', size: 1, style: LineType.Solid, dashedValue: [2, 2] },
    vertical: { color: '#1a202b', size: 1, style: LineType.Solid, dashedValue: [2, 2] },
  },
  candle: {
    type: CandleType.CandleSolid,
    bar: {
      upColor: '#0ecb81',
      downColor: '#f6465d',
      noChangeColor: '#91a2b4',
      upBorderColor: '#0ecb81',
      downBorderColor: '#f6465d',
      noChangeBorderColor: '#91a2b4',
      upWickColor: '#0ecb81',
      downWickColor: '#f6465d',
      noChangeWickColor: '#91a2b4',
    },
    area: {
      lineSize: 1.5,
      lineColor: '#f0b90b',
      smooth: false,
      backgroundColor: 'rgba(240, 185, 11, 0.16)',
    },
    priceMark: {
      last: {
        show: true,
        text: { color: '#0b0e11', size: 10, family: 'ui-monospace, SFMono-Regular, Menlo, monospace', weight: 700 },
      },
    },
    tooltip: { showRule: TooltipShowRule.None },
  },
  indicator: {
    tooltip: { showRule: TooltipShowRule.None },
  },
  xAxis: {
    show: true,
    size: 24,
    axisLine: { color: '#1e222d', size: 1 },
    tickLine: { color: '#1e222d', size: 1, length: 3 },
    tickText: { color: '#6b7a90', size: 10, family: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  },
  yAxis: {
    show: true,
    size: 62,
    position: YAxisPosition.Right,
    type: YAxisType.Normal,
    axisLine: { color: '#1e222d', size: 1 },
    tickLine: { color: '#1e222d', size: 1, length: 3 },
    tickText: { color: '#6b7a90', size: 10, family: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  },
  separator: { size: 1, color: '#1e222d', fill: true, activeBackgroundColor: '#1e222d' },
  crosshair: {
    show: true,
    horizontal: {
      show: true,
      line: { color: '#5a6b82', size: 1, style: LineType.Dashed, dashedValue: [4, 4] },
      text: { color: '#e5eef7', size: 10, family: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
    },
    vertical: {
      show: true,
      line: { color: '#5a6b82', size: 1, style: LineType.Dashed, dashedValue: [4, 4] },
      text: { color: '#e5eef7', size: 10, family: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
    },
  },
};

export interface KlineChartApi {
  beginDraw: (tool: DrawingTool) => void;
  clearDrawings: () => void;
  scrollToRealtime: () => void;
}

export interface UseKlineChartOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  data: Candle[];
  resetToken: number | null;
  datasetKey: string;
  chartType: ChartType;
  scale: ScaleType;
  indicators: IndicatorConfig[];
  sessions: Record<SessionId, boolean>;
  onCrosshair: (state: CrosshairState) => void;
  onVisibleRange: (state: VisibleRangeState) => void;
}

function pricePrecision(price: number | undefined): number {
  if (price === undefined || !Number.isFinite(price)) return 2;
  if (price >= 1) return 2;
  if (price >= 0.01) return 4;
  return 6;
}

function toKLineData(candle: Candle): KLineData {
  return {
    timestamp: candle.t,
    open: candle.o,
    high: candle.h,
    low: candle.l,
    close: candle.c,
    volume: candle.v,
    turnover: candle.qv ?? candle.v * candle.c,
  };
}

function applyCandleStyle(chart: Chart, chartType: ChartType): void {
  if (chartType === 'line' || chartType === 'area') {
    chart.setStyles({
      candle: {
        type: CandleType.Area,
        area: {
          lineSize: 1.6,
          lineColor: chartType === 'area' ? '#f0b90b' : '#55c8ee',
          smooth: false,
          backgroundColor: chartType === 'area'
            ? [
              { offset: 0, color: 'rgba(240, 185, 11, 0.24)' },
              { offset: 0.65, color: 'rgba(240, 185, 11, 0.06)' },
              { offset: 1, color: 'rgba(240, 185, 11, 0)' },
            ]
            : 'transparent',
        },
      },
    });
    return;
  }
  chart.setStyles({ candle: { type: CandleType.CandleSolid } });
}

function applyScale(chart: Chart, scale: ScaleType): void {
  const type = scale === 'log' ? YAxisType.Log : scale === 'percent' ? YAxisType.Percentage : YAxisType.Normal;
  chart.setStyles({ yAxis: { type } });
}

function clearTrackedOverlays(chart: Chart, ids: Set<string>): void {
  chart.removeOverlay();
  for (const id of ids) chart.removeOverlay(id);
  ids.clear();
}

export function useKlineChart(options: UseKlineChartOptions): { api: KlineChartApi; ready: boolean } {
  const {
    containerRef,
    data,
    resetToken,
    datasetKey,
    chartType,
    scale,
    indicators,
    sessions,
    onCrosshair,
    onVisibleRange,
  } = options;
  const chartRef = useRef<Chart | null>(null);
  const dataRef = useRef<Candle[]>([]);
  const datasetRef = useRef('');
  const chartTypeRef = useRef<ChartType>(chartType);
  const resetRef = useRef<number | null>(null);
  const appliedRef = useRef(false);
  const overlayIdsRef = useRef<Set<string>>(new Set());
  const callbacksRef = useRef({ onCrosshair, onVisibleRange });
  const [ready, setReady] = useState(false);
  callbacksRef.current = { onCrosshair, onVisibleRange };

  useEffect(() => {
    registerChartExtensions();
    const element = containerRef.current;
    if (!element) return;
    const chart = init(element, {
      locale: 'en-US',
      timezone: 'UTC',
      styles: BASE_STYLES,
    });
    if (!chart) return;
    chartRef.current = chart;
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      (window as unknown as { __ofChart?: Chart }).__ofChart = chart;
    }
    chartTypeRef.current = chartType;
    applyCandleStyle(chart, chartType);
    applyScale(chart, scale);
    chart.setOffsetRightDistance(8);
    chart.setPriceVolumePrecision(2, 2);

    const crosshairHandler = (payload: unknown) => {
      const value = payload as { dataIndex?: number; kLineData?: { timestamp?: number } } | undefined;
      const index = typeof value?.dataIndex === 'number' && value.dataIndex >= 0 ? value.dataIndex : null;
      let candle = index === null ? null : dataRef.current[index] ?? null;
      if (!candle && value?.kLineData?.timestamp !== undefined) {
        candle = dataRef.current.find((item) => item.t === value.kLineData?.timestamp) ?? null;
      }
      callbacksRef.current.onCrosshair({ candle, index });
    };
    const visibleHandler = () => {
      callbacksRef.current.onVisibleRange(chart.getVisibleRange());
    };
    chart.subscribeAction(ActionType.OnCrosshairChange, crosshairHandler);
    chart.subscribeAction(ActionType.OnVisibleRangeChange, visibleHandler);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => chart.resize());
    observer?.observe(element);
    setReady(true);

    return () => {
      observer?.disconnect();
      chart.unsubscribeAction(ActionType.OnCrosshairChange, crosshairHandler);
      chart.unsubscribeAction(ActionType.OnVisibleRangeChange, visibleHandler);
      overlayIdsRef.current.clear();
      chartRef.current = null;
      appliedRef.current = false;
      dispose(chart);
    };
  }, [containerRef]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    chartTypeRef.current = chartType;
    applyCandleStyle(chart, chartType);
  }, [ready, chartType]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    applyScale(chart, scale);
  }, [ready, scale]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;

    if (datasetRef.current !== datasetKey) {
      clearTrackedOverlays(chart, overlayIdsRef.current);
      datasetRef.current = datasetKey;
      appliedRef.current = false;
    }

    const previous = dataRef.current;
    dataRef.current = data;
    if (data.length === 0) {
      chart.clearData();
      appliedRef.current = false;
      return;
    }

    const firstChanged = previous.length > 0 && data.length > 0 && previous[0]?.t !== data[0]?.t;
    const missedBars = previous.length > 0 && data.length - previous.length > 1;
    const rewound = previous.length > 0 && data[data.length - 1].t < previous[previous.length - 1].t;
    const shouldApply =
      !appliedRef.current ||
      chartTypeRef.current !== chartType ||
      resetRef.current !== resetToken ||
      firstChanged ||
      missedBars ||
      rewound;

    if (shouldApply) {
      chart.setPriceVolumePrecision(pricePrecision(data[data.length - 1]?.c), 2);
      chart.applyNewData(data.map(toKLineData), false);
      chartTypeRef.current = chartType;
      resetRef.current = resetToken;
      appliedRef.current = true;
      requestAnimationFrame(() => {
        chart.scrollToRealTime(0);
        callbacksRef.current.onVisibleRange(chart.getVisibleRange());
      });
      return;
    }

    chart.updateData(toKLineData(data[data.length - 1]));
  }, [ready, data, datasetKey, chartType, resetToken]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;

    for (const name of MAIN_INDICATORS) chart.removeIndicator('candle_pane', name);
    for (const paneId of PANE_INDICATORS) chart.removeIndicator(paneId);

    chart.createIndicator(
      { name: 'SESSION_BANDS', extendData: sessions },
      true,
      { id: 'candle_pane' },
    );

    for (const indicator of indicators) {
      if (!indicator.visible) continue;
      if (indicator.kind === 'EMA' || indicator.kind === 'SMA' || indicator.kind === 'BOLL') {
        chart.createIndicator(
          { name: indicator.kind, calcParams: indicator.params },
          true,
          { id: 'candle_pane' },
        );
        continue;
      }
      if (indicator.kind === 'VWAP') {
        chart.createIndicator({ name: 'VWAP_CUSTOM' }, true, { id: 'candle_pane' });
        continue;
      }
      if (indicator.kind === 'RSI') {
        chart.createIndicator(
          { name: 'RSI', calcParams: indicator.params },
          false,
          { id: 'pane_rsi', height: 110, minHeight: 76 },
        );
        continue;
      }
      if (indicator.kind === 'MACD') {
        chart.createIndicator(
          { name: 'MACD', calcParams: indicator.params },
          false,
          { id: 'pane_macd', height: 120, minHeight: 82 },
        );
        continue;
      }
      if (indicator.kind === 'VOL') {
        chart.createIndicator(
          { name: 'VOL', calcParams: indicator.params },
          false,
          { id: 'pane_vol', height: 100, minHeight: 70 },
        );
      }
    }
  }, [ready, indicators, sessions, datasetKey]);

  const beginDraw = useCallback((tool: DrawingTool) => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.removeOverlay();
    if (tool === 'cursor') return;
    const name = OVERLAY_BY_TOOL[tool];
    if (!name) return;
    let text = 'Note';
    if (tool === 'text') {
      const entered = window.prompt('Text note', '');
      if (!entered?.trim()) return;
      text = entered.trim();
    }
    const result = chart.createOverlay(
      tool === 'text' ? { name, extendData: { text } } : name,
    );
    if (typeof result === 'string') {
      overlayIdsRef.current.add(result);
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        (window as unknown as { __ofOverlayIds?: string[] }).__ofOverlayIds = [...overlayIdsRef.current];
      }
    }
  }, []);

  const clearDrawings = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    clearTrackedOverlays(chart, overlayIdsRef.current);
  }, []);

  const scrollToRealtime = useCallback(() => {
    chartRef.current?.scrollToRealTime(0);
  }, []);

  const api = useMemo<KlineChartApi>(
    () => ({ beginDraw, clearDrawings, scrollToRealtime }),
    [beginDraw, clearDrawings, scrollToRealtime],
  );

  return { api, ready };
}
