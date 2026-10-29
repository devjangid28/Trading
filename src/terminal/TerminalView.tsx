import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssetRow, TerminalInterval,
} from '../../shared/types';
import { TERMINAL_INTERVALS } from '../../shared/types';
import { api, usePolling } from '../lib/api';
import type { MarketRow } from '../lib/api';
import { fmtPrice, istClock } from '../lib/format';
import { useLivePrice } from '../lib/priceStore';
import { CandleChart } from '../components/CandleChart';
import { Spinner, type MarketMode } from '../components/ui';
import {
  frameFromHistory, mergeBookFrames, mergeLiveCandle, mergeTrades,
} from './math';
import { useTerminalBook } from './useTerminalBook';
import { useTerminalCandles } from './useTerminalCandles';
import { useTerminalHistory } from './useTerminalHistory';
import { loadSettings, saveSettings, type HeatmapSettings } from './settings';
import { buildPlanContext } from './levels';
import { buildMockHeatmap } from './mockHeatmap';
import type { LayerToggles } from './HeatmapCanvas';
import { HeatmapView } from './HeatmapView';
import { DecisionRail } from './DecisionRail';
import {
  FuturesView, GammaView, GuideView, L3EventsView, SentimentView, TapeView,
  VolumeProfileView, WhalesView,
} from './TerminalViews';
import { FootprintView } from './footprint/FootprintView';
import './terminal.css';

const DASH = '\u2014';
const MOCK_BTC_PRICE = 80_590;
const MOCK_QUERY = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('mock') === '1';

export type TerminalPage = 'charts' | 'heatmap' | 'footprint';
type ViewKey =
  | 'chart' | 'heatmap' | 'footprint' | 'whales' | 'volume-profile' | 'gamma'
  | 'tape' | 'l3' | 'futures' | 'sentiment' | 'guide';

const VIEWS: Array<{ key: ViewKey; label: string; hotkey: string | null }> = [
  { key: 'chart', label: 'Chart', hotkey: '1' },
  { key: 'heatmap', label: 'Heatmap', hotkey: '2' },
  { key: 'footprint', label: 'Footprint', hotkey: '3' },
  { key: 'whales', label: 'Whales', hotkey: '4' },
  { key: 'volume-profile', label: 'Vol profile', hotkey: '5' },
  { key: 'gamma', label: 'Gamma', hotkey: '6' },
  { key: 'tape', label: 'Tape', hotkey: '7' },
  { key: 'l3', label: 'L3 events', hotkey: '8' },
  { key: 'futures', label: 'Futures', hotkey: '9' },
  { key: 'sentiment', label: 'Sentiment', hotkey: '0' },
  { key: 'guide', label: 'Guide', hotkey: null },
];

function TfButtons({
  interval,
  onChange,
}: {
  interval: TerminalInterval;
  onChange: (i: TerminalInterval) => void;
}) {
  return (
    <div className="terminal-seg terminal-tf" role="group" aria-label="Chart timeframe">
      {TERMINAL_INTERVALS.map((i) => (
        <button
          key={i}
          type="button"
          className={interval === i ? 'is-on' : ''}
          onClick={() => onChange(i)}
          aria-pressed={interval === i}
        >
          {i === '1d' ? '1D' : i}
        </button>
      ))}
    </div>
  );
}

function priceText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const digits = value >= 1000 ? 2 : value >= 1 ? 3 : value >= 0.01 ? 4 : 6;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function feedOf(mode: MarketMode, stream: string, bookAge: number | null): string {
  if (mode === 'MOCK') return 'MOCK';
  if (mode === 'BANNED') return 'BANNED';
  if (mode === 'OFFLINE') return 'OFFLINE';
  if (stream === 'DISCONNECTED' || stream === 'OFFLINE') return 'OFFLINE';
  if (stream === 'STALE') return 'STALE';
  if (bookAge !== null && bookAge > 3_000) return 'STALE';
  if (stream === 'CONNECTING') return 'CONNECTING';
  return 'LIVE';
}

function feedDetailOf(feed: string, bookAge: number | null): string {
  if (feed === 'STALE') return `Last book sample ${Math.round((bookAge ?? 0) / 1_000)}s ago \u2014 stale after 3s`;
  if (feed === 'OFFLINE') return 'The Binance depth socket is closed; waiting for the next snapshot';
  if (feed === 'CONNECTING') return 'Opening the Binance depth stream and synchronizing its REST snapshot';
  if (feed === 'LIVE') return 'Binance diff-depth and aggTrade streams are synchronized';
  if (feed === 'MOCK') return 'Fixture replay \u2014 this is NOT the live market';
  if (feed === 'BANNED') return 'Upstream host blocked us; the terminal is showing the last successful samples';
  return 'No book sample yet';
}

export function TerminalView({
  symbol,
  onSymbol,
  mode,
  rows,
  view,
  onExit,
}: {
  symbol: string;
  onSymbol: (symbol: string) => void;
  mode: MarketMode;
  rows: AssetRow[];
  view: TerminalPage;
  onExit?: () => void;
}) {
  const [interval, setInterval] = useState<TerminalInterval>('15m');
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [chartH, setChartH] = useState(430);
  const [fullscreen, setFullscreen] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [linesMode, setLinesMode] = useState(false);
  const [activeView, setActiveView] = useState<ViewKey>(
    view === 'charts' ? 'chart' : view === 'heatmap' ? 'heatmap' : 'footprint',
  );
  const [settings, setSettings] = useState<HeatmapSettings>(
    () => loadSettings(typeof window === 'undefined' ? null : window.localStorage),
  );
  const [layers, setLayers] = useState<LayerToggles>({ plan: true, gamma: false, liq: false });
  const marketRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const chartBodyRef = useRef<HTMLDivElement>(null);

  const live = useLivePrice(symbol);
  const markets = usePolling((s) => api.markets(s), 120_000);
  const bookState = useTerminalBook(symbol, true, mode === 'LIVE');
  const chart = useTerminalCandles(symbol, interval);
  const history = useTerminalHistory(symbol, settings.span, mode !== 'MOCK');

  const base = symbol.replace(/USDT$/, '');
  const scanRow = useMemo(
    () => rows.find((r) => r.pair === symbol) ?? rows.find((r) => r.base === base) ?? null,
    [rows, symbol, base],
  );

  const gammaFeed = usePolling((s) => api.gex(s), 300_000, [], mode !== 'MOCK');
  const liqFeed = usePolling((s) => api.liquidations(base, s), 15_000, [base], mode !== 'MOCK');
  const gamma = base === 'BTC' ? gammaFeed.data?.btc ?? null : base === 'ETH' ? gammaFeed.data?.eth ?? null : null;
  const gammaError = base === 'BTC' || base === 'ETH'
    ? gammaFeed.error
    : `Gamma is only published for BTC and ETH (${base} has no Deribit book here)`;
  const liqEvents = liqFeed.data?.recent ?? [];

  const book = bookState.book?.symbol === symbol ? bookState.book : null;
  const historyFrames = useMemo(
    () => history.history?.symbol === symbol
      ? history.history.frames.map(frameFromHistory)
      : [],
    [history.history, symbol],
  );
  const frames = useMemo(
    () => mergeBookFrames(historyFrames, book ? bookState.frames : []),
    [historyFrames, book, bookState.frames],
  );
  const mockTape = useMemo(
    () => (mode === 'MOCK' ? buildMockHeatmap(symbol, 0, Date.now()) : null),
    [mode, symbol],
  );
  const trades = useMemo(
    () => mockTape?.trades ?? mergeTrades(
      history.history?.symbol === symbol ? history.history.trades : [],
      book ? bookState.trades : [],
      20_000,
    ),
    [mockTape, history.history, book, bookState.trades, symbol],
  );

  const marketRow = useMemo(
    () => markets.data?.rows.find((r) => r.pair === symbol) ?? null,
    [markets.data, symbol],
  );
  const footprintMock = mode === 'MOCK' || MOCK_QUERY;
  const mockPrice = mode === 'MOCK' ? (base === 'BTC' ? MOCK_BTC_PRICE : book?.mid ?? null) : null;
  const price = mockPrice ?? live?.price ?? marketRow?.price ?? scanRow?.price ?? book?.mid ?? null;
  const bid = mockPrice !== null ? mockPrice - 0.01 : book?.bestBid ?? null;
  const ask = mockPrice !== null ? mockPrice + 0.01 : book?.bestAsk ?? null;
  const spread = bid !== null && ask !== null ? Math.max(0, ask - bid) : null;
  const tick = (price ?? 0) >= 1_000 ? 0.01 : 0.0001;
  const tickCount = spread !== null ? Math.max(1, Math.round(spread / tick)) : null;
  const spreadBps = spread !== null && price ? (spread / price) * 10_000 : null;

  const candles = useMemo(
    () => mergeLiveCandle(chart.candles ?? [], live?.price ?? null, interval, Date.now()),
    [chart.candles, live?.price, interval, bookState.book?.asOf],
  );
  const plan = useMemo(() => buildPlanContext(scanRow, price), [scanRow, price]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list: MarketRow[] = markets.data?.rows ?? [];
    if (!q) return list.slice(0, 120);
    return list
      .filter((r) => (
        r.base.toLowerCase().includes(q)
        || r.name.toLowerCase().includes(q)
        || r.pair.toLowerCase().includes(q)
      ))
      .slice(0, 120);
  }, [markets.data, query]);

  useEffect(() => {
    setActiveView(view === 'charts' ? 'chart' : view === 'heatmap' ? 'heatmap' : 'footprint');
  }, [view]);

  useEffect(() => {
    saveSettings(settings, typeof window === 'undefined' ? null : window.localStorage);
  }, [settings]);

  useEffect(() => {
    if (!picker) return;
    const onDown = (e: PointerEvent) => {
      if (!marketRef.current?.contains(e.target as Node)) setPicker(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPicker(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [picker]);

  useEffect(() => {
    if (!diagnostics) return;
    const onDown = (e: PointerEvent) => {
      if (!feedRef.current?.contains(e.target as Node)) setDiagnostics(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [diagnostics]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('terminal-fs');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('terminal-fs');
    };
  }, [fullscreen]);

  useEffect(() => {
    const el = chartBodyRef.current;
    if (!el || activeView !== 'chart') return;
    const measure = () => {
      const h = el.clientHeight;
      if (h > 120) setChartH(Math.round(h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeView, fullscreen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'f') {
        event.preventDefault();
        setFullscreen((value) => !value);
        return;
      }
      if (key === 'p') {
        event.preventDefault();
        setRailOpen((value) => !value);
        return;
      }
      if (key === 'escape') {
        setPicker(false);
        setDiagnostics(false);
        setLinesMode(false);
        return;
      }
      if (key === 't') {
        event.preventDefault();
        setInterval((current) => {
          const index = TERMINAL_INTERVALS.indexOf(current);
          return TERMINAL_INTERVALS[(index + 1) % TERMINAL_INTERVALS.length];
        });
        return;
      }
      if (key === 'b') {
        event.preventDefault();
        setSettings((prev) => ({ ...prev, bubbles: prev.bubbles === 'off' ? 'auto' : 'off' }));
        return;
      }
      if (key === 'c') {
        event.preventDefault();
        setSettings((prev) => ({ ...prev, showCandles: !prev.showCandles }));
        return;
      }
      if (key === 'r') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('heatmap-reset'));
        return;
      }
      if (key === 'l') {
        event.preventDefault();
        setLinesMode((value) => !value);
        return;
      }
      const next = VIEWS.find((item) => item.hotkey === key);
      if (next) {
        event.preventDefault();
        setActiveView(next.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const bookAge = book ? Math.max(0, Date.now() - book.asOf) : null;
  const stream = bookState.streamState;
  const feed = feedOf(mode, stream, bookAge);
  const feedDetail = feedDetailOf(feed, bookAge);
  const toggleLayer = (key: keyof LayerToggles) => setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  const updateSettings = (patch: Partial<HeatmapSettings>) => setSettings((prev) => ({ ...prev, ...patch }));

  const historyFrom = history.history?.symbol === symbol ? history.history.from : null;
  const historyError = history.error;
  const bookError = bookState.error;

  const renderView = () => {
    if (activeView === 'heatmap') {
      return (
        <HeatmapView
          symbol={symbol}
          book={book}
          frames={frames}
          trades={trades}
          candles={candles}
          interval={interval}
          settings={settings}
          onSettings={updateSettings}
          plan={plan}
          layers={layers}
          mock={mode === 'MOCK'}
          gamma={gamma}
          gammaError={gammaError}
          liqEvents={liqEvents}
          liqError={liqFeed.error}
          loading={(bookState.loading && frames.length === 0) || history.loading}
          error={bookError}
          tapeError={bookState.tapeError}
          streamState={stream}
          historyFrom={historyFrom}
          historyError={historyError}
          lastEventAt={bookState.stats.lastEventAt}
          lastTradeAt={bookState.stats.lastTradeAt}
        />
      );
    }
    if (activeView === 'chart') {
      return (
        <section className="terminal-panel terminal-panel--chart">
          <div className="terminal-chart-body" ref={chartBodyRef}>
            {chart.loading && candles.length === 0 && <div className="terminal-chart-state"><Spinner label="Loading candles…" /></div>}
            {!chart.loading && chart.error && candles.length === 0 && (
              <div className="terminal-chart-state is-error">
                <strong>Chart unavailable</strong>
                <p>{chart.error}</p>
                <button type="button" onClick={chart.reload}>Retry</button>
              </div>
            )}
            {!chart.loading && !chart.error && candles.length === 0 && (
              <div className="terminal-chart-state"><strong>No candles returned</strong><p>The exchange returned an empty series for this timeframe.</p></div>
            )}
            {candles.length > 0 && (
              <CandleChart
                candles={candles}
                setup={scanRow?.setup ?? null}
                height={chartH}
                maxCandles={180}
                showPrevious={false}
                showContext
                showVolume
              />
            )}
          </div>
        </section>
      );
    }
    if (activeView === 'footprint') {
      return (
        <FootprintView
          symbol={symbol}
          interval={interval}
          onInterval={setInterval}
          trades={trades}
          candles={candles}
          price={price}
          plan={plan}
          liqEvents={liqEvents}
          mock={footprintMock}
        />
      );
    }
    if (activeView === 'whales') return <WhalesView trades={trades} />;
    if (activeView === 'volume-profile') return <VolumeProfileView trades={trades} mid={price} />;
    if (activeView === 'gamma') return <GammaView snapshot={gamma} error={gammaError} base={base} />;
    if (activeView === 'tape') return <TapeView trades={trades} />;
    if (activeView === 'l3') return <L3EventsView frames={frames} trades={trades} />;
    if (activeView === 'futures') return <FuturesView row={scanRow} base={base} />;
    if (activeView === 'sentiment') return <SentimentView row={scanRow} plan={plan} base={base} />;
    return <GuideView />;
  };

  return (
    <section className={`terminal-shell tradfye-shell${fullscreen ? ' is-fullscreen' : ''}`} aria-label="Tradfye market terminal">
      <header className="tradfye-brand">
        <button
          type="button"
          className="tradfye-word"
          onClick={onExit ?? (() => { window.location.hash = ''; })}
          title={onExit ? 'Back to OrderFlow' : 'Tradfye'}
        >
          Tradfye
        </button>
        <span className="tradfye-beta">BETA</span>
        <span className="tradfye-caption">Beta · Free</span>
        <span className="tradfye-avatar" aria-label="Account menu">D</span>
      </header>

      <header className="market-topbar tradfye-topbar">
        <div className="market-picker tradfye-picker" ref={marketRef}>
          <button
            type="button"
            className="market-picker__button tradfye-picker__button"
            onClick={() => setPicker((value) => !value)}
            aria-haspopup="listbox"
            aria-expanded={picker}
            aria-label="Select market"
          >
            <b>{base}</b><span>/USDT</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {picker && (
            <div className="market-picker__popover" role="listbox" aria-label="Select a market">
              <input
                autoFocus
                className="market-picker__search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search BTC, ETH, SOL…"
                aria-label="Search markets"
              />
              <div className="market-picker__list">
                {markets.loading && !markets.data && <div className="market-picker__note">Loading markets…</div>}
                {markets.error && !markets.data && <div className="market-picker__note is-error">{markets.error}</div>}
                {!markets.loading && markets.data && results.length === 0 && (
                  <div className="market-picker__note">No spot market matches “{query}”.</div>
                )}
                {results.map((row) => (
                  <button
                    key={row.pair}
                    type="button"
                    role="option"
                    aria-selected={row.pair === symbol}
                    className={`market-picker__row${row.pair === symbol ? ' is-on' : ''}`}
                    onClick={() => {
                      onSymbol(row.pair);
                      setPicker(false);
                      setQuery('');
                    }}
                  >
                    <span className="market-picker__row-base">{row.base}<small>/USDT</small></span>
                    <span className="market-picker__row-name">{row.name}</span>
                    <span className="market-picker__row-price">{fmtPrice(row.price)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="market-quote tradfye-quote">
          <div className="market-quote__last">{priceText(price)}</div>
          <div className="tradfye-spread">
            <span className="is-up">{priceText(bid)}</span>
            <span className="is-down">{priceText(ask)}</span>
            <span className="tradfye-spread__meta">
              {tickCount !== null && spreadBps !== null
                ? `spread ${tickCount} tick${tickCount === 1 ? '' : 's'} · ${spreadBps.toFixed(3)} bp`
                : `spread ${DASH} · ${DASH}`}
            </span>
          </div>
        </div>

        <div className="top-tf">
          <span className="toolbar-kicker">Timeframe</span>
          <TfButtons interval={interval} onChange={setInterval} />
        </div>

        <div className="top-lines">
          <span className="toolbar-kicker">Lines</span>
          <div className="line-seg" role="group" aria-label="Chart lines">
            <button
              type="button"
              className={`line-btn line-btn--lines${linesMode ? ' is-on' : ''}`}
              aria-pressed={linesMode}
              onClick={() => setLinesMode((value) => !value)}
              title="Draw horizontal price lines"
            >
              Lines
            </button>
            <button
              type="button"
              className={`line-btn line-btn--plan${layers.plan ? ' is-on' : ''}`}
              aria-pressed={layers.plan}
              onClick={() => toggleLayer('plan')}
              title={plan.reason}
            >
              Plan
            </button>
            <button
              type="button"
              className={`line-btn line-btn--gamma${layers.gamma ? ' is-on' : ''}`}
              aria-pressed={layers.gamma}
              onClick={() => toggleLayer('gamma')}
              title={gamma ? `Deribit GEX for ${base} · ${gamma.dealersShortGamma ? 'dealers short gamma' : 'dealers long gamma'}` : gammaError ?? 'Gamma is only published for BTC and ETH'}
            >
              Γ
            </button>
            <button
              type="button"
              className={`line-btn line-btn--liq${layers.liq ? ' is-on' : ''}`}
              aria-pressed={layers.liq}
              onClick={() => toggleLayer('liq')}
              title="Estimated clusters from the sampled forceOrder feed. A lower bound, not the full liquidation tape."
            >
              Liq
            </button>
          </div>
        </div>

        <div className="feed-wrap" ref={feedRef}>
          <button
            type="button"
            className={`feed-badge is-${feed.toLowerCase()}`}
            title={feedDetail}
            onClick={() => setDiagnostics((value) => !value)}
            aria-expanded={diagnostics}
            aria-haspopup="dialog"
          >
            <i />
            {feed}
            <span className="feed-caret" aria-hidden>▾</span>
          </button>
          <span className="feed-inline" title="Feed diagnostics">
            {feed === 'LIVE' && bookAge !== null
              ? `Book age ${Math.round(bookAge)} ms · ${bookState.stats.messagesPerSec.toFixed(0)} messages/s`
              : feedDetail}
          </span>
          {diagnostics && (
            <div className="feed-diagnostics" role="dialog" aria-label="Feed diagnostics">
              <header>
                <strong>Feed diagnostics</strong>
                <span className={`feed-badge is-${feed.toLowerCase()}`}><i />{feed}</span>
              </header>
              <p>{feedDetail}</p>
              <dl>
                <div><dt>Book age</dt><dd>{bookAge === null ? DASH : `${bookAge} ms`}</dd></div>
                <div><dt>Last event</dt><dd>{bookState.stats.lastEventAt ? `${Math.max(0, Math.round((Date.now() - bookState.stats.lastEventAt) / 1_000))} s ago` : DASH}</dd></div>
                <div><dt>Last trade</dt><dd>{bookState.stats.lastTradeAt ? istClock(bookState.stats.lastTradeAt) : DASH}</dd></div>
                <div><dt>Messages/s</dt><dd>{bookState.stats.messagesPerSec > 0 ? bookState.stats.messagesPerSec.toFixed(1) : DASH}</dd></div>
                <div><dt>Book resyncs</dt><dd>{bookState.stats.resyncs}</dd></div>
                <div><dt>Socket reconnects</dt><dd>{bookState.stats.reconnects}</dd></div>
                <div><dt>Span / capture</dt><dd>{settings.span} · history {historyFrom ? istClock(historyFrom) : 'live only'}</dd></div>
                <div><dt>Tape</dt><dd>{bookState.tapeError ? bookState.tapeError : `${trades.length.toLocaleString()} captured`}</dd></div>
                <div><dt>Gamma</dt><dd>{gamma ? `${gamma.symbol} · ${istClock(gamma.asOf)}` : gammaError ?? DASH}</dd></div>
                <div><dt>Liquidations</dt><dd>{liqFeed.error ? liqFeed.error : `${liqEvents.length} sampled prints · lower bound`}</dd></div>
              </dl>
            </div>
          )}
        </div>
      </header>

      <div className="tradfye-workspace">
        <div className="tradfye-main">
          {view !== 'heatmap' && (
          <div className="tradfye-viewbar">
            <div className="tradfye-tabs" role="tablist" aria-label="Terminal views">
              {VIEWS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  id={`tradfye-tab-${item.key}`}
                  aria-selected={activeView === item.key}
                  aria-controls="tradfye-view-panel"
                  tabIndex={activeView === item.key ? 0 : -1}
                  className={`tradfye-tab${activeView === item.key ? ' is-on' : ''}`}
                  title={item.hotkey ? `${item.label} · press ${item.hotkey}` : item.label}
                  onClick={() => setActiveView(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <select
              className="tradfye-view-select"
              aria-label="Terminal view"
              value={activeView}
              onChange={(event) => setActiveView(event.target.value as ViewKey)}
            >
              {VIEWS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
            <div className="terminal-view-stats" aria-label="Terminal status">
              <span><small>Pair</small><b>{base}/USDT</b></span>
              <span><small>TF</small><b>{interval === '1d' ? '1D' : interval}</b></span>
              <span><small>Feed</small><b className={feed === 'LIVE' ? 'is-up' : feed === 'STALE' || feed === 'MOCK' ? 'is-down' : ''}>{feed}</b></span>
            </div>
            <button
              type="button"
              className="terminal-expand"
              onClick={() => setFullscreen((value) => !value)}
              title={fullscreen ? 'Exit full screen (F)' : 'Full screen (F)'}
              aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                {fullscreen
                  ? <path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4" />
                  : <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />}
              </svg>
            </button>
          </div>
          )}
          <div id="tradfye-view-panel" className="tradfye-view-body" role="tabpanel" aria-labelledby={view === 'heatmap' ? undefined : `tradfye-tab-${activeView}`}>
            {renderView()}
          </div>
        </div>

        <DecisionRail
          symbol={symbol}
          rows={rows}
          mode={mode}
          open={railOpen}
          onOpen={() => setRailOpen(true)}
          onClose={() => setRailOpen(false)}
          signalOverride={mode === 'MOCK' ? 'WAIT' : undefined}
        />
      </div>
    </section>
  );
}
