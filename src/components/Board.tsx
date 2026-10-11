import type { AssetRow, PickRule, Side } from '../../shared/types';
import { fmtCompact, fmtPct, fmtPrice } from '../lib/format';
import { Sparkline } from './Sparkline';
import { FlowArrow, GradeChip, NewsDot, PositionChip, ScoreBar, UnlockChip } from './signalChips';
import type { LivePrice } from '../lib/liveContext';

const RULE_LABEL: Record<PickRule, string> = {
  PICK: 'Pick',
  NOT_PICKED_SECTOR_CAP: 'Sector cap',
  NOT_PICKED_OUTSIDE_TOP_3: 'Outside top 3',
  NOT_PICKED_EVENT_RISK: 'Event risk',
  NOT_PICKED_VETO: 'Vetoed',
  NOT_PICKED_NO_TRADE: 'No trade',
  NOT_PICKED_LOW_GRADE: 'Low grade',
  NOT_PICKED_BLACKOUT: 'Blackout',
  NOT_PICKED_UNLOCK: 'Unlock',
  NOT_PICKED_NO_LIQUIDITY: 'No liquidity',
};

export function Board({
  rows,
  side,
  selected,
  onSelect,
  prices,
}: {
  rows: AssetRow[];
  side: Side;
  selected: string | null;
  onSelect: (row: AssetRow) => void;
  /** Live overlay from the SSE stream, keyed by exchange symbol. */
  prices?: Record<string, LivePrice>;
}) {
  const bullish = side === 'bullish';
  const color = bullish ? 'var(--color-up)' : 'var(--color-down)';

  if (!rows.length) {
    return (
      <div
        className="flex items-center justify-center h-full p-6 text-center text-[12px]"
        style={{ color: 'var(--muted)' }}
      >
        No clean one-directional {side} setups right now.
        <br />
        Choppy assets score zero and are kept off the board.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10" style={{ background: 'var(--panel)' }}>
          <tr style={{ color: 'var(--faint)' }} className="text-[10px] uppercase tracking-wider text-left">
            <th className="font-medium px-2 py-1.5 w-10">#</th>
            <th className="font-medium px-1 py-1.5">Asset</th>
            <th className="font-medium px-1 py-1.5 text-right">Price</th>
            <th className="font-medium px-1 py-1.5 text-right">Move</th>
            <th className="font-medium px-2 py-1.5 hidden sm:table-cell">Str</th>
            <th className="font-medium px-1 py-1.5 text-right">Grade</th>
            <th className="font-medium px-1 py-1.5 text-right hidden sm:table-cell">Score</th>
            <th className="font-medium px-1 py-1.5 text-center hidden md:table-cell">Flow</th>
            <th className="font-medium px-1 py-1.5 hidden lg:table-cell">Pos</th>
            <th className="font-medium px-1 py-1.5 text-center hidden xl:table-cell">News</th>
            <th className="font-medium px-1 py-1.5 text-right hidden md:table-cell">p</th>
            <th className="font-medium px-1 py-1.5 text-right hidden lg:table-cell">R:R</th>
            <th className="font-medium px-1 py-1.5 hidden lg:table-cell w-16">Trend</th>
            <th className="font-medium px-2 py-1.5 hidden xl:table-cell">Rule</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isSel = selected === r.id;
            const moved = r.prevRank !== null && r.prevRank !== r.rank;
            const up = r.prevRank === null ? false : r.prevRank > r.rank;
            const rule: PickRule =
              r.conviction?.rule ??
              (r.eventRisk ? 'NOT_PICKED_EVENT_RISK' : 'NOT_PICKED_LOW_GRADE');
            const grade = r.conviction?.grade;
            const live = prices?.[`${r.base}USDT`];
            // A tick on this row flashes it briefly so movement is noticeable
            // without reading every cell. Respects prefers-reduced-motion via
            // the CSS class, which the animation is gated on.
            const flash = live && live.dir !== 'flat' && Date.now() - live.at < 900;
            return (
              <tr
                key={r.id}
                onClick={() => onSelect(r)}
                className="cursor-pointer of-in border-t"
                style={{
                  borderColor: 'var(--border)',
                  background: isSel
                    ? 'var(--panel-2)'
                    : flash
                      ? `color-mix(in srgb, var(--color-${live.dir === 'up' ? 'up' : 'down'}) 9%, transparent)`
                      : 'transparent',
                  transition: 'background 220ms ease-out',
                }}
              >
                <td className="px-2 py-1.5 mono" style={{ color: 'var(--faint)' }}>
                  <span className="flex items-center gap-1">
                    {String(r.rank).padStart(2, '0')}
                    {moved && (
                      <span style={{ color: up ? 'var(--color-up)' : 'var(--color-down)', fontSize: 9 }}>
                        {up ? 'â–²' : 'â–¼'}
                      </span>
                    )}
                  </span>
                </td>

                <td className="px-1 py-1.5">
                  <span className="flex items-center gap-1.5 min-w-0">
                    {r.isPick || r.conviction?.grade || r.unlock ? (
                      <span className="flex items-center gap-1">
                        {(r.isPick || r.conviction?.grade) && (
                          <span
                            style={{ width: 3, height: 14, borderRadius: 2, background: color, flexShrink: 0 }}
                            title="Pick"
                          />
                        )}
                        <UnlockChip row={r} />
                      </span>
                    ) : null}
                    <span className="font-semibold tracking-tight">{r.base}</span>
                    {r.eventRisk && (
                      <span
                        className="chip"
                        style={{ background: 'rgba(217,119,6,0.16)', color: '#d97706' }}
                        title="Unusually large move â€” event risk, no levels published"
                      >
                        âš 
                      </span>
                    )}
                    <span className="text-[10px] truncate hidden sm:inline" style={{ color: 'var(--faint)' }}>
                      {r.sector}
                    </span>
                  </span>
                </td>

                <td className="px-1 py-1.5 text-right mono">
                  <LivePriceCell row={r} live={prices?.[`${r.base}USDT`]} />
                </td>

                <td className={`px-1 py-1.5 text-right mono font-semibold ${(live?.changePct ?? r.changePct) >= 0 ? 'up' : 'down'}`}>
                  {fmtPct(live?.changePct ?? r.changePct)}
                </td>

                <td className="px-1 py-1.5 text-right mono hidden sm:table-cell" style={{ color: 'var(--muted)' }}>
                  {r.strength.toFixed(2)}
                </td>

                <td className="px-1 py-1.5 text-right">
                  {r.conviction ? <GradeChip grade={r.conviction.grade} /> : <span style={{ color: 'var(--faint)' }}>—</span>}
                </td>

                <td className="px-1 py-1.5 text-right hidden sm:table-cell">
                  {r.conviction ? <ScoreBar score={r.conviction.score} grade={r.conviction.grade} /> : null}
                </td>

                <td className="px-1 py-1.5 text-center hidden md:table-cell">
                  <FlowArrow deriv={r.derivatives} />
                </td>

                <td className="px-1 py-1.5 hidden lg:table-cell">
                  <PositionChip deriv={r.derivatives} />
                </td>

                <td className="px-1 py-1.5 text-center hidden xl:table-cell">
                  <NewsDot row={r} />
                </td>

                <td className="px-1 py-1.5 text-right mono hidden md:table-cell" style={{ color: 'var(--muted)' }}>
                  {r.percentile >= 99.5 ? 'p99+' : `p${r.percentile.toFixed(1)}`}
                </td>

                <td className="px-1 py-1.5 text-right mono hidden lg:table-cell">
                  {r.setup && r.setup.rr > 0 ? (
                    <span style={{ color: r.setup.rr >= 2 ? 'var(--color-up)' : 'var(--muted)' }}>
                      1:{r.setup.rr.toFixed(1)}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--faint)' }}>â€”</span>
                  )}
                </td>

                <td className="px-1 py-1.5 hidden lg:table-cell">
                  <Sparkline data={r.spark} color={color} />
                </td>

                <td className="px-2 py-1.5 hidden xl:table-cell">
                  <span
                    className="chip"
                    style={
                      r.isPick
                        ? { background: color, color: '#fff' }
                        : { background: 'var(--panel-2)', color: 'var(--faint)' }
                    }
                    title={RULE_LABEL[rule] ?? ''}
                  >
                    {r.isPick
                      ? `${grade ?? ''} Pick`.trim()
                      : RULE_LABEL[rule] ?? ''}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > 0 && (
        <p className="px-3 py-2 text-[10px]" style={{ color: 'var(--faint)' }}>
          {fmtCompact(rows.reduce((a, r) => a + r.volumeUsd, 0))} USDT volume across these{' '}
          {rows.length} pairs.
        </p>
      )}
    </div>
  );
}

/**
 * A price cell that prefers the streamed tick over the last scanned price.
 *
 * Falls back silently to the scan value when no tick has arrived, so the board
 * is never blank — it is simply less current, which the freshness badge in the
 * header reports.
 */
function LivePriceCell({ row, live }: { row: AssetRow; live?: LivePrice }) {
  if (!live) return <>{fmtPrice(row.price)}</>;
  return <>{fmtPrice(live.price)}</>;
}