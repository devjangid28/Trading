import type { AssetRow, ChecklistTick, Conviction, DerivRow, Grade } from '../../shared/types';

const GRADE_COLOR: Record<string, string> = {
  A: '#16a34a',
  B: '#0ea5e9',
  C: '#d97706',
  Pass: '#6b7280',
  'NO TRADE': '#dc2626',
};

const QUADRANT_SHORT: Record<string, string> = {
  'new-longs': 'New longs',
  'short-cover': 'Short cover',
  'new-shorts': 'New shorts',
  'long-liquidation': 'Long liq',
  flat: 'Flat',
};

const QUADRANT_COLOR: Record<string, string> = {
  'new-longs': 'var(--color-up)',
  'short-cover': '#d97706',
  'new-shorts': 'var(--color-down)',
  'long-liquidation': '#7c3aed',
  flat: 'var(--faint)',
};

export function GradeChip({ grade, size = 'sm' }: { grade: Grade; size?: 'sm' | 'md' }) {
  const color = GRADE_COLOR[grade] ?? 'var(--muted)';
  const pad = size === 'md' ? 'px-2 py-0.5 text-[11px]' : 'px-1.5 py-px text-[10px]';
  return (
    <span className={`chip ${pad} font-bold`} style={{ background: `${color}22`, color }}>
      {grade}
    </span>
  );
}

export function ScoreBar({ score, grade }: { score: number; grade: Grade }) {
  const color = GRADE_COLOR[grade] ?? 'var(--muted)';
  return (
    <span className="inline-flex items-center gap-1" title={`Conviction score ${score}/100 — hand-tuned, not fitted`}>
      <span className="mono text-[10px]" style={{ width: 22, textAlign: 'right' }}>{score.toFixed(0)}</span>
      <span className="inline-block w-7 h-1 rounded-full overflow-hidden" style={{ background: 'var(--panel-2)' }}>
        <span style={{ display: 'block', width: `${Math.min(100, score)}%`, height: '100%', background: color }} />
      </span>
    </span>
  );
}

export function FlowArrow({ deriv }: { deriv: DerivRow | null }) {
  if (!deriv) return <span style={{ color: 'var(--faint)' }}>—</span>;
  const up = deriv.cvd > 0;
  const flat = Math.abs(deriv.cvd) < 1;
  return (
    <span
      title={`CVD ${deriv.cvd > 0 ? '+' : ''}${(deriv.cvd / 1000).toFixed(1)}k USD · slope ${deriv.cvdSlope} · taker ratio ${(deriv.takerRatio ?? 0.5).toFixed(2)}${deriv.cvdDivergence ? ' · price high WITHOUT CVD confirmation' : ''}`}
      style={{ color: flat ? 'var(--faint)' : up ? 'var(--color-up)' : 'var(--color-down)', fontWeight: 700 }}
    >
      {flat ? '·' : up ? '▲' : '▼'}
    </span>
  );
}

export function PositionChip({ deriv }: { deriv: DerivRow | null }) {
  if (!deriv) {
    return <span className="chip" style={{ background: 'var(--panel-2)', color: 'var(--faint)' }} title="No derivatives data">—</span>;
  }
  const crowded = deriv.fundingLabel !== 'NEUTRAL' && deriv.fundingLabel !== 'SQUEEZE_FUEL';
  return (
    <span
      className="chip"
      style={{
        background: 'var(--panel-2)',
        color: QUADRANT_COLOR[deriv.quadrant],
      }}
      title={`${QUADRANT_SHORT[deriv.quadrant]} · funding ${(deriv.funding8h * 100).toFixed(4)}% (${deriv.fundingLabel.toLowerCase().replace(/_/g, ' ')}) · OI 1h ${deriv.oiChange.h1.toFixed(2)}%${crowded ? ' · funding is crowded' : ''}`}
    >
      {QUADRANT_SHORT[deriv.quadrant]}
    </span>
  );
}

export function NewsDot({ row }: { row: AssetRow }) {
  const dot = row.newsDot;
  if (!dot) return <span style={{ color: 'var(--faint)' }}>·</span>;
  const color =
    dot.direction > 0 ? 'var(--color-up)' : dot.direction < 0 ? 'var(--color-down)' : 'var(--faint)';
  const size = Math.max(6, Math.min(13, 5 + Math.sqrt(dot.nis) * 0.8));
  return (
    <span
      className="inline-block rounded-full"
      style={{
        width: size, height: size, background: color,
        boxShadow: dot.nis >= 55 ? `0 0 0 2px ${color}33` : undefined,
      }}
      title={`${dot.count} headline${dot.count === 1 ? '' : 's'} in 6h · max impact ${dot.nis.toFixed(0)} · net ${dot.direction > 0 ? 'bullish' : dot.direction < 0 ? 'bearish' : 'neutral'}`}
    />
  );
}

export function UnlockChip({ row }: { row: AssetRow }) {
  if (!row.unlock) return null;
  return (
    <span
      className="chip"
      style={{ background: 'rgba(217,119,6,0.16)', color: '#d97706' }}
      title={`${row.unlock.pct}% of supply unlocks ${row.unlock.date}${row.unlock.cliff ? ' (cliff)' : ''} — long setups are vetoed for this`}
    >
      U
    </span>
  );
}

export function ChecklistPanel({
  conviction,
  plan,
}: {
  conviction: Conviction | null;
  plan: { rr: number; noRoom: boolean; stop: number; entryLow: number; entryHigh: number; targets: { label: string; price: number; rr: number }[] } | null;
}) {
  if (!conviction) {
    return <p className="text-[11px]" style={{ color: 'var(--muted)' }}>No conviction record for this coin.</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <GradeChip grade={conviction.grade} size="md" />
          <span className="mono text-[13px] font-semibold">{conviction.score.toFixed(1)}</span>
          <span className="text-[10px]" style={{ color: 'var(--faint)' }}>/100</span>
        </div>
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
          checklist {conviction.checklistScore}/8
        </span>
      </div>

      {conviction.vetoes.length > 0 && (
        <div
          className="px-2 py-1.5 rounded-md mb-2 text-[11px]"
          style={{ background: 'rgba(220,38,38,0.10)', border: '1px solid rgba(220,38,38,0.3)' }}
        >
          <strong style={{ color: '#dc2626' }}>VETO — do not trade</strong>
          <ul className="mt-1 space-y-0.5" style={{ color: 'var(--muted)' }}>
            {conviction.vetoes.map((v) => <li key={v}>· {v}</li>)}
          </ul>
        </div>
      )}

      {conviction.missing.length > 0 && (
        <div
          className="px-2 py-1.5 rounded-md mb-2 text-[11px]"
          style={{ background: 'rgba(217,119,6,0.10)', border: '1px solid rgba(217,119,6,0.35)' }}
        >
          <strong style={{ color: '#d97706' }}>
            {conviction.missing.length} component{conviction.missing.length === 1 ? '' : 's'} missing
          </strong>
          <div style={{ color: 'var(--muted)' }} className="mt-0.5">
            {conviction.missing.join(', ')} — no input available, so not scored. Capped at grade C.
          </div>
        </div>
      )}

      <ul className="space-y-1">
        {conviction.checklist.map((t: ChecklistTick) => (
          <li key={t.key} className="flex items-start gap-2">
            <span style={{ color: t.ok ? 'var(--color-up)' : 'var(--faint)', fontWeight: 700, width: 12 }}>
              {t.ok ? '✓' : '✕'}
            </span>
            <span className="text-[11px] leading-snug">
              <span style={{ color: t.ok ? 'var(--text)' : 'var(--faint)' }}>{t.label}</span>
              <span style={{ color: 'var(--faint)' }}> — {t.reason}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="grid grid-cols-2 gap-2 mt-3">
        {Object.entries(conviction.components).map(([k, v]) => (
          <div key={k} className="flex items-center gap-1.5" title={v === null ? 'Missing input — not scored' : undefined}>
            <span
              className="text-[10px] w-16 truncate"
              style={{ color: v === null ? '#d97706' : 'var(--faint)' }}
            >
              {k}{v === null ? ' *' : ''}
            </span>
            <span className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'var(--panel-2)' }}>
              <span
                style={{
                  display: 'block',
                  width: v === null ? '100%' : `${Math.min(100, (v / maxWeight(k)) * 100)}%`,
                  height: '100%',
                  background: v === null
                    ? 'repeating-linear-gradient(45deg, #d9770655, #d9770655 3px, transparent 3px, transparent 6px)'
                    : GRADE_COLOR[conviction.grade] ?? 'var(--accent)',
                }}
              />
            </span>
            <span className="mono text-[10px] w-6 text-right" style={{ color: v === null ? '#d97706' : undefined }}>
              {v === null ? '—' : v.toFixed(1)}
            </span>
          </div>
        ))}
      </div>

      {plan && (
        <div className="mt-3 pt-2 border-t text-[11px]" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
          {plan.noRoom ? (
            <span>No liquidity target in range, so there is no measurable R:R. Not a pick.</span>
          ) : (
            <span>
              Entry {plan.entryLow.toPrecision(5)}–{plan.entryHigh.toPrecision(5)} · stop{' '}
              {plan.stop.toPrecision(6)} · R:R <strong style={{ color: 'var(--text)' }}>1:{plan.rr.toFixed(1)}</strong>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Max possible per component, so the bars are on a comparable scale. */
const WEIGHTS: Record<string, number> = {
  structure: 25, orderFlow: 20, momentum: 15, positioning: 15,
  newsEvents: 10, macroRegime: 10, tradability: 5,
};
function maxWeight(k: string): number {
  return WEIGHTS[k] ?? 25;
}
