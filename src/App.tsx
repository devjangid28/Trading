import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, usePolling, type CalendarResult, type HealthState } from './lib/api';
import type { AssetRow, ScanResult } from '../shared/types';
import { MacroStrip } from './components/MacroStrip';
import { NewsImpactPanel } from './components/NewsImpactPanel';
import { DerivativesTab } from './components/DerivativesTab';
import { AttributionPanel } from './components/AttributionPanel';
import { IndiaPanel } from './components/IndiaPanel';
import { SectorFlowPanel } from './components/SectorFlow';
import { Journal } from './components/Journal';
import { TicketPanel } from './components/TicketPanel';
import { AssetPopup } from './components/AssetPopup';
import { Empty, ModeBadge, Panel, Spinner, StreamNotice, type MarketMode } from './components/ui';
import { MindHealthStrip, useMindHealth } from './components/MindBits';
import './components/mind.css';
import { BlackoutCountdown } from './components/BlackoutCountdown';
import { GlobalSearch } from './components/GlobalSearch';
import { useLiveStreamProvider, useLive } from './lib/liveContext';
import { HomeView } from './home/HomeView';
import { MarketsView } from './components/MarketsView';
import { TerminalView } from './terminal/TerminalView';
import { ChartsTerminal } from './charts/ChartsTerminal';
import { DecisionRail } from './terminal/DecisionRail';
import { StageView } from './stage/Stage';
import { SignalsView } from './components/SignalsView';
import { RadarView } from './components/RadarView';
import { EngineLabView } from './lab/EngineLabView';

type Tab =
  | 'dashboard'
  | 'charts'
  | 'heatmap'
  | 'footprint'
  | 'orderblock'
  | 'signals'
  | 'radar'
  | 'markets'
  | 'derivatives'
  | 'news'
  | 'india'
  | 'journal'
  | 'lab'
  | 'learn';
type TicketType = 'hero' | 'standard';

const TAB_IDS: Tab[] = [
  'dashboard', 'charts', 'heatmap', 'footprint', 'orderblock', 'signals', 'radar',
  'markets', 'derivatives', 'news', 'india', 'journal', 'lab', 'learn',
];

function initialTab(): Tab {
  if (typeof window === 'undefined') return 'dashboard';
  const requested = new URLSearchParams(window.location.search).get('tab');
  return TAB_IDS.includes(requested as Tab) ? (requested as Tab) : 'dashboard';
}

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('of-theme', dark ? 'dark' : 'light');
    } catch {
      /* storage blocked */
    }
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

function LearnView() {
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-3xl mx-auto space-y-4">
        <div>
          <h2 className="text-[15px] font-bold tracking-tight">How the engine works</h2>
          <p className="text-[12px] mt-1" style={{ color: 'var(--muted)' }}>
            Everything here is computed from closed 5-minute candles and public exchange data. No
            broker login, no signals, no recommendations.
          </p>
        </div>

        {[
          {
            t: '1 · One-directional strength',
            b: 'Strength = |net move| × efficiency, where efficiency is the net move divided by the day range. A coin that ran 9% and gave it all back scores near zero and is kept off the board. Percentiles are read across the whole board; the bearish side is inverted so the strongest bearish name sits near the top of its list too.',
          },
          {
            t: '2 · Order block detection',
            b: 'The last opposite-coloured candle before a move that closes beyond the prior swing high (bullish) or low (bearish). The move away must be forceful — it either left a fair-value gap, or travelled at least one average candle range. The zone must not have been closed through since. Only closed candles are read, so a zone never repaints from a candle that is still moving.',
          },
          {
            t: '3 · The level ladder',
            b: 'Z is the midpoint of the block. The invalidation sits just beyond the far side — S1 below for a bullish setup, R1 above for a bearish one. R1 and R2 are the liquidity ahead: swing highs price has not returned to, biased toward equal highs and lows where stop orders pile up. Amber dotted lines are levels price already met on the way. The dashed yellow line is session VWAP.',
          },
          {
            t: '4 · Picks, not tips',
            b: 'Three picks per side, with no more than two from any one sector so a single news story cannot fill the shortlist. A coin with an unusually large one-day move is flagged event risk and gets no levels at all. Every row tells you why it was or was not picked.',
          },
          {
            t: '5 · News impact',
            b: 'Headlines are tagged into event categories with a severity weight, scored for relevance by how early the asset is named in the headline, run through a negation-aware finance lexicon, and weighted by source tier and urgency. The result decays on a per-class half-life — 45 minutes for a hack, four hours for a macro print. Only the positive part of sentiment feeds the impact score: a strongly negative story still has high impact.',
          },
          {
            t: '6 · Attribution',
            b: 'Abnormal return is the raw move minus what BTC\'s move would imply at that asset\'s rolling beta. Attribution only runs when the move clears a 2.5-sigma gate, and coverage tells you how much of it the headlines account for. A low coverage number means flow or liquidations, not news.',
          },
        ].map((s) => (
          <div key={s.t} className="rounded-lg p-3" style={{ background: 'var(--panel-2)' }}>
            <h3 className="text-[12.5px] font-semibold">{s.t}</h3>
            <p className="text-[11.5px] leading-relaxed mt-1" style={{ color: 'var(--muted)' }}>
              {s.b}
            </p>
          </div>
        ))}

        <div
          className="rounded-lg p-3 text-[11px] leading-relaxed"
          style={{ background: 'rgba(217,119,6,0.1)', border: '1px solid rgba(217,119,6,0.3)', color: 'var(--muted)' }}
        >
          <strong style={{ color: '#d97706' }}>Risk disclosure.</strong> OrderFlow is a market
          analytics tool. Nothing it displays is investment advice or a recommendation to buy or sell
          any asset. Trading derivatives and leveraged crypto carries a high risk of loss. This is a
          research and education project.
        </div>

        <div className="rounded-lg p-3" style={{ background: 'var(--panel-2)' }}>
          <h3 className="text-[12.5px] font-semibold">Data sources</h3>
          <ul className="text-[11px] leading-relaxed mt-1.5 space-y-0.5" style={{ color: 'var(--muted)' }}>
            <li>Crypto OHLCV, tickers — Binance public REST, no key</li>
            <li>Indian equities and indices — Yahoo Finance chart API and NSE public endpoints</li>
            <li>Market cap, dominance, Fear & Greed — CoinGecko and alternative.me</li>
            <li>Stablecoin float — DefiLlama</li>
            <li>News — CoinDesk, Cointelegraph, Decrypt, Bitcoin Magazine, Bitcoin.com, CryptoSlate RSS</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * One icon per destination. Labels alone were fine when there were six tabs;
 * eleven tabs of equal weight read as a wall of text at a glance. A 14px line
 * icon gives each destination a shape without becoming decoration.
 */
function TabIcon({ id }: { id: Tab }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  const paths: Record<Tab, ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    charts: <><path d="M4 4v16" /><path d="M8 8v8" /><path d="M12 5v14" /><path d="M16 9v6" /><path d="M20 7v10" /></>,
    heatmap: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 9v12M15 9v12M3 15h18" /></>,
    footprint: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 8h18M3 12h18M3 16h18M9 8v12" /></>,
    markets: <><path d="M3 20V10" /><path d="M9 20V4" /><path d="M15 20v-7" /><path d="M21 20V7" /></>,
    orderblock: <><path d="M12 2 3 7l9 5 9-5-9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>,
    signals: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
    radar: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 12 18 6" /></>,
    derivatives: <><path d="M3 12h4l2-7 4 14 2-7h6" /></>,
    news: <><path d="M4 5h13v14H5a2 2 0 0 1-2-2V7" /><path d="M17 8h2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2" /><path d="M7 9h7M7 13h7M7 17h4" /></>,
    india: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18" /><path d="M12 3a15 15 0 0 0 0 18" /></>,
    journal: <><path d="M5 4h14v16H5z" /><path d="M9 4v16" /><path d="M13 8h3M13 12h3" /></>,
    lab: <><path d="M9 3h6" /><path d="M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" /><path d="M7.5 15h9" /></>,
    learn: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.35-1 .9-1 1.7" /><path d="M12 17h.01" /></>,
  };
  return <svg {...common}>{paths[id]}</svg>;
}

export default function App() {
  // Dev-only render counter, read by qa/render-count.spec.ts to prove that a
  // burst of live ticks does not re-render the app shell. Stripped from prod.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const w = window as unknown as { __ofAppRenders?: number };
    w.__ofAppRenders = (w.__ofAppRenders ?? 0) + 1;
  }

  const { dark, toggle } = useTheme();
  // Polls itself at 60s. Deliberately not gated on a visited tab: the model
  // health is global, and a header that is blank until someone opens Signals
  // would make the rest of the strip look broken rather than un-fetched.
  const mindHealth = useMindHealth(60_000);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [railOpen, setRailOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [terminalSymbol, setTerminalSymbol] = useState(() => {
    try {
      const saved = localStorage.getItem('of-terminal-symbol');
      return saved && /^[A-Z0-9]{2,20}$/.test(saved) ? saved : 'BTCUSDT';
    } catch {
      return 'BTCUSDT';
    }
  });
  const [ticketType, setTicketType] = useState<TicketType>('standard');
  /**
   * Which instrument has the full candlestick popup open.
   *
   * `AssetPopup` wraps `CandleChart` ΓÇö the real OHLCV chart with the order-block
   * box, Z, S1/R1, liquidity targets, VWAP, context levels, a crosshair and an
   * OHLC readout. It was written but never mounted, so the best chart in the
   * codebase was unreachable and the ticket was drawing fabricated candles
   * instead. `null` means closed.
   */
  const [chartFor, setChartFor] = useState<string | null>(null);
  const [visited, setVisited] = useState<Record<string, boolean>>({ dashboard: true });
  useEffect(() => {
    setVisited((v) => (v[tab] ? v : { ...v, [tab]: true }));
  }, [tab]);

  useEffect(() => {
    try {
      localStorage.setItem('of-terminal-symbol', terminalSymbol);
    } catch {
      /* storage blocked */
    }
  }, [terminalSymbol]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (tab === 'heatmap') return;
      const target = event.target as HTMLElement | null;
      if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'p') return;
      event.preventDefault();
      setRailOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab]);

  const scan = usePolling<ScanResult>((s) => api.scan(s), 60_000);
  const health = usePolling<HealthState>((s) => api.health(s), 30_000);
  const mockMode = health.data?.mock?.active === true;
  const news = usePolling((s) => api.news(s), 120_000);
  const macro = usePolling((s) => api.macro(s), 120_000);
  const india = usePolling((s) => api.india(s), 180_000, [], visited.india === true);
  const attribution = usePolling((s) => api.attributionAll(s), 120_000, [], visited.news === true);
  const calendar = usePolling<CalendarResult>((s) => api.calendar(s), 300_000);
  const nextBlackout = calendar.data?.nextBlackout ?? null;

  // The low-frequency live board. `useLive()` reads the module store that
  // `useLiveStreamProvider` publishes to; on the first render it is the value
  // from a previous mount (or empty), then the provider's effects fill it in.
  const live = useLive();
  const scanData = live.scan ?? scan.data;
  const data = scanData;

  /**
   * A ban is materially different from ordinary staleness: the board is not
   * "refreshing", it will not refresh at all until the window closes, and the
   * engine is deliberately sending nothing. The UI says so rather than showing
   * an amber "cached · refreshing" chip that would never resolve.
   */
  const banned = Boolean(data?.reason?.startsWith('BANNED'));
  const allRows: AssetRow[] = useMemo(
    () => (data ? [...data.bullish, ...data.bearish] : []),
    [data],
  );
  const selectedRow = allRows.find((r) => r.id === selected) ?? null;

  /**
   * The row the open chart popup belongs to, and the sector-average the
   * alignment check needs. Computed from the same `allRows` the board renders,
   * so the popup's "sector leans the same way" tick can never disagree with the
   * board it was opened from.
   */
  const chartRow = allRows.find((r) => r.id === chartFor) ?? null;
  const chartSectorAvg = useMemo(() => {
    if (!chartRow) return null;
    const peers = allRows.filter((r) => r.sector === chartRow.sector);
    if (peers.length === 0) return null;
    return peers.reduce((sum, r) => sum + r.changePct, 0) / peers.length;
  }, [chartRow, allRows]);

  /**
   * What the SSE subscription is actually for. The server pushes ticks for
   * only these symbols to this client (POST /api/stream/visible), which is most
   * of the stream bandwidth: ~150 tracked symbols arrive every second but only
   * the visible board (plus any selected row) is ever rendered. `selected` is
   * included so the ticket keeps ticking the moment it is opened, before the
   * next board refresh has added it.
   */
  const visibleSymbols = useMemo(() => {
    // `null`, not `[]`, before the first board lands. An empty array is a valid
    // subscription meaning "render none of these", so posting it would tell the
    // server to push zero ticks — the ticker would sit dead through the whole
    // first scan and then snap alive. `null` means "all symbols", which is the
    // correct thing to want when nothing is rendered yet.
    if (!data) return null;
    const set = new Set<string>();
    for (const r of allRows) set.add(`${r.base}USDT`);
    if (selected) set.add(`${selected.replace(/USDT$/, '')}USDT`);
    // The global Decision & DOM rail can show a symbol that is not on today's
    // board. Keep its ticks flowing on every page, not only the chart pages.
    set.add(terminalSymbol);
    return [...set];
  }, [data, allRows, selected, terminalSymbol]);

  useLiveStreamProvider(scan.data, visibleSymbols);

  /**
   * The persistent source mode. Freshness (LIVE/DELAYED/STALE) says how old a
   * panel's data is; this says where it comes from at all — and unlike the old
   * hard-coded "LIVE 24/7" pill, it cannot claim a live market while replaying
   * fixtures, banned upstream, or disconnected.
   */
  const mode: MarketMode = mockMode
    ? 'MOCK'
    : banned
      ? 'BANNED'
      : live.state === 'open'
        ? 'LIVE'
        : 'OFFLINE';
  const modeDetail = mockMode
    ? 'Fixture replay — this is NOT the live market'
    : banned
      ? `Upstream host blocked us: ${data?.reason ?? 'no fresh scan until the window closes'}`
      : live.state === 'open'
        ? 'Connected to the live exchange feed'
        : `Stream ${live.state} — figures are from the last successful poll`;

  const open = useCallback((id: string) => {
    setSelected(id.endsWith('USDT') ? id.replace(/USDT$/, '') : id);
    setTicketType('standard');
  }, []);

  const openHero = useCallback((row: AssetRow) => {
    setSelected(row.id);
    setTicketType('hero');
  }, []);

  const openSymbol = useCallback((symbol: string) => {
    setSelected(symbol);
    setTicketType('standard');
  }, []);

  const openOrderBlock = useCallback((row: AssetRow) => {
    setSelected(row.id);
    setTerminalSymbol(row.pair);
    setTicketType('hero');
    setTab('orderblock');
  }, []);

  /**
   * A global-search hit. Board coins open the full order-block experience; a
   * coin that is not on today's board opens its chart instead. Either way the
   * search is a real destination, not a no-op.
   */
  const openSearchHit = useCallback((base: string) => {
    const row = allRows.find((r) => r.base === base || r.id === base) ?? null;
    if (row) {
      openOrderBlock(row);
    } else {
      setSelected(base);
      setTerminalSymbol(base.endsWith('USDT') ? base : `${base}USDT`);
      setTab('charts');
    }
  }, [allRows, openOrderBlock]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'charts', label: 'Charts' },
    { id: 'heatmap', label: 'Heatmap' },
    { id: 'footprint', label: 'Footprint' },
    { id: 'orderblock', label: 'Order Block' },
    { id: 'signals', label: 'Signals' },
    { id: 'radar', label: 'Radar' },
    { id: 'news', label: 'News' },
    { id: 'india', label: 'India' },
  ];

  if (tab === 'heatmap' || tab === 'footprint') {
    return (
      <div className="tradfye-standalone">
        <TerminalView
          view={tab}
          symbol={terminalSymbol}
          onSymbol={setTerminalSymbol}
          mode={mode}
          rows={allRows}
          onExit={() => setTab('dashboard')}
        />
      </div>
    );
  }

  return (
    <div className="min-h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <header className="app-header">
        <div className="app-topbar">
          <div className="app-brand">
            <span className="app-logo" aria-hidden="true">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 18V9" />
                <path d="M9 18V5" />
                <path d="M14 18v-6" />
                <path d="M19 18V8" />
              </svg>
            </span>
            <span className="app-brand-text">
              <span className="app-name">OrderFlow</span>
              <span className="app-tagline hidden md:inline">Order blocks · liquidity · news impact</span>
            </span>
          </div>

          <GlobalSearch onOpen={openSearchHit} />

          <div className="app-topbar-actions">
            {data?.stale && (
              <span
                className="chip shrink-0"
                style={{
                  color: banned ? 'var(--color-down)' : 'var(--color-amber)',
                  background: 'var(--panel-2)',
                }}
                title={data.reason || 'Showing the last saved board while a fresh scan runs.'}
              >
                {banned ? 'BANNED · stale' : 'cached · refreshing'}
              </span>
            )}

            {nextBlackout && <BlackoutCountdown next={nextBlackout} />}
            <StreamNotice />
            <ModeBadge mode={mode} detail={modeDetail} />

            {/* The Mind strip lives in the header, above every tab, because the
                regime and the Brier score are properties of the *model* rather
                than of one screen. A probability on a Signals card means nothing
                without the calibration figures that sit next to this. */}
            <MindHealthStrip health={mindHealth} />

            <button
              type="button"
              onClick={toggle}
              className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-[13px]"
              style={{ background: 'var(--panel-2)', color: 'var(--muted)', border: '1px solid var(--border)' }}
              aria-label="Toggle theme"
              title="Toggle light / dark theme"
            >
              {dark ? '☀' : '☾'}
            </button>
          </div>
        </div>

        <div className="app-navbar">
          <nav className="app-tabs" aria-label="Sections">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`app-tab${tab === t.id ? ' is-active' : ''}`}
                aria-current={tab === t.id ? 'page' : undefined}
              >
                <TabIcon id={t.id} />
                <span>{t.label}</span>
                {t.id === 'news' && news.data && news.data.counts.CRITICAL > 0 && (
                  <span className="app-tab-dot" aria-label="critical news" />
                )}
              </button>
            ))}
          </nav>
        </div>

        {/*
          Fix 3. Unmissable and sticky: mock data must never be mistaken for a
          live market, and the cheapest place for that to go wrong is someone
          screenshotting a board during development.
        */}
        {mockMode && (
          <div role="alert" className="app-banner mock">
            <strong>MOCK DATA</strong>
            <span style={{ fontWeight: 500 }}>
              {health.data?.mock.fixtures ?? 0} fixtures replayed from disk. This is not the live market.
            </span>
          </div>
        )}

        {banned && data?.reason && (
          <div role="alert" className="app-banner banned">
            {data.reason}
          </div>
        )}
      </header>

      {/* Macro strip */}
      <div className="macro-bar">
        <div className="overflow-x-auto">
          <div className="macro-bar-inner">
            <span className="macro-strip-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M4 19V5" />
                <path d="M4 19h16" />
                <path d="M8 16v-5" />
                <path d="M12 16V8" />
                <path d="M16 16v-3" />
              </svg>
              Macro
            </span>
            <MacroStrip macro={macro.data} tracked={data?.totalScanned ?? 0} />
          </div>
        </div>
      </div>

      {/* Main */}
      <main className="flex-1 min-h-0 p-3 lg:p-4">
        <div className={`app-main${railOpen ? ' has-rail' : ''}`}>
          <div className="app-main-page">
        {scan.error && !data && (
          <Empty message="Could not reach the engine." hint={scan.error} />
        )}

        {tab === 'dashboard' && data && (
          <HomeView
            data={data}
            mode={mode}
            onOpenOrderBlock={openOrderBlock}
            onNavigate={setTab}
            // A8: the tracked-asset count comes from the scan's own universe
            // figure with its source, never from a bare CoinGecko field that
            // is null whenever the aggregator is rate limited.
            trackedAssets={data.totalScanned}
            trackedSource={`order flow universe · ${data.totalScanned} scanned`}
          />
        )}

        {tab === 'markets' && (
          <MarketsView onSelect={openSymbol} />
        )}

        {tab === 'charts' && (
          <ChartsTerminal symbol={terminalSymbol} onSymbol={setTerminalSymbol} />
        )}

        {tab === 'orderblock' && data && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/*
              The stage is a fixed 1920x1200 canvas: at laptop widths its labels
              are legible but unlabelled, and the levels inside a ticket mean
              nothing without a key. This bar stays outside the scaled canvas so
              it renders at normal type size on every screen.
            */}
            <section className="stage-intro" aria-label="How to read the order-block board">
              <div>
                <h2>Order Block</h2>
                <p>
                  The strongest bullish and bearish names, ranked by one-directional strength.
                  Each tile is one closed-candle setup — click it to load its ticket below, or
                  open the full chart for every level.
                </p>
              </div>
              <ul className="stage-legend" aria-label="Legend">
                <li><b className="lg-z">Z</b> zone midpoint</li>
                <li><b className="lg-inv">S1 / R1</b> invalidation</li>
                <li><b className="lg-t">R1–R2</b> liquidity ahead</li>
                <li><b className="lg-fan">fan</b> 24h paths · hover a thread</li>
              </ul>
            </section>

            <StageView
              data={data}
              selected={selected}
              onSelect={openSymbol}
              onHero={(symbol) => {
                const row = [...data.bullish, ...data.bearish].find((r) => r.base === symbol || r.id === symbol);
                if (row) openHero(row);
                else openSymbol(symbol);
              }}
              onClear={() => setSelected(null)}
            />

            {/* Detailed ticket popup for the selected row */}
            {selectedRow && (
              <Panel
                title={`${selectedRow.base} · ${selectedRow.name}`}
                subtitle={`${selectedRow.sector} · ${selectedRow.side === 'bullish' ? 'Bullish' : 'Bearish'} setup · ${selectedRow.setup?.ageMinutes ?? '—'}m old`}
                className="h-auto max-h-[520px]"
                right={
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setChartFor(selectedRow.base)}
                      data-testid="open-chart"
                      className="px-2 py-1 rounded text-[10px]"
                      style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}
                    >
                      Full chart
                    </button>
                    <button
                      type="button"
                      onClick={() => setTicketType(ticketType === 'hero' ? 'standard' : 'hero')}
                      className="px-2 py-1 rounded text-[10px]"
                      style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}
                    >
                      {ticketType === 'hero' ? 'Compact' : 'Expanded'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelected(null)}
                      className="px-2 py-1 rounded text-[10px]"
                      style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}
                    >
                      Close
                    </button>
                  </div>
                }
              >
                <TicketPanel
                  row={selectedRow}
                  onClose={() => setSelected(null)}
                  type={ticketType}
                />
              </Panel>
            )}
          </div>
        )}

        {tab === 'signals' && (
          <div className="panel h-full overflow-hidden" style={{ padding: 12 }}>
            <SignalsView />
          </div>
        )}

        {tab === 'radar' && (
          <div className="panel h-full overflow-hidden" style={{ padding: 12 }}>
            <RadarView />
          </div>
        )}

        {tab === 'derivatives' && (
          <DerivativesTab onSelect={open} />
        )}

        {tab === 'news' && (
          <div
            className="grid gap-2 lg:gap-3 lg:grid-cols-[1fr_340px]"
            style={{ height: '100%' }}
          >
            <Panel
              title="News impact"
              subtitle={
                news.data
                  ? `${news.data.items.length} scored headlines · updated ${new Date(news.data.updatedAt).toLocaleTimeString('en-GB')}`
                  : undefined
              }
            >
              {news.loading && !news.data ? <Spinner label="Scoring headlines…" /> : <NewsImpactPanel feed={news.data} />}
            </Panel>
            <Panel title="What moved what" subtitle="Attributing moves to headlines">
              <AttributionPanel data={attribution.data} />
            </Panel>
          </div>
        )}

        {tab === 'india' && (
          <div className="grid gap-2 lg:gap-3 lg:grid-cols-[1fr_320px]" style={{ height: '100%' }}>
            <Panel
              title="Indian market"
              subtitle={india.data?.session.message ?? 'NSE indices, session state and the F&O strength board'}
            >
              {india.loading && !india.data ? <Spinner label="Loading NSE…" /> : <IndiaPanel india={india.data} onSelect={openSymbol} />}
            </Panel>
            <Panel title="Sector flow" subtitle="From the crypto board, for contrast">
              {data ? <SectorFlowPanel sectors={data.sectors} onSelect={openSymbol} /> : <Spinner />}
            </Panel>
          </div>
        )}

        {tab === 'journal' && (
          <div className="panel h-full overflow-hidden">
            <div className="panel-header">
              <div>
                <h2 className="text-[13px] font-semibold tracking-tight">Trading journal</h2>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
                  Stored in this browser. Log the setup, not just the result.
                </p>
              </div>
            </div>
            <div className="h-full min-h-0">
              <Journal />
            </div>
          </div>
        )}

        {tab === 'lab' && (
          <div className="panel h-full overflow-hidden" style={{ padding: 0 }}>
            <EngineLabView />
          </div>
        )}

        {tab === 'learn' && (
          <div className="panel h-full overflow-hidden">
            <LearnView />
          </div>
        )}
          </div>
          <DecisionRail
            symbol={terminalSymbol}
            rows={allRows}
            mode={mode}
            open={railOpen}
            onOpen={() => setRailOpen(true)}
            onClose={() => setRailOpen(false)}
          />
        </div>
      </main>

      {/*
        The full candlestick chart. Mounted above every tab rather than inside
        one, because the chart belongs to an instrument, not to a view ΓÇö a setup
        opened from the Derivatives or News tab deserves the same chart as one
        opened from the board.
      */}
      {chartFor && (
        <AssetPopup
          assetId={chartFor}
          row={chartRow}
          breadthBias={data?.breadthBias ?? 'two-way'}
          sectorAvgChange={chartSectorAvg}
          onClose={() => setChartFor(null)}
        />
      )}
    </div>
  );
}