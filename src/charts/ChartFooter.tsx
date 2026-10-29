import type { StreamStatus } from './types';
import { fmtUtc } from './format';

interface ChartFooterProps {
  status: StreamStatus;
  latencyMs: number | null;
  lastRestAt: number | null;
  bars: number;
  loading: boolean;
}

const STATUS_TEXT: Record<StreamStatus, string> = {
  connecting: 'CONNECTING',
  live: 'LIVE',
  reconnecting: 'RECONNECTING',
  offline: 'OFFLINE',
  error: 'ERROR',
};

export function ChartFooter({ status, latencyMs, lastRestAt, bars, loading }: ChartFooterProps) {
  const ready = status === 'live' && bars > 0 && !loading;
  return (
    <footer className="charts-footer">
      <span className="charts-footer-venue">BINANCE SPOT</span>
      <span className={`charts-footer-status${status === 'live' ? ' is-live' : ''}`}>
        {STATUS_TEXT[status]}
      </span>
      <span>latency {latencyMs === null ? '—' : `${latencyMs} ms`}</span>
      <span>{bars.toLocaleString('en-US')} bars</span>
      <span>REST {fmtUtc(lastRestAt)}</span>
      <span className="charts-footer-spacer" />
      <span className="charts-footer-hint">1–7 timeframe · Esc cancel draw</span>
      <span className={`charts-footer-ready${ready ? ' is-ready' : ''}`}>{ready ? 'READY' : 'WAIT'}</span>
    </footer>
  );
}
