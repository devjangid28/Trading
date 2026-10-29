import { forwardRef } from 'react';
import type { AssetRow, Side } from '../../shared/types';
import { fmtPct, fmtPrice } from '../lib/format';
import { CoinAvatar } from './CoinAvatar';
import { StrengthMeter } from './StrengthMeter';
import { looksTruncated } from '../../shared/identity';
import { useLivePrice } from '../lib/priceStore';

/**
 * One board row.
 *
 * A mirror of the bearish layout is produced by the `is-bear` class alone —
 * `flex-direction: row-reverse` plus `text-align: right` — rather than by a
 * second component. Two components for two mirror images is how the two sides
 * drift apart.
 *
 * Naming rules, which are the point of the whole rebuild:
 *   - The ticker is `displayTicker` in full. `looksTruncated` is asserted in
 *     the layout tests so a regression is a failing test, not a screenshot.
 *   - The name is `displayName`, or an explicit "name unavailable" marker when
 *     it is genuinely unknown. Never a blank and never a guess.
 *   - Exactly ONE side badge. The old row rendered "Bullish" and "Bull" in two
 *     stacked spans that overlapped (A6).
 */

export interface BoardRowProps {
  row: AssetRow;
  side: Side;
  /** 1-based position on the board. */
  rank: number;
  /** Highest strength on the page, used to normalise the meter. */
  maxStrength: number;
  /** Renders the full-size variant (top picks) versus the compact list. */
  size?: 'pick' | 'compact';
  pinned?: boolean;
  /**
   * DOM-bound interaction props. Declared with the event in the signature so
   * the parent cannot pass the wrong shape — the first version of this file
   * declared `(row: AssetRow | null) => void` and every call site was a type
   * error, which is the outcome this signature is designed to produce.
   */
  ref?: React.Ref<HTMLDivElement>;
  onPointerEnter?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerLeave?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLDivElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLDivElement>) => void;
  onActivate?: (row: AssetRow, el: HTMLDivElement) => void;
}

/**
 * Engine rule codes are accurate but unreadable on a board row ("NO" beside
 * "NOT_PICKED_LOW_GRADE" reads as a fault). The row shows a short phrase and
 * keeps the exact code in the tooltip, so the honest reason is never lost.
 */
function ruleText(rule: string): string {
  switch (rule) {
    case 'PICK':
      return 'Pick';
    case 'NOT_PICKED_LOW_GRADE':
      return 'Low grade';
    case 'NOT_PICKED_SECTOR_CAP':
      return 'Sector cap';
    case 'NOT_PICKED_OUTSIDE_TOP_3':
      return 'Outside top 3';
    case 'NOT_PICKED_EVENT_RISK':
      return 'Event risk';
    case 'NOT_PICKED_NO_LIQUIDITY':
      return 'No target';
    case 'NOT_PICKED_BLACKOUT':
      return 'Macro blackout';
    case 'NOT_PICKED_UNLOCK':
      return 'Token unlock';
    case 'NOT_PICKED_VETO':
      return 'Vetoed';
    case 'NOT_PICKED_NO_TRADE':
      return 'No trade';
    default:
      return rule.replace(/^NOT_PICKED_/, '').replace(/_/g, ' ').toLowerCase();
  }
}

export const BoardRowView = forwardRef<HTMLDivElement, BoardRowProps>(function BoardRowView(
  {
    row, side, rank, maxStrength, size = 'compact', pinned = false,
    onPointerEnter, onPointerLeave, onFocus, onBlur, onActivate,
  },
  ref,
) {
  const bull = side === 'bullish';
  const ticker = row.displayTicker || row.base;
  const name = row.displayName ?? row.name ?? '';
  const nameKnown = Boolean(row.displayName || row.name);
  const vetoCount = row.conviction?.vetoes?.length ?? 0;
  const grade = row.conviction?.grade ?? '—';
  const rule = row.conviction?.rule ?? '—';

  // Subscribe to THIS symbol only. A tick for another coin does not re-render
  // this row. The scan value is the fallback until the first live tick arrives.
  const live = useLivePrice(`${row.base}USDT`);
  const changePct = live?.changePct ?? row.changePct;
  const price = live?.price ?? row.price;
  const flash = live?.dir === 'up' ? 'is-up' : live?.dir === 'down' ? 'is-down' : '';
  const cls = [
    'of-row',
    bull ? 'is-bull' : 'is-bear',
    size === 'pick' ? 'of-row--pick' : 'of-row--compact',
    pinned ? 'is-pinned' : '',
    flash,
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={ref}
      className={cls}
      data-testid="board-row"
      data-rank={rank}
      data-side={side}
      data-ticker={ticker}
      data-full-ticker={row.base}
      // `group` gives the keyboard a real focus target with the same affordances
      // as the pointer (C1/E9).
      tabIndex={0}
      role="button"
      aria-label={`${ticker}${nameKnown ? `, ${name}` : ''}, ${fmtPct(changePct)}, rank ${rank}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      // A click or Enter PINS the preview, it does not navigate. The preview's
      // own "Open full view" button is the way to the Order Block stage: a row
      // click used to do both, which unmounted the popup before it could be
      // read (and made the phone's one-tap preview impossible).
      onClick={(e) => onActivate?.(row, e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate?.(row, e.currentTarget);
        }
      }}
    >
      <span className="of-row-rank" data-testid="row-rank">{String(rank).padStart(2, '0')}</span>

      <span className="of-row-av">
        <CoinAvatar ticker={ticker} logoUrl={row.logoUrl} side={side} size={size === 'pick' ? 50 : 38} />
      </span>

      <span className="of-row-text">
        <span className="of-row-line1">
          <b className="of-row-ticker" data-testid="row-ticker">{ticker}</b>
          <span className={`of-badge ${bull ? 'bull' : 'bear'}`} data-testid="row-badge">
            {bull ? 'BULL' : 'BEAR'}
          </span>
        </span>
        <span className="of-row-line2" title={nameKnown ? name : 'Name unavailable for this symbol'}>
          {nameKnown ? name : <em className="of-unknown">name unavailable</em>}
          <span className="of-row-sector">{row.sector}</span>
        </span>
        {size === 'pick' && (
          <span className="of-row-line3">
            <StrengthMeter value={row.strength} max={maxStrength} side={side} />
            <span className="of-row-px" data-testid="row-price">{fmtPrice(price)}</span>
            <span className={`of-row-pct ${changePct >= 0 ? 'up' : 'dn'}`} data-testid="row-pct">
              {fmtPct(changePct)}
            </span>
            <span
              className={`of-status ${row.isPick ? 'is-pick' : vetoCount > 0 ? 'is-veto' : 'is-quiet'}`}
              title={`Grade ${grade}. Rule: ${rule}`}
            >
              <span data-testid="row-grade">{row.isPick ? `${grade} pick` : ruleText(rule)}</span>
              <span data-testid="row-rule" hidden>{rule}</span>
            </span>
          </span>
        )}
        {size === 'compact' && (
          <span className="of-row-compact-right">
            <span className="of-row-px" data-testid="row-price">{fmtPrice(price)}</span>
            <span className={`of-row-pct ${changePct >= 0 ? 'up' : 'dn'}`} data-testid="row-pct">
              {fmtPct(changePct)}
            </span>
            <span
              className={`of-status is-quiet`}
              title={`Grade ${grade}. Rule: ${rule}`}
            >
              <span data-testid="row-grade">{row.isPick ? grade : ruleText(rule)}</span>
              <span data-testid="row-rule" hidden>{rule}</span>
            </span>
          </span>
        )}
      </span>

      <span className="of-row-rankdelta" data-testid="row-rank-delta">
        {row.prevRank === null || row.prevRank === undefined || row.prevRank === row.rank
          ? ''
          : row.prevRank > row.rank
            ? `▲${row.prevRank - row.rank}`
            : `▼${row.rank - row.prevRank}`}
      </span>
    </div>
  );
});

/** Guard used by the layout tests; re-exported so the intent is discoverable. */
export { looksTruncated };