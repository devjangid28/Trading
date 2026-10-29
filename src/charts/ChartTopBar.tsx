import { useEffect, useRef, useState } from 'react';
import type { StreamStatus, TickerSnapshot } from './types';
import { fmtChartPrice, fmtPct, fmtSpread } from './format';

const SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
];

const STATUS_LABEL: Record<StreamStatus, string> = {
  connecting: 'CONNECTING',
  live: 'LIVE',
  reconnecting: 'RECONNECTING',
  offline: 'OFFLINE',
  error: 'FEED ERROR',
};

interface ChartTopBarProps {
  symbol: string;
  onSymbol: (symbol: string) => void;
  ticker: TickerSnapshot;
  status: StreamStatus;
  latencyMs: number | null;
}

export function ChartTopBar({ symbol, onSymbol, ticker, status, latencyMs }: ChartTopBarProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const base = symbol.replace(/USDT$/, '');
  const live = status === 'live';

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    if (ticker.direction === 'flat') return;
    setFlash(ticker.direction);
    const timer = setTimeout(() => setFlash(null), 300);
    return () => clearTimeout(timer);
  }, [ticker.price, ticker.direction]);

  const pick = (value: string) => {
    const next = value.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,20}$/.test(next)) return;
    onSymbol(next.endsWith('USDT') ? next : `${next}USDT`);
    setCustom('');
    setOpen(false);
  };

  return (
    <header className="charts-topbar">
      <div className="charts-brand" aria-label="OrderFlow charts">
        <span className="charts-brand-mark" aria-hidden="true">OF</span>
        <span className="charts-brand-name">OrderFlow</span>
        <span className="charts-beta">BETA</span>
      </div>

      <div className="charts-symbol" ref={wrapRef}>
        <button
          type="button"
          className="charts-symbol-button"
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="charts-symbol-base">{base}</span>
          <span className="charts-symbol-quote">/USDT</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {open && (
          <div className="charts-symbol-menu" role="listbox" aria-label="Select market">
            {SYMBOLS.map((option) => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={option === symbol}
                className={`charts-symbol-option${option === symbol ? ' is-active' : ''}`}
                onClick={() => pick(option)}
              >
                <span>{option.replace(/USDT$/, '')}</span>
                <span className="charts-symbol-option-quote">/USDT</span>
              </button>
            ))}
            <form
              className="charts-symbol-custom"
              onSubmit={(event) => {
                event.preventDefault();
                pick(custom);
              }}
            >
              <input
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                placeholder="Other, e.g. LINKUSDT"
                aria-label="Custom market symbol"
              />
              <button type="submit">Load</button>
            </form>
          </div>
        )}
      </div>

      <div className="charts-live-price">
        <span className={`charts-live-value${flash ? ` is-${flash}` : ''}`}>
          {fmtChartPrice(ticker.price)}
        </span>
        <span className={`charts-live-change${ticker.changePct === null ? '' : ticker.changePct >= 0 ? ' is-up' : ' is-down'}`}>
          {ticker.changePct === null ? '—' : fmtPct(ticker.changePct)}
        </span>
      </div>

      <div className="charts-quote-strip">
        <span>Bid <b>{fmtChartPrice(ticker.bid)}</b></span>
        <span>Ask <b>{fmtChartPrice(ticker.ask)}</b></span>
        <span className="charts-spread">{fmtSpread(ticker.bid, ticker.ask, ticker.price)}</span>
      </div>

      <div className="charts-topbar-spacer" />

      <div className={`charts-feed-status${live ? ' is-live' : ' is-warn'}`}>
        <span className="charts-feed-dot" aria-hidden="true" />
        <span>{STATUS_LABEL[status]}</span>
        <span className="charts-feed-venue">BINANCE</span>
        <span className="charts-feed-latency">{latencyMs === null ? '— ms' : `${latencyMs} ms`}</span>
      </div>
    </header>
  );
}
