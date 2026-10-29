import type { DerivRow, LiqEvent, MacroState, NewsFeed } from '../../shared/types';
import { isUnavailable } from '../../shared/types';
import { api, usePolling } from '../lib/api';
import { fmtAge, fmtPct, fmtUsd } from '../lib/format';
import type { SidebarTab, TickerSnapshot } from './types';
import { SIDEBAR_TABS } from './types';
import { fmtChartPrice, fmtSignedUsd } from './format';

interface DerivPayload {
  rows: DerivRow[];
  asOf: number;
  source: 'binance-futures' | 'bybit-linear' | null;
  unavailable: string | null;
}

async function fetchDerivatives(signal?: AbortSignal): Promise<DerivPayload> {
  const response = await fetch('/api/derivatives', { signal });
  if (!response.ok) throw new Error(`Derivatives HTTP ${response.status}`);
  return response.json() as Promise<DerivPayload>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' | 'warn' }) {
  return (
    <div className="charts-metric">
      <span>{label}</span>
      <b className={tone ? `is-${tone}` : undefined}>{value}</b>
    </div>
  );
}

function SidebarMessage({ children }: { children: React.ReactNode }) {
  return <p className="charts-sidebar-message">{children}</p>;
}

function WhalesPanel({ symbol, enabled }: { symbol: string; enabled: boolean }) {
  const liq = usePolling<{ recent: LiqEvent[]; note: string; asOf: number }>(
    (signal) => api.liquidations(symbol, signal),
    15_000,
    [symbol],
    enabled,
  );
  if (liq.loading && !liq.data) return <SidebarMessage>Reading liquidation prints…</SidebarMessage>;
  if (liq.error && !liq.data) return <SidebarMessage>{liq.error}</SidebarMessage>;
  if (!liq.data) return <SidebarMessage>No liquidation feed yet.</SidebarMessage>;
  if (liq.data.recent.length === 0) {
    return <SidebarMessage>{liq.data.note || 'No forced orders in the current window.'}</SidebarMessage>;
  }
  return (
    <div className="charts-liq-list">
      {liq.data.recent.slice(0, 14).map((event, index) => (
        <div className="charts-liq-row" key={`${event.t}-${event.symbol}-${index}`}>
          <span className={`charts-liq-side${event.side === 'SELL' ? ' is-down' : ' is-up'}`}>
            {event.side === 'SELL' ? 'LONG' : 'SHORT'}
          </span>
          <span className="charts-liq-usd">{fmtUsd(event.usd)}</span>
          <span className="charts-liq-symbol">{event.symbol.replace(/USDT$/, '')}</span>
          <span className="charts-liq-price">{fmtChartPrice(event.price)}</span>
          <span className="charts-liq-time">
            {new Date(event.t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        </div>
      ))}
    </div>
  );
}

function FuturesPanel({ symbol, enabled, ticker }: { symbol: string; enabled: boolean; ticker: TickerSnapshot }) {
  const derivatives = usePolling<DerivPayload>(fetchDerivatives, 30_000, [], enabled);
  if (derivatives.loading && !derivatives.data) return <SidebarMessage>Reading the derivatives board…</SidebarMessage>;
  if (derivatives.error && !derivatives.data) return <SidebarMessage>{derivatives.error}</SidebarMessage>;
  if (derivatives.data?.unavailable) return <SidebarMessage>{derivatives.data.unavailable}</SidebarMessage>;

  const base = symbol.replace(/USDT$/, '').toUpperCase();
  const row = derivatives.data?.rows.find((item) => item.symbol.toUpperCase() === symbol.toUpperCase())
    ?? derivatives.data?.rows.find((item) => item.symbol.toUpperCase().startsWith(base));

  return (
    <div className="charts-sidebar-stack">
      <div className="charts-sidebar-card">
        <div className="charts-sidebar-card-head">
          <span>{symbol.replace(/USDT$/, '')} perpetual</span>
          <span>{derivatives.data?.source ?? 'derivatives'}</span>
        </div>
        {row ? (
          <div className="charts-metric-grid">
            <Metric label="Funding 8h" value={`${(row.funding8h * 100).toFixed(4)}%`} tone={row.funding8h >= 0 ? 'up' : 'down'} />
            <Metric label="Open interest" value={fmtUsd(row.oiUsd)} />
            <Metric label="OI 1h" value={fmtPct(row.oiChange.h1)} tone={row.oiChange.h1 >= 0 ? 'up' : 'down'} />
            <Metric label="Basis" value={row.basisPct === null ? '—' : fmtPct(row.basisPct, 3)} />
            <Metric label="Long / short" value={row.longShortAccountRatio === null ? '—' : row.longShortAccountRatio.toFixed(2)} />
            <Metric label="CVD" value={fmtSignedUsd(row.cvd)} tone={row.cvd >= 0 ? 'up' : 'down'} />
          </div>
        ) : (
          <SidebarMessage>No perpetual row for {symbol} on the current board.</SidebarMessage>
        )}
      </div>

      {row && (
        <div className="charts-sidebar-card">
          <div className="charts-sidebar-card-head">
            <span>Positioning</span>
            <span>{row.quadrantLabel}</span>
          </div>
          <div className="charts-metric-grid">
            <Metric label="Top trader ratio" value={row.topTraderPositionRatio === null ? '—' : row.topTraderPositionRatio.toFixed(2)} />
            <Metric label="Taker ratio" value={row.takerRatio === null ? '—' : row.takerRatio.toFixed(2)} />
            <Metric label="CVD slope" value={row.cvdSlope.toFixed(3)} tone={row.cvdSlope >= 0 ? 'up' : 'down'} />
            <Metric label="Divergence" value={row.cvdDivergence ? 'yes' : 'no'} tone={row.cvdDivergence ? 'warn' : undefined} />
          </div>
        </div>
      )}

      <div className="charts-sidebar-card">
        <div className="charts-sidebar-card-head">
          <span>24h spot</span>
          <span>Binance</span>
        </div>
        <div className="charts-metric-grid">
          <Metric label="Last" value={fmtChartPrice(ticker.price)} />
          <Metric label="Change" value={ticker.changePct === null ? '—' : fmtPct(ticker.changePct)} tone={(ticker.changePct ?? 0) >= 0 ? 'up' : 'down'} />
        </div>
      </div>
    </div>
  );
}

function SentimentPanel({ enabled }: { enabled: boolean }) {
  const macro = usePolling<MacroState>((signal) => api.macro(signal), 120_000, [], enabled);
  if (macro.loading && !macro.data) return <SidebarMessage>Reading the macro tape…</SidebarMessage>;
  if (macro.error && !macro.data) return <SidebarMessage>{macro.error}</SidebarMessage>;
  if (!macro.data) return <SidebarMessage>No macro snapshot yet.</SidebarMessage>;
  const data = macro.data;
  const fear = data.fearGreed;
  const global = data.globalMarket;
  const stable = data.stablecoins;
  const etf = data.etfFlows;
  const etfLatest = isUnavailable(etf) ? null : etf.days[0] ?? null;

  return (
    <div className="charts-sidebar-stack">
      <div className="charts-sidebar-card">
        <div className="charts-sidebar-card-head">
          <span>Risk appetite</span>
          <span>alternative.me</span>
        </div>
        <div className="charts-metric-grid">
          <Metric label="Fear & Greed" value={fear ? `${fear.value} · ${fear.label}` : '—'} tone={fear ? (fear.value >= 50 ? 'up' : 'down') : undefined} />
          <Metric label="BTC dominance" value={global ? `${global.btcDominance.toFixed(1)}%` : '—'} />
          <Metric label="Coinbase premium" value={data.coinbasePremiumPct === null ? '—' : fmtPct(data.coinbasePremiumPct, 3)} tone={(data.coinbasePremiumPct ?? 0) >= 0 ? 'up' : 'down'} />
          <Metric label="Stablecoin float" value={stable ? fmtUsd(stable.totalUsd) : '—'} />
        </div>
      </div>
      <div className="charts-sidebar-card">
        <div className="charts-sidebar-card-head">
          <span>ETF flow</span>
          <span>{isUnavailable(etf) ? 'unavailable' : 'latest day'}</span>
        </div>
        {isUnavailable(etf) ? (
          <SidebarMessage>{etf.reason}</SidebarMessage>
        ) : etfLatest ? (
          <div className="charts-metric-grid">
            <Metric label={etfLatest.date} value={fmtSignedUsd(etfLatest.totalUsd)} tone={etfLatest.totalUsd >= 0 ? 'up' : 'down'} />
            <Metric label="Streak" value={`${etf.streakDays}d`} />
          </div>
        ) : (
          <SidebarMessage>No ETF flow days collected yet.</SidebarMessage>
        )}
      </div>
    </div>
  );
}

function NewsPanel({ symbol, enabled }: { symbol: string; enabled: boolean }) {
  const news = usePolling<NewsFeed>((signal) => api.news(signal), 120_000, [], enabled);
  if (news.loading && !news.data) return <SidebarMessage>Reading headlines…</SidebarMessage>;
  if (news.error && !news.data) return <SidebarMessage>{news.error}</SidebarMessage>;
  if (!news.data) return <SidebarMessage>No news feed yet.</SidebarMessage>;
  const base = symbol.replace(/USDT$/, '');
  const items = news.data.items
    .filter((item) => item.isMacro || item.assets.some((asset) => asset.toUpperCase() === base))
    .slice(0, 10);
  if (items.length === 0) return <SidebarMessage>No recent headline names {base}.</SidebarMessage>;
  return (
    <div className="charts-news-list">
      {items.map((item) => (
        <a
          key={item.id}
          className="charts-news-item"
          href={item.url}
          target="_blank"
          rel="noreferrer"
          title={item.summary}
        >
          <span className={`charts-news-severity is-${item.severityClass.toLowerCase()}`}>
            {item.severityClass}
          </span>
          <span className="charts-news-headline">{item.headline}</span>
          <span className="charts-news-meta">
            {item.source} · {fmtAge(item.ageMinutes)} · {item.noveltyLabel}
          </span>
        </a>
      ))}
    </div>
  );
}

function GuidePanel() {
  return (
    <div className="charts-guide">
      <h3>Reading this chart</h3>
      <p>
        Candles are Binance Spot klines. The last candle is still forming; everything else is closed.
        The feed reconnects on its own and never repaints a closed bar.
      </p>
      <h3>Indicators</h3>
      <p>
        Click an indicator chip to hide or show it. The gear edits its periods, and × removes it.
        VWAP is cumulative from the first loaded candle, not a daily session VWAP.
      </p>
      <h3>Drawing</h3>
      <p>
        Pick a tool, then click the chart. Trend, rectangle and fib need two clicks; long and short
        need three (entry, target, stop). Esc cancels the active tool. Drawings live only in this
        browser session.
      </p>
      <h3>Shortcuts</h3>
      <div className="charts-guide-keys">
        <span><kbd>1</kbd>–<kbd>7</kbd> timeframe</span>
        <span><kbd>Esc</kbd> cancel drawing / exit fullscreen</span>
        <span><kbd>P</kbd> global decision rail</span>
      </div>
      <h3>Honesty</h3>
      <p>
        Chart prices come directly from Binance and can be live while the engine itself is replaying
        fixtures. The global mode badge describes the engine, not this price feed.
      </p>
    </div>
  );
}

interface ChartSidebarProps {
  symbol: string;
  tab: SidebarTab;
  open: boolean;
  ticker: TickerSnapshot;
  onTab: (tab: SidebarTab) => void;
  onToggle: () => void;
}

export function ChartSidebar({ symbol, tab, open, ticker, onTab, onToggle }: ChartSidebarProps) {
  if (!open) {
    return (
      <aside className="charts-sidebar is-collapsed" aria-label="Market context sidebar">
        <button type="button" className="charts-sidebar-expand" onClick={onToggle} aria-label="Open market context">
          ‹
        </button>
        <span>CONTEXT</span>
      </aside>
    );
  }

  return (
    <aside className="charts-sidebar" aria-label="Market context sidebar">
      <div className="charts-sidebar-head">
        <div>
          <span className="charts-sidebar-kicker">MARKET CONTEXT</span>
          <strong>{symbol.replace(/USDT$/, '')}/USDT</strong>
        </div>
        <button type="button" className="charts-sidebar-collapse" onClick={onToggle} aria-label="Collapse market context">
          ›
        </button>
      </div>
      <div className="charts-sidebar-tabs" role="tablist" aria-label="Context panels">
        {SIDEBAR_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? 'is-active' : ''}
            onClick={() => onTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="charts-sidebar-body" role="tabpanel">
        {tab === 'whales' && <WhalesPanel symbol={symbol} enabled={open && tab === 'whales'} />}
        {tab === 'futures' && <FuturesPanel symbol={symbol} enabled={open && tab === 'futures'} ticker={ticker} />}
        {tab === 'sentiment' && <SentimentPanel enabled={open && tab === 'sentiment'} />}
        {tab === 'news' && <NewsPanel symbol={symbol} enabled={open && tab === 'news'} />}
        {tab === 'guide' && <GuidePanel />}
      </div>
    </aside>
  );
}
