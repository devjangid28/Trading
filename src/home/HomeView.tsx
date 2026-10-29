import { useEffect, useMemo, useRef, useState } from 'react';
import type { AssetRow, ScanResult, Side } from '../../shared/types';
import { fmtPct, istClock, istStamp } from '../lib/format';
import type { Butterfly } from '../../shared/types';
import { ErrorBoundary } from '../components/ErrorBoundary';
import type { MarketMode } from '../components/ui';
import { DepthCurve } from './DepthCurve';
import { BoardRowView } from './BoardRow';
import { RowPreview } from './RowPreview';
import { useRowPreview } from './useRowPreview';
import { SectorsPanel } from './SectorsPanel';
import { HomeSide } from './HomeSide';
import { NewsMiniFeed } from './NewsMiniFeed';
import './home.css';

/**
 * Home page.
 *
 * Structure: a macro strip, then a 2-column grid (main ~76%, sidebar ~24%),
 * then a full-width sectors band. The main card holds the depth curve on top
 * and the two boards below it, split by a 1px vertical divider.
 *
 * The boards are NOT capped at three: the top three are rendered at full size
 * and the remainder as a compact list, because hiding ranks 4-20 means a coin
 * can be on the board and invisible, which is the same class of problem as the
 * two-letter ticker.
 *
 * Nothing here reads a global for layout or timing; the timing constants live
 * in `motion.ts` and the bucket maths in `depthBuckets.ts` so both can be
 * asserted directly by tests.
 */

export interface HomeViewProps {
  data: ScanResult;
  onOpenOrderBlock: (row: AssetRow) => void;
  onNavigate: (tab: 'journal' | 'learn') => void;
  trackedAssets?: number;
  trackedSource?: string;
  butterfly?: Butterfly;
  /**
   * The market source mode, shared with the app header. The live pill reflects
   * it instead of asserting "LIVE 24/7" unconditionally: under MOCK, BANNED or
   * OFFLINE the pill says so and drops the "24/7" claim.
   */
  mode?: MarketMode;
}

const PICKS = 3;
const COMPACT_TO = 20;

export function HomeView({
  data, onOpenOrderBlock, onNavigate,
  trackedAssets, trackedSource,
  mode = 'LIVE',
}: HomeViewProps) {
  const all = useMemo(() => [...data.bullish, ...data.bearish], [data]);
  const maxStrength = useMemo(
    () => Math.max(0.001, ...all.map((r) => r.strength)),
    [all],
  );

  const preview = useRowPreview(all);
  const bullRefs = useRef(new Map<string, HTMLElement>());
  const bearRefs = useRef(new Map<string, HTMLElement>());

  // Breadth comes from the scan's market picture, which is built with the SAME
  // strength gate the depth curve uses (see `universeRows`). That is deliberately
  // not the 1s aggregate's change-sign breadth: the two use different
  // definitions of "bullish"/"choppy", and mixing them is what produced a
  // "choppy 0" chip beside a 16-coin choppy curve. One definition, one source.
  const breadth = {
    up: data.market.bullishCount,
    down: data.market.bearishCount,
    flat: data.market.choppyCount,
    n: data.market.total,
  };

  return (
    <div className="of-home of-in">
      <ErrorBoundary label="Market depth">
        <section className="of-card of-main" data-testid="main-card">
          <header className="of-main-h">
            <span
              className={`of-live of-live-${mode.toLowerCase()}`}
              data-testid="live-pill"
              data-mode={mode}
              title={
                mode === 'LIVE'
                  ? 'Connected to the live exchange feed'
                  : mode === 'MOCK'
                    ? 'Fixture replay — not a live market'
                    : mode === 'BANNED'
                      ? 'The upstream exchange host is rate-limiting us'
                      : 'Stream offline — figures are from the last poll'
              }
            >
              <i />
              {mode}
              {/* "24/7" is a live-market claim; only make it when actually live. */}
              {mode === 'LIVE' && <u>24/7</u>}
            </span>
            <span className="of-main-h-r">
              <b>Market depth</b>
              <time data-testid="as-of" title="When the SETUPS were last recomputed. Prices below are live and newer.">
                setups as of {istStamp(data.updatedAt)} IST
              </time>
              <LiveClock />
            </span>
            <div
              className="of-depth-chips"
              data-testid="breadth-chips"
              title="Breadth over the whole scanned universe. Chips, depth curve and 'of N' share one denominator."
            >
              <span className="of-chip bullish" data-testid="chip-bullish">
                <b>{breadth.up}</b> bullish
              </span>
              <span className="of-chip bearish" data-testid="chip-bearish">
                <b>{breadth.down}</b> bearish
              </span>
              <span className="of-chip choppy" data-testid="chip-choppy">
                <b>{breadth.flat}</b> choppy
              </span>
              <span className="of-chip total" data-testid="chip-total">
                of {breadth.n}
              </span>
            </div>
          </header>

          <DepthCurve data={data} />
          <p className="of-depth-note">
            Each bar counts pairs at that 24h move. “Choppy” is a move that went nowhere — it is
            never a pick.
          </p>

          <hr className="of-rule" />

          <div className="of-boards" data-testid="boards">
            <BoardColumn
              side="bullish"
              rows={data.bullish}
              total={breadth.up}
              maxStrength={maxStrength}
              refs={bullRefs}
              preview={preview}
            />
            <div className="of-boards-sep" aria-hidden="true" />
            <BoardColumn
              side="bearish"
              rows={data.bearish}
              total={breadth.down}
              maxStrength={maxStrength}
              refs={bearRefs}
              preview={preview}
            />
          </div>
        </section>
      </ErrorBoundary>

      <ErrorBoundary label="Side panel">
        <aside className="of-side" data-testid="sidebar">
          <HomeSide onNavigate={onNavigate} trackedAssets={trackedAssets} trackedSource={trackedSource} />
        </aside>
      </ErrorBoundary>

      <div className="of-lower">
        <ErrorBoundary label="Sectors">
          <SectorsPanel data={data} />
        </ErrorBoundary>
        <ErrorBoundary label="News">
          <NewsMiniFeed />
        </ErrorBoundary>
      </div>

      {/*
        Rendered in a fixed layer OUTSIDE the grid, so opening it cannot shift
        any layout. The layout tests assert cumulative shift 0 on open.
      */}
      <ErrorBoundary label="Preview">
        <div
          className="of-popup-layer"
          onPointerEnter={preview.handlers.onPopupEnter}
          onPointerLeave={preview.handlers.onPopupLeave}
        >
          <RowPreview
            row={preview.state.row}
            anchor={preview.state.anchor}
            pinned={preview.state.pinned}
            onClose={preview.close}
            onPrev={() => preview.step(-1)}
            onNext={() => preview.step(1)}
            onOpenFull={onOpenOrderBlock}
          />
        </div>
      </ErrorBoundary>
    </div>
  );
}

function BoardColumn({
  side, rows, total, maxStrength, refs, preview,
}: {
  side: Side;
  rows: AssetRow[];
  /** Universe-wide count for this side, so the header says "showing X of Y". */
  total: number;
  maxStrength: number;
  refs: React.MutableRefObject<Map<string, HTMLElement>>;
  preview: ReturnType<typeof useRowPreview>;
}) {
  const bull = side === 'bullish';
  const picks = rows.slice(0, PICKS);
  const rest = rows.slice(PICKS, COMPACT_TO);
  const vetoed = rows.filter((r) => (r.conviction?.vetoes.length ?? 0) > 0).length;

  const setRef = (base: string) => (el: HTMLDivElement | null) => {
    if (el) refs.current.set(base, el);
    else refs.current.delete(base);
  };

  const bind = (r: AssetRow) => ({
    ref: setRef(r.base),
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') preview.handlers.onRowPointerEnter(r, e.currentTarget as HTMLElement);
    },
    onPointerLeave: (e: React.PointerEvent) => preview.handlers.onRowPointerLeave(e),
    onFocus: (e: React.FocusEvent) => preview.handlers.onRowFocus(r, e.currentTarget as HTMLElement),
    onBlur: () => preview.handlers.onRowBlur(),
    onActivate: () => preview.handlers.onRowActivate(r, refs.current.get(r.base) ?? null),
  });

  return (
    <section className={`of-board ${bull ? 'is-bull' : 'is-bear'}`} data-testid={`board-${side}`}>
      <header className="of-board-h">
        <span className="of-board-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            {bull
              ? <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>
              : <><path d="M3 7l6 6 4-4 8 8" /><path d="M15 17h6v-6" /></>}
          </svg>
        </span>
        <h2>{bull ? 'Bullish' : 'Bearish'}</h2>
        <span
          className="of-board-cnt"
          title={`Showing the top ${rows.length} of ${total} ${bull ? 'bullish' : 'bearish'} coins in the scanned universe.`}
        >
          <b data-testid={`board-count-${side}`}>{rows.length}</b> of {total}
        </span>
      </header>

      {rows.length === 0 ? (
        <div className="of-slot-empty" data-testid="board-empty">
          <b>No clean {bull ? 'bullish' : 'bearish'} setup</b>
          <span>
            {vetoed > 0
              ? `${vetoed} coin${vetoed === 1 ? '' : 's'} vetoed â€” the system refused to chase an overextended move.`
              : 'nothing moved cleanly against current structure'}
          </span>
        </div>
      ) : (
        <>
          <div className="of-picks">
            {picks.map((r, i) => (
              <div key={r.base} className="of-pick-slot">
                <BoardRowView
                  {...bind(r)}
                  row={r}
                  side={side}
                  rank={i + 1}
                  maxStrength={maxStrength}
                  size="pick"
                  pinned={preview.state.row?.base === r.base && preview.state.pinned}
                />
              </div>
            ))}
            {picks.length < PICKS && (
              <div className="of-slot-empty" data-testid="board-short">
                <b>{PICKS - picks.length} empty slot{picks.length === PICKS - 1 ? '' : 's'}</b>
                <span>
                  only {picks.length} coin{picks.length === 1 ? '' : 's'} qualified
                  {vetoed > 0 ? `; ${vetoed} vetoed` : ''}
                </span>
              </div>
            )}
          </div>

          {rest.length > 0 && (
            <div className="of-rest" data-testid={`rest-${side}`}>
              {rest.map((r, i) => (
                <BoardRowView
                  key={r.base}
                  {...bind(r)}
                  row={r}
                  side={side}
                  rank={PICKS + i + 1}
                  maxStrength={maxStrength}
                  size="compact"
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export { fmtPct };

/**
 * The live IST wall clock.
 *
 * Its own component so its once-a-second tick re-renders only the clock, never
 * `HomeView`. It is deliberately separate from the "setups as of HH:MM" stamp:
 * the stamp is when the SETUPS were recomputed (up to a minute old), while the
 * clock is now. Showing one number for both is how a stale board looks live.
 */
function LiveClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span
      className="of-clock"
      data-testid="live-clock"
      title="Live clock (IST). The 'setups as of' time above is when the setups were last recomputed."
    >
      {istClock(now)} IST
    </span>
  );
}

