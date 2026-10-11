import { useEffect, useMemo, useRef, useState } from 'react';
import type { MarketPicture } from '../../shared/types';
import { fmtPct } from '../lib/format';

interface Props {
  market: MarketPicture;
  onPick?: (symbol: string) => void;
  height?: number;
}

/**
 * Every scanned asset as a dot at its move for the day, bullish above the line
 * and bearish below. The picks are ringed, event-risk names are amber, and
 * choppy assets are hollow because their strength scored zero.
 */
export function MarketPictureStrip({ market, onPick, height = 132 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(700);
  const [hover, setHover] = useState<string | null>(null);

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

  const PAD = 26;
  const plotW = Math.max(60, w - PAD * 2);
  const plotH = height - 34;
  const midY = 17 + plotH / 2;

  const maxAbs = useMemo(() => {
    const m = Math.max(1, ...market.dots.map((d) => Math.abs(d.changePct)));
    return m * 1.08;
  }, [market.dots]);

  const x = (pct: number) => PAD + ((pct + maxAbs) / (2 * maxAbs)) * plotW;
  const yFor = (s: number) => {
    const t = Math.min(1, s / 8);
    return midY - (t * (plotH / 2 - 8));
  };

  const hovered = hover ? market.dots.find((d) => d.symbol === hover) : null;

  return (
    <div ref={ref} className="relative select-none" style={{ height }}>
      <svg width={w} height={height} style={{ display: 'block' }}>
        {/* Zero line */}
        <line
          x1={PAD}
          x2={PAD + plotW}
          y1={midY}
          y2={midY}
          stroke="var(--border)"
          strokeWidth={1}
        />
        <text x={PAD - 4} y={midY + 3} fontSize={9} fill="var(--faint)" textAnchor="end" className="mono">
          0
        </text>
        <text x={PAD - 4} y={17 + 6} fontSize={9} fill="var(--color-up)" textAnchor="end" className="mono">
          ▲
        </text>
        <text x={PAD - 4} y={17 + plotH - 2} fontSize={9} fill="var(--color-down)" textAnchor="end" className="mono">
          ▼
        </text>
        <text x={PAD} y={12} fontSize={9.5} fill="var(--faint)" className="mono">
          {fmtPct(-maxAbs, 1)}
        </text>
        <text x={PAD + plotW} y={12} fontSize={9.5} fill="var(--faint)" textAnchor="end" className="mono">
          {fmtPct(maxAbs, 1)}
        </text>

        {market.dots.map((d) => {
          const cx = x(d.changePct);
          const cy = d.choppy ? midY : yFor(d.strength);
          const isHover = hover === d.symbol;
          const fill = d.eventRisk
            ? '#d97706'
            : d.choppy
              ? 'var(--faint)'
              : d.changePct >= 0
                ? 'var(--color-up)'
                : 'var(--color-down)';
          const r = d.pick ? 5 : isHover ? 4.5 : 3;
          return (
            <circle
              key={d.symbol}
              cx={cx}
              cy={cy}
              r={r}
              fill={d.choppy ? 'none' : fill}
              fillOpacity={d.pick ? 1 : 0.75}
              stroke={d.pick ? 'var(--text)' : d.choppy ? fill : 'none'}
              strokeWidth={d.pick ? 1.8 : 1}
              strokeOpacity={0.9}
              style={{ cursor: onPick ? 'pointer' : 'default' }}
              onMouseEnter={() => setHover(d.symbol)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onPick?.(d.symbol)}
            />
          );
        })}
      </svg>

      {hovered && (
        <div
          className="pointer-events-none absolute mono text-[10px] px-2 py-1 rounded-md"
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            left: Math.min(Math.max(0, x(hovered.changePct) - 50), w - 110),
            top: 2,
            minWidth: 100,
          }}
        >
          <div className="font-bold">{hovered.symbol}</div>
          <div className={hovered.changePct >= 0 ? 'up' : 'down'}>{fmtPct(hovered.changePct)}</div>
          <div style={{ color: 'var(--muted)' }}>
            str {hovered.choppy ? 'choppy' : hovered.strength.toFixed(2)}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 text-[10px] px-1" style={{ color: 'var(--muted)' }}>
        <span className="up font-semibold">▲ Bullish {market.bullishCount}</span>
        <span className="down font-semibold">▼ Bearish {market.bearishCount}</span>
        {market.choppyCount > 0 && <span>Choppy {market.choppyCount}</span>}
        <span style={{ color: 'var(--faint)' }}>of {market.total} tracked</span>
      </div>
    </div>
  );
}
