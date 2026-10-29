import { useMemo } from 'react';
import type { ScanResult } from '../../shared/types';
import { buildDistribution, edgeTickLabel, type DepthDistribution } from './depthBuckets';
import { MONO_FONT } from './depthBuckets';

export interface DepthCurveProps {
  data: ScanResult;
  /** Buckets present in the universe; the engine's fixed ladder is ignored. */
  onBucketHover?: (bucket: { side: 'bullish' | 'bearish'; from: number; to: number; count: number }) => void;
}

/**
 * Market depth: a mirrored distribution of 24h moves.
 *
 * Mirrored because the question this chart answers is "is anything moving, and
 * in one direction or both". A board full of green rows with an empty right
 * half is a different market from a symmetric one, and only the distribution
 * shows that at a glance.
 *
 * The area under each curve is drawn as STEPPED COLUMNS of small cells rather
 * than a smooth fill: a histogram of counts is discrete, and drawing it as a
 * continuous area implies a resolution the data does not have.
 *
 * Bucket edges are ADAPTIVE (see depthBuckets.ts) because crypto moves are
 * routinely 5-40% — the fixed ±1/2/3/5% equity ladder put almost every coin in
 * the outermost bucket and left the inner four empty.
 *
 * Counts shown are the UNIVERSE partition (up / down / choppy), not the board
 * size. The board is capped at 20 per side, so using board counts here made the
 * chart report the cap and call it the market.
 */
export function DepthCurve({ data }: DepthCurveProps) {
  const dist: DepthDistribution = useMemo(() => {
    // The WHOLE scanned universe, not the board rows. This is what makes the
    // depth curve, the breadth chips and the "of N" caption share one
    // denominator instead of 40 vs 42.
    const rows = data.universeRows?.length
      ? data.universeRows
      : [...data.bullish, ...data.bearish].map((r) => ({
          ticker: r.displayTicker || r.base,
          changePct: r.changePct,
          strength: r.strength,
        }));
    return buildDistribution(rows);
  }, [data]);

  const W = 1000;
  const H = 190;
  const baseline = H - 26;
  const halfW = W / 2;
  const n = Math.max(dist.bullish.length, dist.bearish.length);
  const peak = Math.max(1, ...[...dist.bullish, ...dist.bearish].map((b) => b.count));
  const colW = (halfW - 24) / n;
  const cellW = Math.max(2, colW * 0.42);

  const colX = (i: number) => halfW - 20 - (i + 1) * colW;
  const bearX = (i: number) => halfW + 20 + i * colW;

  const height = (count: number) => (count / peak) * (baseline - 34);

  // Smooth trace over the tops of the stepped columns.
  const path = (side: 'bullish' | 'bearish'): string => {
    const list = side === 'bullish' ? dist.bullish : dist.bearish;
    const xs = list.map((_, i) => (side === 'bullish' ? colX(i) + colW / 2 : bearX(i) + colW / 2));
    const ys = list.map((b) => baseline - height(b.count));
    let d = `M${side === 'bullish' ? halfW : halfW} ${baseline}`;
    for (let i = 0; i < xs.length; i++) {
      const px = xs[i];
      const py = ys[i];
      if (i === 0) d += ` L${px} ${py}`;
      else {
        const prevX = xs[i - 1];
        const prevY = ys[i - 1];
        const mx = (prevX + px) / 2;
        d += ` C${mx} ${prevY} ${mx} ${py} ${px} ${py}`;
      }
    }
    d += ` L${side === 'bullish' ? halfW : halfW} ${baseline} Z`;
    return d;
  };

  const cellGrid = (side: 'bullish' | 'bearish') => {
    const list = side === 'bullish' ? dist.bullish : dist.bearish;
    const out:React.ReactNode[] = [];
    list.forEach((b, i) => {
      const h = height(b.count);
      const cx = side === 'bullish' ? colX(i) : bearX(i);
      const x0 = cx + (colW - cellW) / 2;
      // 5 rows of cells, so the column has texture rather than being a slab.
      const rowsN = 5;
      for (let k = 0; k < rowsN; k++) {
        const y = baseline - (h * (k + 1)) / rowsN;
        if (h <= 0) continue;
        out.push(
          <rect
            key={`${side}${i}-${k}`}
            className="dp-cell"
            x={x0}
            y={baseline - (h * (k + 1)) / rowsN}
            width={cellW}
            height={Math.max(1, h / rowsN - 1.5)}
            rx={1}
            fill={side === 'bullish' ? 'var(--color-up)' : 'var(--color-down)'}
            opacity={0.12 + 0.5 * (1 - k / rowsN)}
          >
            <title>{`${edgeTickLabel(b.from, side)} to ${edgeTickLabel(b.to, side)}: ${b.count} coins`}</title>
          </rect>,
        );
        void y;
      }
    });
    return out;
  };

  const total = Math.max(1, dist.up + dist.down + dist.choppy + dist.flat);
  const upPct = (dist.up / total) * 100;
  const downPct = (dist.down / total) * 100;
  const chopPct = (dist.choppy / total) * 100;

  return (
    <div className="of-depth" data-testid="depth-curve" data-total={dist.total}>
      <div className="of-depth-frame" style={{ height: H }}>
        <span className="of-corner tl" /><span className="of-corner tr" />
        <span className="of-corner bl" /><span className="of-corner br" />

        <div className="of-depth-labels">
          <span className="of-depth-label bull" data-testid="depth-label-bull">
            <b>BULLISH</b>
            <em data-testid="count-bullish">{dist.up}</em>
            <u>{upPct.toFixed(1)}% of {dist.total}</u>
          </span>
          <span className="of-depth-label bear" data-testid="depth-label-bear">
            <b>BEARISH</b>
            <em data-testid="count-bearish">{dist.down}</em>
            <u>{downPct.toFixed(1)}% of {dist.total}</u>
          </span>
          <span className="of-depth-label chop" data-testid="depth-label-choppy">
            <b>CHOPPY</b>
            <em data-testid="count-choppy">{dist.choppy}</em>
            <u>{chopPct.toFixed(1)}% of {dist.total}</u>
          </span>
        </div>

        <svg className="of-depth-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
          aria-label={`Market depth: ${dist.up} of ${dist.total} coins up, ${dist.down} down, ${dist.choppy} choppy`}>
          <g className="dp-grid">
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} x1={16} x2={W - 16} y1={baseline - f * (baseline - 34)} y2={baseline - f * (baseline - 34)} />
            ))}
          </g>

          <g className="dp-cells">{cellGrid('bullish')}{cellGrid('bearish')}</g>

          <path className="dp-fill bull" d={path('bullish')} />
          <path className="dp-fill bear" d={path('bearish')} />
          <path className="dp-line bull" d={path('bullish')} />
          <path className="dp-line bear" d={path('bearish')} />

          <line className="dp-seam" x1={halfW} x2={halfW} y1={baseline - (baseline - 34) - 6} y2={baseline} />
          <polygon className="dp-zero" points={`${halfW},${baseline - 7} ${halfW + 5},${baseline - 1} ${halfW},${baseline + 5} ${halfW - 5},${baseline - 1}`} />
        </svg>

        {/* Bucket dots: 5 per side + the zero diamond = 11 markers. */}
        <div className="of-depth-dots" aria-hidden="true">
          {dist.bullish.map((b, i) => (
            <span key={`bd${i}`} className="of-dot bull" data-testid="depth-dot"
              style={{ left: `${((colX(i) + colW / 2) / W) * 100}%`, bottom: `${(height(b.count) / (baseline - 34)) * 100 * (H - 26) / H * 100}%` }}>
              <i /><em data-count={b.count}>{b.count}</em>
              <u style={{ fontFamily: MONO_FONT }}>{edgeTickLabel(b.to, 'bullish')}</u>
            </span>
          ))}
          {dist.bearish.map((b, i) => (
            <span key={`rd${i}`} className="of-dot bear" data-testid="depth-dot"
              style={{ left: `${((bearX(i) + colW / 2) / W) * 100}%`, bottom: `${(height(b.count) / (baseline - 34)) * 100 * (H - 26) / H * 100}%` }}>
              <i /><em data-count={b.count}>{b.count}</em>
              <u style={{ fontFamily: MONO_FONT }}>{edgeTickLabel(b.to, 'bearish')}</u>
            </span>
          ))}
        </div>
      </div>

      <div className="of-depth-axis" data-testid="depth-axis" aria-hidden="true">
        {[...dist.bullish].reverse().map((b) => (
          <span key={`ax${b.from}`} className="bull">{edgeTickLabel(b.from, 'bullish')}</span>
        ))}
        <span className="zero">0</span>
        {dist.bearish.map((b) => (
          <span key={`ax${b.to}`} className="bear">{edgeTickLabel(b.to, 'bearish')}</span>
        ))}
      </div>
    </div>
  );
}