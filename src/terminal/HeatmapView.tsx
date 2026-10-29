import { useEffect, useMemo, useState } from 'react';
import type { Candle, LiqEvent, TerminalBook, TerminalInterval, TerminalTrade } from '../../shared/types';
import type { BookFrame, PullEvent, SideWall } from './math';
import { INTERVAL_MS, nearestWalls, pullEvents, tapeStats } from './math';
import { fmtUsd } from '../lib/format';
import type { GexSnapshot, PlanContext } from './levels';
import { loadUserLevels, toggleUserLevel } from './levels';
import type { HeatmapSettings } from './settings';
import { MIN_WALL_USD, PULL_WINDOW_MS, WALL_NEAR_PCT } from './settings';
import { buildMockHeatmap } from './mockHeatmap';
import { plainPrice } from './heatmap';
import { HeatmapToolbar } from './HeatmapToolbar';
import { HeatmapCanvas, type LayerToggles } from './HeatmapCanvas';

export interface HeatmapViewProps {
  symbol: string;
  book: TerminalBook | null;
  frames: BookFrame[];
  trades: TerminalTrade[];
  candles: Candle[];
  interval: TerminalInterval;
  settings: HeatmapSettings;
  onSettings: (patch: Partial<HeatmapSettings>) => void;
  plan: PlanContext;
  layers: LayerToggles;
  mock: boolean;
  gamma: GexSnapshot | null;
  gammaError: string | null;
  liqEvents: LiqEvent[];
  liqError: string | null;
  loading: boolean;
  error: string | null;
  tapeError: string | null;
  streamState: string;
  historyFrom: number | null;
  historyError: string | null;
  lastEventAt: number | null;
  lastTradeAt: number | null;
}

function useNow(stepMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(id);
  }, [stepMs]);
  return now;
}

function standing(ms: number): string {
  if (ms < 1_000) return 'under 1s';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1_000);
  if (secs === 0) return `${mins} min`;
  return `${mins}m ${secs}s`;
}

function pullsNear(pulls: PullEvent[], wall: SideWall, horizon: number): number {
  return pulls.filter((pull) => (
    pull.t >= horizon
    && pull.side === wall.side
    && Math.abs(pull.price - wall.price) / Math.max(1e-9, wall.price) <= WALL_NEAR_PCT
  )).length;
}

function WallClause({ wall, side }: { wall: SideWall; side: 'bid' | 'ask' }) {
  return (
    <>
      <b className={`reading-wall is-${side}`}>{side} wall {fmtUsd(wall.usd)}</b>
      <span> at {plainPrice(wall.price, 2)} ({wall.distanceBps.toFixed(1)} bp {side === 'bid' ? 'below' : 'above'}), standing {standing(wall.standingMs)}</span>
    </>
  );
}

export function HeatmapView(props: HeatmapViewProps) {
  const {
    symbol, book, frames, trades, candles, interval, settings, onSettings, plan, layers, mock, gamma, gammaError,
    liqEvents, liqError, loading, error, tapeError, streamState, historyFrom, historyError,
  } = props;
  const [userLevels, setUserLevels] = useState<number[]>(() => {
    const saved = loadUserLevels(symbol);
    return mock && saved.length === 0 ? [80_605.53] : saved;
  });
  const now = useNow();

  useEffect(() => {
    const saved = loadUserLevels(symbol);
    setUserLevels(mock && saved.length === 0 ? [80_605.53] : saved);
  }, [symbol, mock]);

  const mockData = useMemo(
    () => (mock ? buildMockHeatmap(symbol, 0, Date.now()) : null),
    [mock, symbol],
  );
  const shownFrames = mockData?.frames ?? frames;
  const shownTrades = mockData?.trades ?? trades;
  const shownHistoryFrom = mockData ? null : historyFrom;

  const mid = book?.mid ?? shownFrames[shownFrames.length - 1]?.mid ?? 0;
  const stats = tapeStats(shownTrades, mid, INTERVAL_MS[interval], Date.now());
  const walls = useMemo(() => nearestWalls(shownFrames, WALL_NEAR_PCT, 24, MIN_WALL_USD), [shownFrames]);
  const pulls = useMemo(() => pullEvents(shownFrames, shownTrades, 150_000, 40), [shownFrames, shownTrades]);
  const bookAge = book ? Math.max(0, now - book.asOf) : null;
  const tone = !mock && streamState === 'LIVE' && bookAge !== null && bookAge < 3_000 ? 'live' : 'stale';
  const hasWalls = Boolean(walls.bid || walls.ask);
  const horizon = (shownFrames[shownFrames.length - 1]?.asOf ?? Date.now()) - PULL_WINDOW_MS;
  const bidPulls = walls.bid ? pullsNear(pulls, walls.bid, horizon) : 0;
  const askPulls = walls.ask ? pullsNear(pulls, walls.ask, horizon) : 0;
  const shownPlan = mock
    ? {
      ...plan,
      hasSetup: true,
      side: 'bullish' as const,
      entry: 80_590,
      stop: 80_514,
      buyAbove: 80_648,
      sellBelow: 80_514,
      targets: [],
      signal: 'WAIT' as const,
      state: 'WAITING',
      reason: 'Mock composition: plan levels from the reference layout.',
    }
    : plan;

  return (
    <section
      className="heatmap-view"
      aria-label="Liquidity heatmap"
      data-mock={mock ? 'true' : 'false'}
      data-record-start={mockData?.recordStart ?? frames[0]?.asOf ?? ''}
    >
      <div className="chart-status" aria-label="Status readouts">
        <span className="chart-status__item">{interval} candle Δ {stats.candleDeltaQty.toFixed(2)} {symbol.replace(/USDT$/, '')}</span>
        <span className="chart-status__item" style={{ color: stats.cvdUsd >= 0 ? '#16c784' : '#ea3943' }}>CVD {fmtUsd(stats.cvdUsd)}</span>
        <span className="chart-status__item">POC {stats.poc === null ? '\u2014' : plainPrice(stats.poc, 2)}</span>
      </div>

      <HeatmapToolbar
        settings={settings}
        onChange={onSettings}
        library={shownFrames.length > 0}
        history={shownHistoryFrom !== null}
      />

      <div className="chart-reading" title="Measured from the recorded book and tape; nothing here is reconstructed.">
        <span className={`reading-dot is-${tone}`} />
        <span className="reading-copy">
          <span className="reading-prefix">Nearest walls: </span>
          {hasWalls ? (
            <>
          {walls.bid && (
            <>
              <button type="button" className="reading-wall-btn" onClick={() => setUserLevels((prev) => toggleUserLevel(symbol, walls.bid!.price, prev))}>
                <WallClause wall={walls.bid} side="bid" />
              </button>
              {bidPulls > 0 && (
                <span className="reading-pulls"> · {bidPulls}× pulled nearby — may be a bluff</span>
              )}
            </>
          )}
              {walls.bid && walls.ask && <span className="reading-separator"> · </span>}
              {walls.ask && (
                <>
                  <button type="button" className="reading-wall-btn" onClick={() => setUserLevels((prev) => toggleUserLevel(symbol, walls.ask!.price, prev))}>
                    <WallClause wall={walls.ask} side="ask" />
                  </button>
                  {askPulls > 0 && (
                    <span className="reading-pulls"> · {askPulls}× pulled nearby — may be a bluff</span>
                  )}
                </>
              )}
            </>
          ) : (
            <span>No resting level inside 0.1% of mid.</span>
          )}
          <span className="reading-explainer">
            {' '}Price often stalls at walls that have stood for minutes; one that disappears as price gets close was likely a bluff.
          </span>
        </span>
        <span className="state-chip">⟨ {bidPulls > 0 || askPulls > 0 ? 'ARMS' : 'WAIT'}</span>
      </div>

      <div className="heatmap-canvas-wrap">
        <HeatmapCanvas
          symbol={symbol}
          book={mock ? null : book}
          frames={shownFrames}
          trades={shownTrades}
          candles={candles}
          interval={interval}
          settings={settings}
          plan={shownPlan}
          layers={layers}
          gamma={gamma}
          gammaError={gammaError}
          liqEvents={liqEvents}
          liqError={liqError}
          userLevels={userLevels}
          onToggleUserLevel={(price) => setUserLevels((prev) => toggleUserLevel(symbol, price, prev))}
          loading={mock ? false : loading}
          error={mock ? null : error ?? (frames.length === 0 ? historyError : null)}
          tapeError={mock ? null : tapeError}
          streamState={mock ? 'MOCK' : streamState}
          resolutionLabel={mock ? 'MOCK composition \u00b7 2-second columns' : shownHistoryFrom !== null ? 'history 3 s + live 1 s' : 'live 1 s'}
          historyFrom={shownHistoryFrom}
        />
      </div>
    </section>
  );
}
