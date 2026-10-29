import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeHeikinAshi } from '../lib/binance';
import { useBinanceMarket } from '../hooks/useBinanceMarket';
import type { KlineChartApi } from '../hooks/useKlineChart';
import { ChartFooter } from './ChartFooter';
import { ChartPane } from './ChartPane';
import { ChartSidebar } from './ChartSidebar';
import { ChartToolbar } from './ChartToolbar';
import { ChartTopBar } from './ChartTopBar';
import { TimeframeBar } from './TimeframeBar';
import {
  CHART_INTERVALS,
  type ChartInterval,
  type ChartSettings,
  type ChartType,
  type DrawingTool,
  type IndicatorKind,
  type ScaleType,
  type SessionId,
  type SidebarTab,
} from './types';
import { loadChartSettings, makeIndicator, saveChartSettings } from './settings';
import './charts.css';

interface ChartsTerminalProps {
  symbol: string;
  onSymbol: (symbol: string) => void;
}

export function ChartsTerminal({ symbol, onSymbol }: ChartsTerminalProps) {
  const [settings, setSettings] = useState<ChartSettings>(() => {
    const stored = loadChartSettings(typeof window === 'undefined' ? null : window.localStorage);
    return symbol ? { ...stored, symbol } : stored;
  });
  const [activeTool, setActiveTool] = useState<DrawingTool>('cursor');
  const [fullscreen, setFullscreen] = useState(false);
  const apiRef = useRef<KlineChartApi | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const market = useBinanceMarket(settings.symbol, settings.interval);

  useEffect(() => {
    saveChartSettings(settings);
  }, [settings]);

  useEffect(() => {
    onSymbol(settings.symbol);
  }, [settings.symbol, onSymbol]);

  useEffect(() => {
    if (!symbol || symbol === settings.symbol) return;
    setSettings((current) => ({ ...current, symbol }));
  }, [symbol, settings.symbol]);

  useEffect(() => {
    document.body.classList.toggle('terminal-fs', fullscreen);
    return () => document.body.classList.remove('terminal-fs');
  }, [fullscreen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') {
        if (fullscreen) {
          setFullscreen(false);
          return;
        }
        if (activeTool !== 'cursor') {
          setActiveTool('cursor');
          apiRef.current?.beginDraw('cursor');
        }
        return;
      }
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < CHART_INTERVALS.length) {
        event.preventDefault();
        const interval = CHART_INTERVALS[index];
        setSettings((current) => ({ ...current, interval }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTool, fullscreen]);

  const setInterval = useCallback((interval: ChartInterval) => {
    setSettings((current) => ({ ...current, interval }));
  }, []);

  const setChartType = useCallback((chartType: ChartType) => {
    setSettings((current) => ({ ...current, chartType }));
  }, []);

  const setScale = useCallback((scale: ScaleType) => {
    setSettings((current) => ({ ...current, scale }));
  }, []);

  const toggleIndicator = useCallback((kind: IndicatorKind) => {
    setSettings((current) => {
      const existing = current.indicators.find((indicator) => indicator.kind === kind);
      if (existing) {
        return {
          ...current,
          indicators: current.indicators.map((indicator) =>
            indicator.kind === kind ? { ...indicator, visible: !indicator.visible } : indicator,
          ),
        };
      }
      return { ...current, indicators: [...current.indicators, makeIndicator(kind)] };
    });
  }, []);

  const removeIndicator = useCallback((kind: IndicatorKind) => {
    setSettings((current) => ({
      ...current,
      indicators: current.indicators.filter((indicator) => indicator.kind !== kind),
    }));
  }, []);

  const updateIndicatorParams = useCallback((kind: IndicatorKind, params: number[]) => {
    setSettings((current) => ({
      ...current,
      indicators: current.indicators.map((indicator) =>
        indicator.kind === kind ? { ...indicator, params } : indicator,
      ),
    }));
  }, []);

  const toggleSession = useCallback((session: SessionId) => {
    setSettings((current) => ({
      ...current,
      sessions: { ...current.sessions, [session]: !current.sessions[session] },
    }));
  }, []);

  const setSidebarTab = useCallback((sidebarTab: SidebarTab) => {
    setSettings((current) => ({ ...current, sidebarTab }));
  }, []);

  const toggleSidebar = useCallback(() => {
    setSettings((current) => ({ ...current, sidebarOpen: !current.sidebarOpen }));
  }, []);

  const selectTool = useCallback((tool: DrawingTool) => {
    setActiveTool(tool);
    apiRef.current?.beginDraw(tool);
  }, []);

  const clearDrawings = useCallback(() => {
    setActiveTool('cursor');
    apiRef.current?.clearDrawings();
  }, []);

  const scrollToRealtime = useCallback(() => {
    apiRef.current?.scrollToRealtime();
  }, []);

  const changeSymbol = useCallback((next: string) => {
    setSettings((current) => ({ ...current, symbol: next.toUpperCase() }));
  }, []);

  const chartData = useMemo(
    () => (settings.chartType === 'heikin' ? computeHeikinAshi(market.bars) : market.bars),
    [settings.chartType, market.bars],
  );
  const datasetKey = `${settings.symbol}|${settings.interval}`;

  return (
    <div
      ref={shellRef}
      className={`terminal-shell charts-shell${fullscreen ? ' is-fullscreen' : ''}`}
    >
      <ChartTopBar
        symbol={settings.symbol}
        onSymbol={changeSymbol}
        ticker={market.ticker}
        status={market.status}
        latencyMs={market.latencyMs}
      />
      <TimeframeBar interval={settings.interval} onInterval={setInterval} />
      <ChartToolbar
        settings={settings}
        activeTool={activeTool}
        fullscreen={fullscreen}
        onChartType={setChartType}
        onScale={setScale}
        onToggleIndicator={toggleIndicator}
        onRemoveIndicator={removeIndicator}
        onIndicatorParams={updateIndicatorParams}
        onSession={toggleSession}
        onTool={selectTool}
        onClear={clearDrawings}
        onFullscreen={() => setFullscreen((value) => !value)}
        onScrollToRealtime={scrollToRealtime}
      />
      <div className="charts-body">
        <ChartPane
          apiRef={apiRef}
          symbol={settings.symbol}
          interval={settings.interval}
          data={chartData}
          datasetKey={datasetKey}
          resetToken={market.lastRestAt}
          chartType={settings.chartType}
          scale={settings.scale}
          indicators={settings.indicators}
          sessions={settings.sessions}
          loading={market.loading}
          error={market.error}
          status={market.status}
          onRetry={market.reload}
        />
        <ChartSidebar
          symbol={settings.symbol}
          tab={settings.sidebarTab}
          open={settings.sidebarOpen}
          ticker={market.ticker}
          onTab={setSidebarTab}
          onToggle={toggleSidebar}
        />
      </div>
      <ChartFooter
        status={market.status}
        latencyMs={market.latencyMs}
        lastRestAt={market.lastRestAt}
        bars={market.bars.length}
        loading={market.loading}
      />
    </div>
  );
}
