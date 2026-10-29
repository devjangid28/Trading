import { useMemo } from 'react';
import type { AssetRow, TerminalBookLevel } from '../../shared/types';
import { fmtUsd } from '../lib/format';
import { useLivePrice } from '../lib/priceStore';
import type { MarketMode } from '../components/ui';
import { buildPlanContext } from './levels';
import { useTerminalBook } from './useTerminalBook';
import type { TerminalSignal } from './levels';

const DASH = '\u2014';

function priceText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const digits = value >= 1000 ? 2 : value >= 1 ? 3 : value >= 0.01 ? 4 : 6;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function DecisionRail({
  symbol,
  rows,
  mode,
  open,
  onOpen,
  onClose,
  signalOverride,
}: {
  symbol: string;
  rows: AssetRow[];
  mode: MarketMode;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  signalOverride?: TerminalSignal;
}) {
  const base = symbol.replace(/USDT$/, '');
  const live = useLivePrice(symbol);
  const bookState = useTerminalBook(symbol, true, mode === 'LIVE');
  const book = bookState.book?.symbol === symbol ? bookState.book : null;
  const scanRow = useMemo(
    () => rows.find((r) => r.pair === symbol) ?? rows.find((r) => r.base === base) ?? null,
    [rows, symbol, base],
  );
  const price = live?.price ?? scanRow?.price ?? book?.mid ?? null;
  const plan = useMemo(() => buildPlanContext(scanRow, price), [scanRow, price]);
  const signal = signalOverride ?? plan.signal;
  const signalClass = signal === 'BUY' ? 'buy' : signal === 'SELL' ? 'sell' : 'wait';

  const topBids: TerminalBookLevel[] = book?.bids.slice(0, 6) ?? [];
  const topAsks: TerminalBookLevel[] = book?.asks.slice(0, 6) ?? [];
  const domMax = Math.max(
    1,
    book?.bidUsd ?? 0,
    book?.askUsd ?? 0,
    ...topBids.map((l) => l.usd),
    ...topAsks.map((l) => l.usd),
  );
  const imbalance = book && book.bidUsd + book.askUsd > 0
    ? (book.bidUsd - book.askUsd) / (book.bidUsd + book.askUsd)
    : null;
  const stream = bookState.streamState;

  return (
    <aside
      className={`terminal-rail global-rail${open ? ' is-open' : ''}`}
      aria-label="Decision and DOM panel"
      data-testid="decision-rail"
    >
      {!open ? (
        <button type="button" className="rail-collapsed" onClick={onOpen} title="Show the Decision panel and DOM (P)">
          <span className="rail-open" aria-hidden>{'\u2922'}</span>
          <span className={`rail-signal is-${signalClass}`}>{signal}</span>
          <span className="rail-title">DECISION &amp; DOM</span>
          <span className="rail-key">P</span>
        </button>
      ) : (
        <div className="rail-panel">
          <header className="rail-panel__head">
            <span>DECISION &amp; DOM</span>
            <button type="button" onClick={onClose} aria-label="Collapse decision panel" title="Collapse (P)">{'\u2715'}</button>
          </header>
          <div className="rail-symbol">{base}/USDT</div>
          <div className={`decision-hero is-${signalClass}`}>
            <strong>{signal}</strong>
            <span>{plan.state}</span>
          </div>
          <p className="decision-reason">{plan.reason}</p>
          <dl className="decision-levels">
            <div><dt>Entry</dt><dd>{plan.entry === null ? DASH : priceText(plan.entry)}</dd></div>
            <div><dt>Stop</dt><dd>{plan.stop === null ? DASH : priceText(plan.stop)}</dd></div>
            <div><dt>R:R</dt><dd>{plan.rr > 0 ? plan.rr.toFixed(2) : DASH}</dd></div>
            <div>
              <dt>Target</dt>
              <dd>{plan.targets.length ? priceText(plan.targets[0]) : DASH}</dd>
            </div>
          </dl>
          {!plan.hasSetup && (
            <p className="rail-note">No reviewed setup for this market, so the rail stays WAIT and the chart draws no plan line.</p>
          )}
          <div className="dom-head">
            <span>DOM</span>
            <span>{book ? `${fmtUsd(book.bidUsd)} bid / ${fmtUsd(book.askUsd)} ask` : 'no book'}</span>
          </div>
          <div className="dom">
            {topAsks.slice().reverse().map((level) => (
              <div key={`a-${level.price}`} className="dom-row is-ask">
                <span className="dom-price">{priceText(level.price)}</span>
                <span className="dom-size">{fmtUsd(level.usd)}</span>
                <i style={{ width: `${(level.usd / domMax) * 100}%` }} />
              </div>
            ))}
            <div className="dom-mid">
              <span>{book ? priceText(book.mid) : DASH}</span>
              <small>{book ? `${book.spreadBps.toFixed(2)} bp` : DASH}</small>
            </div>
            {topBids.map((level) => (
              <div key={`b-${level.price}`} className="dom-row is-bid">
                <span className="dom-price">{priceText(level.price)}</span>
                <span className="dom-size">{fmtUsd(level.usd)}</span>
                <i style={{ width: `${(level.usd / domMax) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="dom-imbalance">
            <span>Book imbalance</span>
            <div className="dom-bar">
              <i className="is-bid" style={{ width: `${imbalance === null ? 50 : ((imbalance + 1) / 2) * 100}%` }} />
              <i className="is-ask" style={{ width: `${imbalance === null ? 50 : ((1 - imbalance) / 2) * 100}%` }} />
            </div>
            <b className={imbalance === null ? '' : imbalance >= 0 ? 'is-up' : 'is-down'}>
              {imbalance === null ? DASH : `${imbalance >= 0 ? '+' : ''}${(imbalance * 100).toFixed(1)}%`}
            </b>
          </div>
          <p className="rail-note">
            Book {book ? `${fmtUsd(book.bidUsd + book.askUsd)} resting` : 'unavailable'}
            {' '}{'\u00b7'} {stream.toLowerCase()}
            {mode === 'MOCK' ? ` ${'\u00b7'} fixture replay` : ''}
          </p>
        </div>
      )}
    </aside>
  );
}
