import type { SectorFlow } from '../../shared/types';
import { fmtPct } from '../lib/format';

interface Props {
  sectors: SectorFlow[];
  onSelect?: (symbol: string) => void;
}

const CHIP_GRADIENTS: Record<string, string> = {
  'DeFi': 'linear-gradient(180deg, #a855f7 0%, #6366f1 100%)',
  'L1': 'linear-gradient(180deg, #06b6d4 0%, #3b82f6 100%)',
  'L2': 'linear-gradient(180deg, #14b8a6 0%, #06b6d4 100%)',
  'AI': 'linear-gradient(180deg, #f59e0b 0%, #ef4444 100%)',
  'Meme': 'linear-gradient(180deg, #ec4899 0%, #f59e0b 100%)',
  'Gaming': 'linear-gradient(180deg, #8b5cf6 0%, #ec4899 100%)',
  'Infrastructure': 'linear-gradient(180deg, #6366f1 0%, #8b5cf6 100%)',
  'RWA': 'linear-gradient(180deg, #16a34a 0%, #14b8a6 100%)',
  'Oracle': 'linear-gradient(180deg, #f97316 0%, #f59e0b 100%)',
  'DEX': 'linear-gradient(180deg, #0ea5e9 0%, #06b6d4 100%)',
  'CEX': 'linear-gradient(180deg, #84cc16 0%, #16a34a 100%)',
  'Privacy': 'linear-gradient(180deg, #64748b 0%, #475569 100%)',
  'Bridge': 'linear-gradient(180deg, #d97706 0%, #f59e0b 100%)',
  'Derivatives': 'linear-gradient(180deg, #ef4444 0%, #dc2626 100%)',
  'Lending': 'linear-gradient(180deg, #3b82f6 0%, #6366f1 100%)',
  'Stablecoin': 'linear-gradient(180deg, #16a34a 0%, #22c55e 100%)',
  'NFT': 'linear-gradient(180deg, #ec4899 0%, #d946ef 100%)',
  'Social': 'linear-gradient(180deg, #06b6d4 0%, #22d3ee 100%)',
  'Web3': 'linear-gradient(180deg, #8b5cf6 0%, #a855f7 100%)',
  'Data': 'linear-gradient(180deg, #64748b 0%, #94a3b8 100%)',
  'Interop': 'linear-gradient(180deg, #d97706 0%, #f97316 100%)',
};

function getGradient(sector: string): string {
  for (const [key, grad] of Object.entries(CHIP_GRADIENTS)) {
    if (sector.toLowerCase().includes(key.toLowerCase())) return grad;
  }
  return 'linear-gradient(180deg, #6b7280 0%, #4b5563 100%)';
}

export function SectorChips({ sectors, onSelect }: Props) {
  if (!sectors.length) {
    return (
      <div className="sector-chips-container">
        <div className="p-4 text-[12px]" style={{ color: 'var(--muted)' }}>
          No sector data yet.
        </div>
      </div>
    );
  }

  const maxAbs = Math.max(0.5, ...sectors.map((s) => Math.abs(s.avgChange)));

  return (
    <div className="sector-chips-container">
      {sectors.map((s) => {
        const positive = s.avgChange >= 0;
        const barWidth = Math.min(100, (Math.abs(s.avgChange) / maxAbs) * 100);
        const gradient = getGradient(s.sector);
        const color = positive ? 'var(--color-up)' : 'var(--color-down)';

        return (
          <div
            key={s.sector}
            className="sector-chip-row"
          >
            <div className="sector-chip-strip" style={{ background: gradient }} />
            <div className="sector-chip-content">
              <div className="sector-chip-header">
                <span className="sector-chip-name">{s.sector}</span>
                <span className="sector-chip-change" style={{ color }}>
                  {fmtPct(s.avgChange)}
                </span>
              </div>
              <div className="sector-chip-bar">
                <div
                  className="sector-chip-fill"
                  style={{
                    width: `${barWidth}%`,
                    background: positive ? 'var(--color-up)' : 'var(--color-down)',
                    marginLeft: positive ? '0' : 'auto',
                  }}
                />
              </div>
              <div className="sector-chip-members">
                {s.members.slice(0, 8).map((m) => (
                  <button
                    key={m.symbol}
                    type="button"
                    onClick={() => onSelect?.(m.symbol)}
                    title={`${m.symbol} ${fmtPct(m.changePct)}`}
                    className="sector-chip-member"
                    style={{
                      background: `color-mix(in srgb, ${m.changePct >= 0 ? 'var(--color-up)' : 'var(--color-down)'} 14%, transparent)`,
                      color: m.changePct >= 0 ? 'var(--color-up)' : 'var(--color-down)',
                    }}
                  >
                    {m.symbol}
                  </button>
                ))}
              </div>
            </div>
            {s.leading && <span className="sector-chip-badge lead">Lead</span>}
            {s.lagging && <span className="sector-chip-badge lag">Lag</span>}
          </div>
        );
      })}
      <p className="sector-chips-note">
        No more than two picks come from one sector, so a single sector's news cannot fill the shortlist.
      </p>
    </div>
  );
}