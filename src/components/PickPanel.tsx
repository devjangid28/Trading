import { useMemo } from 'react';
import type { AssetRow, PickRule, Side } from '../../shared/types';
import { fmtPct, fmtPrice } from '../lib/format';
import { GradeChip, ScoreBar, FlowArrow, PositionChip, UnlockChip } from './signalChips';
import { Sparkline } from './Sparkline';
import type { LivePrice } from '../lib/liveContext';

/**
 * Top-3 picks per side, with the reason each coin is or is not a pick.
 *
 * The RULE chip is the point of this panel. A ranked list that only shows what
 * the engine chose is not auditable — when the engine is wrong you cannot tell
 * whether it ignored a veto or never applied one. Showing "Vetoed", "Event
 * risk" or "Outside top 3" next to a coin makes the selection rule inspectable,
 * which is the difference between trusting a signal and following one.
 *
 * The number shown is always the rank within the side, so "Bullish #1" means
 * the same thing here as it does on the board.
 */

const RULE_TEXT: Record<PickRule, string> = {
  PICK: 'Top pick',
  NOT_PICKED_SECTOR_CAP: 'Sector cap reached',
  NOT_PICKED_OUTSIDE_TOP_3: 'Outside the top 3',
  NOT_PICKED_EVENT_RISK: 'Event risk',
  NOT_PICKED_VETO: 'Vetoed',
  NOT_PICKED_NO_TRADE: 'No trade',
  NOT_PICKED_LOW_GRADE: 'Low grade',
  NOT_PICKED_BLACKOUT: 'Blackout',
  NOT_PICKED_UNLOCK: 'Unlock nearby',
  NOT_PICKED_NO_LIQUIDITY: 'No liquidity',
};

export function PickPanel({
  rows,
  side,
  prices,
  onSelect,
  selected,
  emptyNote,
}: {
  rows: AssetRow[];
  side: Side;
  prices?: Record<string, LivePrice>;
  onSelect: (row: AssetRow) => void;
  selected: string | null;
  /** Shown when nothing qualifies, so an empty panel explains itself. */
  emptyNote?: string;
}) {
  const top = useMemo(() => rows.slice(0, 3), [rows]);
  const bullish = side === 'bullish';
  const color = bullish ? 'var(--color-up)' : 'var(--color-down)';
  const picks = rows.filter((r) => r.isPick).length;

  if (!top.length) {
    return (
      <div
        className="px-3 py-4 text-[11px]"
        style={{ color: 'var(--muted)' }}
      >
        {emptyNote ?? 'No clean one-directional setups on this side right now.'}
      </div>
    );
  }

  return (
    <div>
      <ul>
        {top.map((r, i) => {
          const live = prices?.[`${r.base}USDT`];
          const rule: PickRule =
            r.conviction?.rule ??
            (r.eventRisk ? 'NOT_PICKED_EVENT_RISK' : 'NOT_PICKED_LOW_GRADE');
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onSelect(r)}
                aria-current={selected === r.id}
                className="w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors"
                style={{
                  borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                  background: selected === r.id ? 'var(--panel-2)' : 'transparent',
                }}
              >
                <span
                  className="shrink-0 w-6 text-right text-[11px] font-bold tabular-nums"
                  style={{ color }}
                  title={`${RULE_TEXT[rule]}`}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5 min-w-0">
                    <b className="text-[13px] tracking-tight truncate">{r.base}</b>
                    {r.conviction && <GradeChip grade={r.conviction.grade} />}
                    <UnlockChip row={r} />
                  </span>
                  <span className="flex items-baseline gap-1.5 text-[10px]" style={{ color: 'var(--faint)' }}>
                    <span className="truncate">{r.sector}</span>
                    <span>·</span>
                    <span className="tabular-nums">{RULE_TEXT[rule]}</span>
                  </span>
                </span>

                <span className="hidden sm:block w-14 shrink-0">
                  <Sparkline data={r.spark} width={56} height={18} />
                </span>

                <span className="text-right shrink-0 w-20">
                  <span className="block text-[12px] tabular-nums mono">{fmtPrice(live?.price ?? r.price)}</span>
                  <span
                    className={`block text-[11px] tabular-nums mono font-semibold ${(live?.changePct ?? r.changePct) >= 0 ? 'up' : 'down'}`}
                  >
                    {fmtPct(live?.changePct ?? r.changePct)}
                  </span>
                </span>

                <span className="hidden md:flex items-center gap-1.5 shrink-0 w-24">
                  {r.conviction && <ScoreBar score={r.conviction.score} grade={r.conviction.grade} />}
                  <FlowArrow deriv={r.derivatives} />
                  <PositionChip deriv={r.derivatives} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {picks === 0 && top.length > 0 && (
        <p
          className="px-3 py-1.5 text-[10px] border-t"
          style={{ color: 'var(--faint)', borderColor: 'var(--border)' }}
        >
          No coin cleared the pick bar today. These are the strongest setups only —
          strength is not the same as tradeable.
        </p>
      )}
    </div>
  );
}