import type { SectorFlow } from '../../shared/types';
import { fmtPct } from '../lib/format';

export function SectorFlowPanel({
  sectors,
  onSelect,
}: {
  sectors: SectorFlow[];
  onSelect?: (symbol: string) => void;
}) {
  if (!sectors.length) {
    return (
      <div className="p-4 text-[12px]" style={{ color: 'var(--muted)' }}>
        No sector data yet.
      </div>
    );
  }

  const maxAbs = Math.max(0.5, ...sectors.map((s) => Math.abs(s.avgChange)));

  return (
    <div className="overflow-y-auto h-full">
      {sectors.map((s) => {
        const width = (Math.abs(s.avgChange) / maxAbs) * 50;
        const positive = s.avgChange >= 0;
        const color = positive ? 'var(--color-up)' : 'var(--color-down)';
        return (
          <div key={s.sector} className="border-b px-3 py-2 last:border-0" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11.5px] font-medium truncate flex items-center gap-1.5">
                {s.leading && (
                  <span className="chip" style={{ background: 'var(--color-up)', color: '#fff' }}>
                    Lead
                  </span>
                )}
                {s.lagging && (
                  <span className="chip" style={{ background: 'var(--color-down)', color: '#fff' }}>
                    Lag
                  </span>
                )}
                <span className="truncate">{s.sector}</span>
              </span>
              <span className={`mono text-[11.5px] font-semibold shrink-0 ${positive ? 'up' : 'down'}`}>
                {fmtPct(s.avgChange)}
              </span>
            </div>

            {/* Diverging bar: half-width either side of a centre line */}
            <div className="relative h-1.5 mt-1.5" style={{ background: 'var(--panel-2)', borderRadius: 999 }}>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: positive ? '50%' : `${50 - width}%`,
                  width: `${width}%`,
                  background: color,
                  borderRadius: 999,
                }}
              />
              <div style={{ position: 'absolute', left: '50%', top: -1, bottom: -1, width: 1, background: 'var(--border)' }} />
            </div>

            <div className="flex flex-wrap gap-1 mt-1.5">
              {s.members.map((m) => {
                const cellColor = m.changePct >= 0 ? 'var(--color-up)' : 'var(--color-down)';
                return (
                  <button
                    key={m.symbol}
                    type="button"
                    onClick={() => onSelect?.(m.symbol)}
                    title={`${m.symbol} ${fmtPct(m.changePct)}`}
                    className="mono text-[9.5px] px-1.5 py-0.5 rounded"
                    style={{
                      background: `color-mix(in srgb, ${cellColor} 14%, transparent)`,
                      color: cellColor,
                      border: '1px solid transparent',
                    }}
                  >
                    {m.symbol}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <p className="px-3 py-2 text-[10px]" style={{ color: 'var(--faint)' }}>
        No more than two picks come from one sector, so a single sector's news cannot fill the shortlist.
      </p>
    </div>
  );
}
