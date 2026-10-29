import { useMemo } from 'react';
import type { AssetRow } from '../../shared/types';
import { livePrice } from '../lib/priceStore';
import { STAGE_W } from './geometry';

/** Neat k/min/max for a set of prices so levels and the spark share one scale. */
function domain(values: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return { min: 0, max: 1 };
  const pad = (max - min) * 0.08 || Math.abs(max) * 0.02 || 1;
  return { min: min - pad, max: max + pad };
}

/**
 * Order-block sparkline: the row's spark (current session path) plus the setup
 * ladder (Z, invalidation, targets) drawn as labelled horizontal rules.
 * Uses the same y-domain as the spark so the levels sit where they really are.
 */
export function ObSpark({
  row,
  width = 120,
  height = 56,
  showLadder = true,
  phase = 'nothing',
}: {
  row: AssetRow;
  width?: number;
  height?: number;
  showLadder?: boolean;
  phase?: 'nothing' | 'breach' | 'tap';
}) {
  const { path, levels } = useMemo(() => {
    if (row.spark.length < 2) return { path: '', levels: [] as { y: number; label: string; color: string; dash: boolean }[] };
    const s = row.setup;
    const d = domain([...row.spark, ...(s ? [s.z, s.invalidation, ...s.targets.map((t) => t.price)] : [])]);
    const span = d.max - d.min || 1;
    const step = width / (row.spark.length - 1);
    let p = '';
    row.spark.forEach((v, i) => {
      const x = i * step;
      const y = height - ((v - d.min) / span) * (height - 4) - 2;
      p += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const bull = row.side === 'bullish';
    const mk = (price: number, label: string, color: string, dash: boolean) => ({
      y: height - ((price - d.min) / span) * (height - 4) - 2,
      label,
      color,
      dash,
    });
    const lv: { y: number; label: string; color: string; dash: boolean }[] = [];
    if (s) {
      lv.push(mk(s.z, 'Z', bull ? '#3FD487' : '#F87171', false));
      lv.push(mk(s.invalidation, bull ? 'S1' : 'R1', '#FBBF24', true));
      s.targets.slice(0, 2).forEach((t, i) => lv.push(mk(t.price, bull ? `R${i + 1}` : `S${i + 1}`, '#8AB4E8', true)));
    }
    return { path: p, levels: lv };
  }, [row, width, height]);

  const rising = row.spark[0] <= row.spark[row.spark.length - 1];
  const sideColor = row.side === 'bullish' ? '#3FD487' : '#F87171';

  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      {path && <path d={path} fill="none" stroke={sideColor} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />}
      {path && (
        <path
          d={`${path}L${width},${height}L0,${height}Z`}
          fill={sideColor}
          opacity={phase === 'nothing' ? 0.08 : phase === 'tap' ? 0.16 : 0.22}
        />
      )}
      {showLadder &&
        levels.map((l, i) =>
          l.label === 'Z' ? (
            <g key={i}>
              <line x1={0} y1={l.y} x2={width} y2={l.y} stroke={l.color} strokeWidth={1.1} opacity={0.9} />
              <text x={3} y={l.y - 2} fontSize={10} fill={l.color} fontFamily="JetBrains Mono, monospace" fontWeight={700}>
                {l.label}
              </text>
            </g>
          ) : (
            <g key={i}>
              <line x1={0} y1={l.y} x2={width} y2={l.y} stroke={l.color} strokeWidth={0.9} strokeDasharray="2 3" opacity={0.75} />
              <text x={width - 3} y={l.y - 2} fontSize={10} fill={l.color} textAnchor="end" fontFamily="JetBrains Mono, monospace" fontWeight={600}>
                {l.label}
              </text>
            </g>
          ),
        )}
      {rising ? (
        <circle cx={width - 2} cy={height - ((row.spark[row.spark.length - 1] - domain(row.spark).min) / (domain(row.spark).max - domain(row.spark).min || 1)) * (height - 4) - 2} r={1.6} fill="#3FD487" />
      ) : (
        <circle cx={width - 2} cy={height - ((row.spark[row.spark.length - 1] - domain(row.spark).min) / (domain(row.spark).max - domain(row.spark).min || 1)) * (height - 4) - 2} r={1.6} fill="#F87171" />
      )}
    </svg>
  );
}

/** Circular conviction ring (score 0-100). */
export function ScoreRing({ score, size = 46, stroke = 4 }: { score: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, score / 100));
  const color = pct >= 0.8 ? '#3FD487' : pct >= 0.6 ? '#FBBF24' : '#F87171';
  return (
    <svg width={size} height={size} style={{ display: 'block' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#11151B" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="central" fontSize={size * 0.3} fontWeight={700} fill="#E6EBF4" fontFamily="JetBrains Mono, monospace">
        {Math.round(score)}
      </text>
    </svg>
  );
}

/** Grade pips: 5 dots, filled = conviction quality. */
export function GradePips({ n, total = 5, size = 4, color }: { n: number; total?: number; size?: number; color: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          style={{
            width: size,
            height: size,
            borderRadius: '50%',
            background: i < n ? color : 'rgba(255,255,255,0.10)',
          }}
        />
      ))}
    </span>
  );
}

/** R:R bar: entry zone -> stop is risk (red), stop -> target is reward (green). */
export function RrBar({
  rr,
  risk,
  reward,
  width = 160,
  height = 12,
}: {
  rr: number;
  risk: number;
  reward: number;
  width?: number;
  height?: number;
}) {
  const total = Math.max(1e-9, risk + reward);
  const riskW = (risk / total) * width;
  const rewardW = (reward / total) * width;
  const noRisk = risk <= 0;
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {!noRisk && (
        <>
          <rect x={0} y={2} width={riskW} height={height - 4} rx={2} fill="#24181C" />
          <rect x={0} y={2} width={riskW} height={height - 4} rx={2} fill="#F87171" opacity={0.5} />
        </>
      )}
      {noRisk ? (
        <rect x={0} y={2} width={width} height={height - 4} rx={2} fill="#11151B" />
      ) : (
        <rect x={riskW} y={2} width={rewardW} height={height - 4} rx={2} fill="#3FD487" opacity={0.55} />
      )}
      {/* std/R:R markers */}
      <line x1={riskW} y1={0} x2={riskW} y2={height} stroke="#E6EBF4" strokeWidth={1.2} opacity={0.9} />
      {rr > 0 && <line x1={width} y1={0} x2={width} y2={height} stroke="#8AB4E8" strokeWidth={1.2} opacity={0.9} />}
      <text x={width / 2} y={height - 2} textAnchor="middle" fontSize={9.5} fill="#9AA5B5" fontFamily="JetBrains Mono, monospace">
        {noRisk ? 'no room — rr 0' : `rr ${rr.toFixed(1)}`}
      </text>
    </svg>
  );
}

/**
 * Live price for the stage header, read from the external price store.
 *
 * The second parameter is retained for call-site compatibility but ignored:
 * prices no longer flow through props (they are read per symbol straight from
 * `priceStore`, and the stage re-renders on a price revision).
 */
export function liveFor(row: AssetRow, _prices?: unknown) {
  return livePrice(`${row.base}USDT`) ?? livePrice(row.base) ?? null;
}

/** Scale the 1920-wide stage to the container width (like the reference's transform). */
export function fitScale(containerWidth: number): number {
  if (!containerWidth || containerWidth <= 0) return 1;
  return Math.min(1, containerWidth / STAGE_W);
}