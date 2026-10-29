import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Candle, TerminalInterval } from '../../shared/types';
import { visibleRangeStats } from '../lib/chartStats';
import { useKlineChart, type KlineChartApi } from '../hooks/useKlineChart';
import type {
  ChartType,
  CrosshairState,
  IndicatorConfig,
  ScaleType,
  SessionId,
  StreamStatus,
  VisibleRangeState,
} from './types';
import { fmtChange, fmtChartPrice, fmtQty, fmtSignedUsd, fmtUsd, fmtUtc } from './format';

interface ChartPaneProps {
  apiRef: MutableRefObject<KlineChartApi | null>;
  symbol: string;
  interval: TerminalInterval;
  data: Candle[];
  datasetKey: string;
  resetToken: number | null;
  chartType: ChartType;
  scale: ScaleType;
  indicators: IndicatorConfig[];
  sessions: Record<SessionId, boolean>;
  loading: boolean;
  error: string | null;
  status: StreamStatus;
  onRetry: () => void;
}

export function ChartPane({
  apiRef,
  symbol,
  interval,
  data,
  datasetKey,
  resetToken,
  chartType,
  scale,
  indicators,
  sessions,
  loading,
  error,
  status,
  onRetry,
}: ChartPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [crosshair, setCrosshair] = useState<CrosshairState>({ candle: null, index: null });
  const [visible, setVisible] = useState<VisibleRangeState>({ from: 0, to: 0 });
  const { api, ready } = useKlineChart({
    containerRef: hostRef,
    data,
    resetToken,
    datasetKey,
    chartType,
    scale,
    indicators,
    sessions,
    onCrosshair: setCrosshair,
    onVisibleRange: setVisible,
  });

  useEffect(() => {
    apiRef.current = api;
    return () => {
      if (apiRef.current === api) apiRef.current = null;
    };
  }, [api, apiRef]);

  const stats = useMemo(
    () => visibleRangeStats(data, visible.from, visible.to),
    [data, visible.from, visible.to],
  );
  const candle = crosshair.candle ?? data[data.length - 1] ?? null;
  const showEmpty = !loading && data.length === 0 && !error;
  const showError = Boolean(error) && data.length === 0;
  const reconnecting = status === 'reconnecting' || status === 'offline' || status === 'error';

  return (
    <section className="charts-pane" aria-label={`${symbol} ${interval} chart`}>
      <div ref={hostRef} className="charts-canvas" data-testid="chart-canvas" />

      <div className="charts-hud" aria-label="Visible range statistics">
        <span className="charts-hud-tag">VISIBLE</span>
        <span className="charts-hud-item">
          <b>Δ VOL</b> {fmtQty(stats.volumeQty, ' BTC')}
        </span>
        <span className="charts-hud-item">
          <b>CVD</b> {fmtSignedUsd(stats.cvdUsd)}
        </span>
        <span className="charts-hud-item">
          <b>POC</b> {fmtChartPrice(stats.poc)}
        </span>
      </div>

      {reconnecting && data.length > 0 && (
        <div className="charts-pane-notice" role="status">
          Feed reconnecting — showing the last received candles.
        </div>
      )}

      <div className="charts-readout" aria-live="off">
        <span className="charts-readout-symbol">{symbol.replace(/USDT$/, '')}/USDT</span>
        <span className="charts-readout-sep" aria-hidden="true">·</span>
        <span>{interval}</span>
        {candle ? (
          <>
            <span className="charts-readout-sep" aria-hidden="true">·</span>
            <span>O <b>{fmtChartPrice(candle.o)}</b></span>
            <span>H <b>{fmtChartPrice(candle.h)}</b></span>
            <span>L <b>{fmtChartPrice(candle.l)}</b></span>
            <span>C <b>{fmtChartPrice(candle.c)}</b></span>
            <span className={candle.c >= candle.o ? 'is-up' : 'is-down'}>{fmtChange(candle.o, candle.c)}</span>
            <span className="charts-readout-sep" aria-hidden="true">·</span>
            <span>Vol <b>{fmtUsd(candle.qv ?? candle.v * candle.c)}</b></span>
            <span className="charts-readout-time">{fmtUtc(candle.t)}</span>
          </>
        ) : (
          <span className="charts-readout-muted">waiting for candles</span>
        )}
      </div>

      {(loading || !ready) && data.length === 0 && !error && (
        <div className="charts-overlay">
          <span className="charts-spinner" aria-hidden="true" />
          <span>Loading Binance candles…</span>
        </div>
      )}

      {showError && (
        <div className="charts-overlay charts-overlay-error" role="alert">
          <strong>Could not load Binance candles.</strong>
          <span>{error}</span>
          <button type="button" onClick={onRetry}>Retry</button>
        </div>
      )}

      {showEmpty && (
        <div className="charts-overlay">
          <strong>No candles returned.</strong>
          <span>Try another market or timeframe.</span>
          <button type="button" onClick={onRetry}>Retry</button>
        </div>
      )}
    </section>
  );
}
