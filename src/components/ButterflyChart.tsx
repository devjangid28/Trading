import { useMemo } from 'react';
import type { Butterfly } from '../../shared/types';

/**
 * Butterfly distribution of % moves across the whole universe.
 *
 * Gains extend left of the spine and losses extend right, sharing one axis, so
 * the shape reads at a glance: a market that only goes up leaves the right half
 * empty, and a genuinely two-way market looks symmetric. That is information
 * the ranked board cannot give you, because the board only ever shows the
 * extremes.
 *
 * Bar length is scaled to the busiest bucket, not to the bucket's own count,
 * so a column with three coins in it does not draw as three-quarters of the
 * chart.
 *
 * Colour is reserved for direction. Everything else is greyscale, matching the
 * muted-palette rule: if everything is coloured, direction stops being the
 * thing your eye goes to.
 */

const H = 96;

export function ButterflyChart({
  data,
  picks = new Set<string>(),
  picksLabel = 'picks',
}: {
  data: Butterfly | null | undefined;
  /** Symbols to ring, so the picks stand out against the distribution. */
  picks?: Set<string>;
  picksLabel?: string;
}) {
  const peak = useMemo(
    () => Math.max(1, ...(data?.buckets.map((b) => b.max) ?? [1])),
    [data],
  );

  if (!data || data.n === 0) {
    return (
      <div
        className="flex items-center justify-center text-[11px] px-3"
        style={{ height: H, color: 'var(--muted)' }}
      >
        No universe data yet.
      </div>
    );
  }

  const hasPicks = picks.size > 0;

  return (
    <figure className="m-0 select-none">
      <figcaption className="sr-only">
        Distribution of daily moves across {data.n} assets. {data.bullish} up,{' '}
        {data.bearish} down, {data.flat} flat.
      </figcaption>

      <svg
        viewBox={`0 0 ${data.buckets.length * 2 + 1} ${H}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: H, overflow: 'visible' }}
        role="img"
        aria-label={`Market depth: ${data.bullish} assets up and ${data.bearish} down. Strongest gain ${data.top.toFixed(1)}%, strongest loss ${data.bottom.toFixed(1)}%.`}
      >
        {data.buckets.map((b, i) => {
          const cx = i * 2 + 1; // spine sits between the two halves
          const bl = (b.bullish / peak) * 40;
          const br = (b.bearish / peak) * 40;
          const flatH = b.flat > 0 ? 1.5 : 0;
          const tip =
            b.total === 0
              ? ''
              : b.bullish > b.bearish
                ? `${b.bullish} up`
                : b.bearish > b.bullish
                  ? `${b.bearish} down`
                  : `${b.flat} flat`;
          return (
            <g key={i}>
              {/* gains, left of the spine */}
              {bl > 0 && (
                <rect
                  x={cx - bl}
                  y={barTop(H, b.bullish, peak)}
                  width={bl}
                  height={barHeight(H, b.bullish, peak)}
                  fill="var(--color-up)"
                  opacity={0.34 + 0.5 * (b.bullish / peak)}
                />
              )}
              {/* losses, right of the spine */}
              {br > 0 && (
                <rect
                  x={cx}
                  y={barTop(H, b.bearish, peak)}
                  width={br}
                  height={barHeight(H, b.bearish, peak)}
                  fill="var(--color-down)"
                  opacity={0.34 + 0.5 * (b.bearish / peak)}
                />
              )}
              {/* flat marker sits on the spine itself */}
              {flatH > 0 && (
                <rect x={cx - 0.5} y={H - 3} width={1} height={3} fill="var(--faint)" />
              )}
              {tip !== '' && (
                <text
                  x={cx}
                  y={H - 8}
                  textAnchor="middle"
                  style={{ font: '600 6px var(--font-mono)', fill: 'var(--faint)' }}
                >
                  {tip}
                </text>
              )}
            </g>
          );
        })}

        {/* the spine */}
        <line
          x1={1}
          y1={4}
          x2={1}
          y2={H}
          stroke="var(--border)"
          strokeWidth={0.4}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="flex items-center justify-between mt-1 text-[10px]" style={{ color: 'var(--faint)' }}>
        <span className="tabular-nums">
          <b style={{ color: 'var(--color-up)' }}>{data.bullish}</b> up ·{' '}
          <b style={{ color: 'var(--color-down)' }}>{data.bearish}</b> down
          {data.flat > 0 ? ` · ${data.flat} flat` : ''}
        </span>
        <span className="tabular-nums">
          {data.skew === null
            ? 'no direction'
            : data.skew > 0.15
              ? 'leans up'
              : data.skew < -0.15
                ? 'leans down'
                : 'two-way'}
          {hasPicks && <span className="ml-2">· {picks.size} {picksLabel}</span>}
        </span>
      </div>
    </figure>
  );
}

/** Bar height as a share of the chart, with a floor so a single asset shows. */
function barHeight(h: number, n: number, peak: number): number {
  return Math.max(1.5, (n / peak) * (h - 14));
}

/** Bars grow from the baseline upward. */
function barTop(h: number, n: number, peak: number): number {
  return h - barHeight(h, n, peak);
}