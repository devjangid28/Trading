import type { Attribution } from '../../shared/types';
import { fmtPct, fmtPrice } from '../lib/format';

const BAND_STYLE: Record<Attribution['band'], { color: string; label: string; hint: string }> = {
  DRIVEN_BY_NEWS: {
    color: 'var(--color-up)',
    label: 'Driven by news',
    hint: 'Most of this move is accounted for by recent headlines.',
  },
  PARTIALLY_ATTRIBUTED: {
    color: 'var(--color-amber)',
    label: 'Partially attributed',
    hint: 'Some of the move is news. The rest is flow, order flow or liquidation.',
  },
  NO_CLEAR_DRIVER: {
    color: 'var(--faint)',
    label: 'No clear driver',
    hint: 'The move is not statistically significant, or no news explains it. Likely flow or technicals.',
  },
};

export function AttributionPanel({ data }: { data: { horizon: number; attributions: Attribution[] } | null }) {
  if (!data) {
    return (
      <div className="p-6 text-center text-[12px]" style={{ color: 'var(--muted)' }}>
        Computing what moved what…
      </div>
    );
  }
  if (!data.attributions.length) {
    return (
      <div className="p-6 text-center text-[12px]" style={{ color: 'var(--muted)' }}>
        No attribution available.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-3 py-1.5 text-[10px] border-b" style={{ color: 'var(--faint)', borderColor: 'var(--border)' }}>
        Abnormal return = raw move − (BTC beta × BTC move) over {data.horizon}m. Attribution only
        runs when the move clears a 2.5σ gate.
      </div>

      {data.attributions.map((a) => {
        const band = BAND_STYLE[a.band];
        return (
          <div key={a.symbol} className="border-b px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-[13px] font-semibold">{a.symbol}</span>
                <span className="mono text-[11px]" style={{ color: 'var(--muted)' }}>
                  {fmtPrice(a.price)}
                </span>
              </div>
              <span
                className={`mono text-[12px] font-semibold ${a.abnormalReturnPct >= 0 ? 'up' : 'down'}`}
                title="Move after removing what BTC's move would imply"
              >
                {fmtPct(a.abnormalReturnPct)}
              </span>
            </div>

            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className="chip" style={{ background: 'transparent', color: band.color, border: `1px solid ${band.color}33` }} title={band.hint}>
                {band.label}
              </span>
              <span className="mono text-[10px]" style={{ color: 'var(--faint)' }}>
                move {a.moveZ.toFixed(1)}σ · vol {a.volZ.toFixed(1)}σ
              </span>
              {a.reversalRisk >= 0.6 && (
                <span className="chip" style={{ background: 'rgba(217,119,6,0.14)', color: '#d97706' }}>
                  ↩ reversal risk
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 mt-1.5 text-[10px] mono" style={{ color: 'var(--faint)' }}>
              <span>raw {fmtPct(a.rawReturnPct)}</span>
              <span>− expected {fmtPct(a.expectedReturnPct)}</span>
              {a.significant ? (
                <>
                  <span className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'var(--panel-2)' }}>
                    <span
                      style={{
                        display: 'block',
                        width: `${a.coverage * 100}%`,
                        height: '100%',
                        background: band.color,
                      }}
                    />
                  </span>
                  <span>coverage {Math.round(a.coverage * 100)}%</span>
                </>
              ) : (
                <span className="flex-1 text-right">
                  move below 2.5σ — not attributed
                </span>
              )}
            </div>

            {a.entries.length > 0 && (
              <ul className="mt-2 space-y-1">
                {a.entries.slice(0, 3).map((e) => (
                  <li key={e.newsId} className="flex items-start gap-2">
                    <span
                      className="mono text-[10px] shrink-0 mt-px"
                      style={{
                        color: e.direction > 0 ? 'var(--color-up)' : 'var(--color-down)',
                        width: 40,
                      }}
                    >
                      {e.direction > 0 ? '▲' : '▼'} {Math.round(e.nis)}
                    </span>
                    <span className="text-[11px] leading-snug flex-1" style={{ color: 'var(--muted)' }}>
                      {e.headline}
                    </span>
                    <span className="mono text-[10px] shrink-0" style={{ color: 'var(--faint)' }}>
                      {Math.round(Math.abs(e.share) * 100)}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      <p className="px-3 py-2 text-[10px]" style={{ color: 'var(--faint)' }}>
        Coverage is the share of the abnormal move the headlines can account for. A low number is not
        a failure — it means the move was flow or liquidations rather than news. Window: {data.horizon}m.
      </p>
    </div>
  );
}
