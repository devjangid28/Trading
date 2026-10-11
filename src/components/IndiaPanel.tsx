import type { IndianMarket } from '../../shared/types';
import { fmtPct, fmtPrice } from '../lib/format';
import { Sparkline } from './Sparkline';
import { Chip } from './ui';

export function IndiaPanel({
  india,
  onSelect,
}: {
  india: IndianMarket | null;
  onSelect: (symbol: string) => void;
}) {
  if (!india) {
    return (
      <div className="p-6 text-center text-[12px]" style={{ color: 'var(--muted)' }}>
        Loading NSE…
      </div>
    );
  }

  const { session, open, holidayToday, nextHoliday, indices, fno } = india;
  const statusColor = open ? 'var(--color-up)' : holidayToday ? 'var(--color-amber)' : 'var(--muted)';

  return (
    <div className="h-full overflow-y-auto">
      <div
        className="px-3 py-2 border-b flex items-center justify-between gap-2 flex-wrap"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="chip"
            style={{ background: `color-mix(in srgb, ${statusColor} 16%, transparent)`, color: statusColor }}
          >
            {session.state}
          </span>
          <span className="text-[11px] truncate" style={{ color: 'var(--muted)' }}>
            {session.message}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--faint)' }}>
          <span title="Equity derivatives now close at 15:40 under circular NSE/FAOP/74467, effective 3 Aug 2026">
            F&amp;O 09:15–15:40 IST
          </span>
          {nextHoliday && (
            <span title={nextHoliday.description}>
              Next hol: {nextHoliday.date}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-px" style={{ background: 'var(--border)' }}>
        {indices.map((i) => (
          <div key={i.name} className="px-3 py-2" style={{ background: 'var(--panel)' }}>
            <div className="text-[10px] truncate" style={{ color: 'var(--faint)' }}>
              {i.name}
            </div>
            <div className="mono text-[13px] font-semibold">{fmtPrice(i.last)}</div>
            <div className={`mono text-[11px] ${i.percentChange >= 0 ? 'up' : 'down'}`}>
              {fmtPct(i.percentChange)}
            </div>
          </div>
        ))}
        {!indices.length && (
          <div className="col-span-full px-3 py-3 text-[11px]" style={{ color: 'var(--muted)', background: 'var(--panel)' }}>
            NSE index feed unavailable right now.
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
        <h3 className="text-[11px] font-semibold tracking-tight">F&amp;O strength board</h3>
        <p className="text-[10px] mt-0.5" style={{ color: 'var(--faint)' }}>
          The same one-directional engine, run over liquid NSE F&amp;O stocks.
        </p>
      </div>

      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-left" style={{ color: 'var(--faint)' }}>
            <th className="font-medium px-3 py-1.5">Symbol</th>
            <th className="font-medium px-1 py-1.5 text-right">Price</th>
            <th className="font-medium px-1 py-1.5 text-right">Move</th>
            <th className="font-medium px-1 py-1.5 text-right hidden sm:table-cell">Str</th>
            <th className="font-medium px-3 py-1.5 text-right">Trend</th>
          </tr>
        </thead>
        <tbody>
          {fno.map((r) => (
            <tr
              key={r.symbol}
              onClick={() => onSelect(r.symbol)}
              className="cursor-pointer border-t"
              style={{ borderColor: 'var(--border)' }}
            >
              <td className="px-3 py-1.5">
                <span className="font-semibold">{r.symbol}</span>
                <span className="text-[10px] ml-1.5" style={{ color: 'var(--faint)' }}>
                  {r.sector}
                </span>
              </td>
              <td className="px-1 py-1.5 text-right mono">{fmtPrice(r.price)}</td>
              <td className={`px-1 py-1.5 text-right mono font-semibold ${r.changePct >= 0 ? 'up' : 'down'}`}>
                {fmtPct(r.changePct)}
              </td>
              <td className="px-1 py-1.5 text-right mono hidden sm:table-cell" style={{ color: 'var(--muted)' }}>
                {r.strength.toFixed(2)}
              </td>
              <td className="px-3 py-1.5 text-right">
                <span className="inline-block">
                  <Sparkline data={r.spark} />
                </span>
              </td>
            </tr>
          ))}
          {!fno.length && (
            <tr>
              <td colSpan={5} className="px-3 py-4 text-[11px]" style={{ color: 'var(--muted)' }}>
                No Indian equity data right now. Yahoo needs its cookie+crumb handshake and can be
                slow or rate-limited; the crypto terminal is unaffected.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="px-3 py-2 border-t" style={{ borderColor: 'var(--border)' }}>
        <p className="text-[10px] leading-relaxed" style={{ color: 'var(--faint)' }}>
          NSE publishes the holiday calendar with no API key; the F&amp;O bucket is keyed{' '}
          <code className="mono">FO</code>, not <code className="mono">FNO</code>. Live option-chain
          data is licensed by the exchange and has no free source.
        </p>
      </div>
    </div>
  );
}

export function HolidayChip({ india }: { india: IndianMarket | null }) {
  if (!india) return null;
  if (india.holidayToday) {
    return <Chip color="#d97706" bg="rgba(217,119,6,0.16)">NSE holiday: {india.holidayToday}</Chip>;
  }
  if (india.nextHoliday) {
    return (
      <Chip title={india.nextHoliday.description}>
        Next NSE holiday {india.nextHoliday.date}
      </Chip>
    );
  }
  return null;
}
