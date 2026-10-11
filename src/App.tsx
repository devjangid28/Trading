import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, usePolling, type CalendarResult } from './lib/api';
import type { AssetRow, ScanResult } from '../shared/types';
import { Board } from './components/Board';
import { MarketPictureStrip } from './components/MarketPicture';
import { SectorFlowPanel } from './components/SectorFlow';
import { MacroStrip } from './components/MacroStrip';
import { NewsImpactPanel } from './components/NewsImpactPanel';
import { DerivativesTab } from './components/DerivativesTab';
import { AttributionPanel } from './components/AttributionPanel';
import { AssetPopup } from './components/AssetPopup';
import { IndiaPanel } from './components/IndiaPanel';
import { Journal } from './components/Journal';
import { Empty, FreshnessBadge, Panel, Spinner } from './components/ui';
import { BlackoutCountdown } from './components/BlackoutCountdown';
import { ButterflyChart } from './components/ButterflyChart';
import { PickPanel } from './components/PickPanel';
import { useLiveStreamProvider, useLive } from './lib/liveContext';

type Tab = 'terminal' | 'derivatives' | 'news' | 'india' | 'journal' | 'learn';

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
            <li>Market cap, dominance, Fear &amp; Greed — CoinGecko and alternative.me</li>
            <li>Stablecoin float — DefiLlama</li>
            <li>News — CoinDesk, Cointelegraph, Decrypt, Bitcoin Magazine, Bitcoin.com, CryptoSlate RSS</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { dark, toggle } = useTheme();
  const [tab, setTab] = useState<Tab>('terminal');
  const [selected, setSelected] = useState<string | null>(null);
  // Tabs that have been opened at least once. Feeds which are only needed by a
  // specific tab are held back until then, so the first load is not crowded by
  // the NSE/Yahoo pull and the attribution pass competing with the scan.
  const [visited, setVisited] = useState<Record<string, boolean>>({ terminal: true });
  useEffect(() => {
    setVisited((v) => (v[tab] ? v : { ...v, [tab]: true }));
  }, [tab]);

  const scan = usePolling<ScanResult>((s) => api.scan(s), 60_000);
  const news = usePolling((s) => api.news(s), 120_000);
  const macro = usePolling((s) => api.macro(s), 120_000);
  const india = usePolling((s) => api.india(s), 180_000, [], visited.india === true);
  const attribution = usePolling((s) => api.attributionAll(s), 120_000, [], visited.news === true);
  // The countdown is long-lived: event times do not change minute to minute,
  // so polling it on the scan cadence would be wasted requests. The component
  // itself ticks locally off the server timestamp.
  const calendar = usePolling<CalendarResult>((s) => api.calendar(s), 300_000);
  const nextBlackout = calendar.data?.nextBlackout ?? null;

  // One SSE socket for the whole app. Mounted before the panels so the price
  // overlay is available to every consumer; polling stays as the fallback if
  // the socket never opens.
  useLiveStreamProvider(scan.data);
  const live = useLive();
  // Prefer the pushed scan; fall back to the polled one until the socket's
  // first snapshot arrives.
  const scanData = live.scan ?? scan.data;

  const data = scanData;
  const rows: AssetRow[] = useMemo(
    () => (data ? [...data.bullish, ...data.bearish] : []),
    [data],
  );
  const selectedRow = rows.find((r) => r.id === selected) ?? null;
  const sectorAvg = useMemo(
    () => data?.sectors.find((s) => s.sector === selectedRow?.sector)?.avgChange ?? null,
    [data, selectedRow],
  );

  const open = useCallback((id: string) => {
    setSelected(id.endsWith('USDT') ? id.replace(/USDT$/, '') : id);
  }, []);

  const biasMeta =
    data?.breadthBias === 'bullish'
      ? { text: 'One-sided bullish', color: 'var(--color-up)' }
      : data?.breadthBias === 'bearish'
        ? { text: 'One-sided bearish', color: 'var(--color-down)' }
        : { text: 'Two-way day', color: 'var(--color-amber)' };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'terminal', label: 'Terminal' },
    { id: 'derivatives', label: 'Derivatives' },
    { id: 'news', label: 'News' },
    { id: 'india', label: 'India' },
    { id: 'journal', label: 'Journal' },
    { id: 'learn', label: 'How it works' },
  ];

  return (
    <div className="min-h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      {/* Header */}
      <header
        className="sticky top-0 z-30 flex items-center gap-3 px-3 py-2 border-b"
        style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}
      >
        <div className="flex items-baseline gap-2 shrink-0">
          <span className="text-[15px] font-bold tracking-tight">OrderFlow</span>
          <span className="text-[10px] hidden sm:inline" style={{ color: 'var(--faint)' }}>
            order blocks · liquidity · news impact
          </span>
        </div>

        <nav className="flex items-center gap-0.5 overflow-x-auto flex-1 min-w-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className="px-2.5 py-1 rounded-md text-[12px] font-medium whitespace-nowrap shrink-0"
              style={
                tab === t.id
                  ? { background: 'var(--panel-2)', color: 'var(--text)' }
                  : { color: 'var(--muted)' }
              }
            >
              {t.label}
              {t.id === 'news' && news.data && news.data.counts.CRITICAL > 0 && (
                <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full" style={{ background: 'var(--color-down)' }} />
              )}
            </button>
          ))}
        </nav>

        {nextBlackout && <BlackoutCountdown next={nextBlackout} />}

        {data?.stale && (
          <span
            className="chip shrink-0"
            style={{ color: 'var(--color-amber)', background: 'var(--panel-2)' }}
            title={data.reason || 'Showing the last saved board while a fresh scan runs.'}
          >
            cached · refreshing
          </span>
        )}

        <FreshnessBadge ageMs={live.lastDataAt === null ? null : Date.now() - live.lastDataAt} />

        <button
          type="button"
          onClick={toggle}
          className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-[13px]"
          style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}
          aria-label="Toggle theme"
          title="Toggle theme"
        >
          {dark ? '☀' : '☾'}
        </button>
      </header>

      {/* Macro strip */}
      <div className="border-b shrink-0" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
        <MacroStrip macro={macro.data} />
      </div>

      {/* Main */}
      <main className="flex-1 min-h-0 p-2 lg:p-3">
        {scan.error && !data && (
          <Empty message="Could not reach the engine." hint={scan.error} />
        )}

        {tab === 'terminal' && (
          <div className="grid gap-2 lg:gap-3 lg:grid-cols-[1fr_320px]" style={{ height: '100%' }}>
            <div className="flex flex-col gap-2 lg:gap-3 min-h-0">
              <Panel
                title="Market picture"
                subtitle={
                  data
                    ? `${data.totalScanned} pairs tracked · ${biasMeta.text} · leading ${
                        data.market.leadingSector ?? '—'
                      } · lagging ${data.market.laggingSector ?? '—'}`
                    : 'Loading…'
                }
                right={
                  data && (
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="up font-semibold">▲ {data.market.bullishCount}</span>
                      <span className="down font-semibold">▼ {data.market.bearishCount}</span>
                      <button
                        type="button"
                        onClick={scan.refresh}
                        className="px-2 py-0.5 rounded"
                        style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}
                      >
                        Refresh
                      </button>
                    </div>
                  )
                }
              >
                {data ? (
                  <>
                    <ButterflyChart
                      data={data.butterfly}
                      picks={new Set(rows.filter((r) => r.isPick).map((r) => r.base))}
                    />
                    <div className="mt-1.5 pt-1.5 border-t" style={{ borderColor: 'var(--border)' }}>
                      <MarketPictureStrip market={data.market} onPick={open} />
                    </div>
                  </>
                ) : (
                  <Spinner />
                )}
              </Panel>

              <div className="grid md:grid-cols-2 gap-2 lg:gap-3 shrink-0">
                <Panel
                  title="Top 3 bullish"
                  subtitle="Highest-ranked setups, with why each is or is not a pick"
                  className="min-h-0"
                >
                  {data ? (
                    <PickPanel
                      rows={data.bullish}
                      side="bullish"
                      prices={live.prices}
                      selected={selected}
                      onSelect={(r) => open(r.id)}
                    />
                  ) : <Spinner />}
                </Panel>
                <Panel
                  title="Top 3 bearish"
                  subtitle="Highest-ranked setups, with why each is or is not a pick"
                  className="min-h-0"
                >
                  {data ? (
                    <PickPanel
                      rows={data.bearish}
                      side="bearish"
                      prices={live.prices}
                      selected={selected}
                      onSelect={(r) => open(r.id)}
                    />
                  ) : <Spinner />}
                </Panel>
              </div>

              <div className="grid md:grid-cols-2 gap-2 lg:gap-3 min-h-0 flex-1">
                <Panel title="Bullish" subtitle="Strongest one-directional moves first" className="min-h-[280px]">
                  {data ? (
<Board
                      rows={data.bullish}
                      side="bullish"
                      prices={live.prices}
                      selected={selected}
                      onSelect={(r) => open(r.id)}
                    />
                  ) : (
                    <Spinner />
                  )}
                </Panel>
                <Panel title="Bearish" subtitle="Strongest one-directional moves first" className="min-h-[280px]">
                  {data ? (
<Board
                      rows={data.bearish}
                      side="bearish"
                      prices={live.prices}
                      selected={selected}
                      onSelect={(r) => open(r.id)}
                    />
                  ) : (
                    <Spinner />
                  )}
                </Panel>
              </div>
            </div>

            <Panel title="Sector flow" subtitle="Average move of each sector's coins" className="min-h-[260px]">
              {data ? <SectorFlowPanel sectors={data.sectors} onSelect={open} /> : <Spinner />}
            </Panel>
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
              {india.loading && !india.data ? <Spinner label="Loading NSE…" /> : <IndiaPanel india={india.data} onSelect={open} />}
            </Panel>
            <Panel title="Sector flow" subtitle="From the crypto board, for contrast">
              {data ? <SectorFlowPanel sectors={data.sectors} onSelect={open} /> : <Spinner />}
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

        {tab === 'learn' && (
          <div className="panel h-full overflow-hidden">
            <LearnView />
          </div>
        )}
      </main>

      {selected && (
        <AssetPopup
          assetId={selected}
          row={selectedRow}
          breadthBias={data?.breadthBias ?? 'two-way'}
          sectorAvgChange={sectorAvg}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
