import { useEffect, useMemo, useRef, useState } from 'react';
import type { MarketPicture } from '../../shared/types';
import { niceTicks } from '../lib/format';

interface Props {
  market: MarketPicture;
  height?: number;
}

const BULLISH_COLOR = '#16a34a';
const BEARISH_COLOR = '#dc2626';
const AXIS_H = 13;

export function MarketDepthPanel({ market, height = 120 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(700);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => {
      const width = e[0]?.contentRect.width;
      if (width && width > 0) setW(width);
    });
    ro.observe(el);
    setW(el.clientWidth || 700);
    return () => ro.disconnect();
  }, []);

  const buckets = useMemo(() => {
    const minPct = -Math.max(1, ...market.dots.map((d) => Math.abs(d.changePct)));
    const maxPct = Math.max(1, ...market.dots.map((d) => Math.abs(d.changePct)));
    const span = maxPct - minPct;
    const bucketCount = 24;
    const bucketSize = span / bucketCount;

    const buckets: { from: number; to: number; bullish: number; bearish: number }[] = [];
    for (let i = 0; i < bucketCount; i++) {
      const from = minPct + i * bucketSize;
      const to = from + bucketSize;
      const bullish = market.dots.filter((d) => !d.choppy && d.changePct >= 0 && d.changePct >= from && d.changePct < to).length;
      const bearish = market.dots.filter((d) => !d.choppy && d.changePct < 0 && d.changePct >= from && d.changePct < to).length;
      buckets.push({ from, to, bullish, bearish });
    }
    return { buckets, minPct, maxPct };
  }, [market.dots]);

  const maxCount = useMemo(() => Math.max(1, ...buckets.buckets.flatMap((b) => [b.bullish, b.bearish])), [buckets]);
  const { minPct, maxPct } = buckets;
  const span = maxPct - minPct;
  const plotTop = 4;
  const plotBottom = height - AXIS_H - 2;
  const plotH = plotBottom - plotTop;
  const midY = plotTop + plotH / 2;
  const barW = Math.max(4, (w - 16) / buckets.buckets.length - 1);

  const xFor = (pct: number) => 8 + ((pct - minPct) / span) * (w - 16);
  const axisTicks = niceTicks(0.5, maxPct, 5).filter((v) => v > 0 && v < maxPct);
  const total = market.bullishCount + market.bearishCount + market.choppyCount;
  const bullShare = total ? Math.round((market.bullishCount / total) * 100) : 0;
  const bearShare = total ? Math.round((market.bearishCount / total) * 100) : 0;

  return (
    <div ref={ref} className="relative select-none" style={{ height }}>
      <svg width={w} height={height} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="bullGrad" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor={BULLISH_COLOR} stopOpacity="0.9" />
            <stop offset="100%" stopColor={BULLISH_COLOR} stopOpacity="0.3" />
          </linearGradient>
          <linearGradient id="bearGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={BEARISH_COLOR} stopOpacity="0.9" />
            <stop offset="100%" stopColor={BEARISH_COLOR} stopOpacity="0.3" />
          </linearGradient>
        </defs>

        {axisTicks.map((v) => (
          <g key={v}>
            {[-v, v].map((s) => (
              <g key={s}>
                <line
                  x1={xFor(s)}
                  x2={xFor(s)}
                  y1={plotTop}
                  y2={plotBottom}
                  stroke="var(--grid)"
                  strokeWidth={0.5}
                  strokeDasharray="2 3"
                />
                <text x={xFor(s)} y={plotBottom + AXIS_H - 2} fontSize={8.5} fill="var(--faint)" textAnchor="middle" className="mono">
                  {s >= 0 ? '+' : ''}{s.toFixed(0)}%
                </text>
              </g>
            ))}
          </g>
        ))}

        {buckets.buckets.map((b, i) => {
          const x = 8 + i * (barW + 1);
          const bullH = (b.bullish / maxCount) * (plotH / 2);
          const bearH = (b.bearish / maxCount) * (plotH / 2);

          return (
            <g key={i}>
              {b.bullish > 0 && (
                <rect x={x} y={midY - bullH} width={barW} height={bullH} fill="url(#bullGrad)" rx={barW > 6 ? 1 : 0} />
              )}
              {b.bearish > 0 && (
                <rect x={x} y={midY} width={barW} height={bearH} fill="url(#bearGrad)" rx={barW > 6 ? 1 : 0} />
              )}
            </g>
          );
        })}

        <line x1={8} x2={w - 8} y1={midY} y2={midY} stroke="var(--border)" strokeWidth={1} />
        <text x={8} y={midY - 3} fontSize={8} fill="var(--faint)" className="mono">0</text>

        <text x={8} y={plotTop + 8} fontSize={9} fill={BULLISH_COLOR} fontWeight={700} className="mono">
          BULL {market.bullishCount} · {bullShare}%
        </text>
        <text x={w - 8} y={plotTop + 8} fontSize={9} fill={BEARISH_COLOR} fontWeight={700} textAnchor="end" className="mono">
          BEAR {market.bearishCount} · {bearShare}%
        </text>
      </svg>
      <div className="depth-legend">
        {market.choppyCount} choppy excluded
      </div>
    </div>
  );
}