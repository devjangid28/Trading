import { useMemo } from 'react';
import type { AssetRow, Side } from '../../shared/types';
import { chartLevels, profileBars } from './flowData';

const BULL = '#3fd487';
const BEAR = '#f87171';
const AMBER = '#fbbf24';

function domain(values: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return { min: 0, max: 1 };
  const pad = (max - min) * 0.1 || Math.abs(max) * 0.02 || 1;
  return { min: min - pad, max: max + pad };
}

/** Build the polyline + area path for a series across a plot rect. */
function linePath(values: number[], d: { min: number; max: number }, width: number, top: number, height: number) {
  const span = d.max - d.min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  let line = '';
  const ys: number[] = [];
  values.forEach((v, i) => {
    const x = i * step;
    const y = top + height - ((v - d.min) / span) * height;
    ys.push(y);
    line += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = line ? `${line}L${width},${top + height}L0,${top + height}Z` : '';
  return { line, area, ys };
}

/** Small profile histogram — green bars for bull, red for bear. */
export function ProfileHist({
  row,
  width = 90,
  height = 30,
  side,
}: {
  row: AssetRow;
  width?: number;
  height?: number;
  side: Side;
}) {
  const p = useMemo(() => profileBars(row, 14), [row]);
  const color = side === 'bullish' ? BULL : BEAR;
  const bw = width / p.bins.length;
  return (
    <svg width={width} height={height} className="ob-hist" style={{ display: 'block' }}>
      {p.bins.map((v, i) => {
        const h = Math.max(1, (v / p.max) * (height - 2));
        return <rect key={i} x={i * bw + 0.4} y={height - h} width={Math.max(0.8, bw - 1)} height={h} rx={0.6} fill={color} opacity={0.28 + 0.62 * (v / p.max)} />;
      })}
    </svg>
  );
}

/** Horizontal micro-bar: |% change| relative to the side's max. */
export function MicroBar({ frac, side, width = 92, height = 5 }: { frac: number; side: Side; width?: number; height?: number }) {
  const color = side === 'bullish' ? BULL : BEAR;
  const w = Math.max(2, Math.min(1, frac) * width);
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <rect x={0} y={0} width={width} height={height} rx={height / 2} fill="rgba(255,255,255,0.06)" />
      <rect x={0} y={0} width={w} height={height} rx={height / 2} fill={color} opacity={0.85} />
    </svg>
  );
}

/**
 * Depth strip — real futures book liquidity either side of the mark.
 * Bids left, asks right; bars scale to the largest level in the snapshot.
 */
export function DepthStrip({ row, width = 96, height = 12 }: { row: AssetRow; width?: number; height?: number }) {
  const depth = row.derivatives?.depth ?? null;
  const mid = width / 2;
  if (!depth || depth.walls.length === 0) {
    return (
      <svg width={width} height={height} style={{ display: 'block' }}>
        <rect x={0} y={height / 2 - 0.5} width={width} height={1} fill="rgba(255,255,255,0.08)" />
      </svg>
    );
  }
  const max = Math.max(1, ...depth.walls.map((w) => w.usd));
  const bw = width / Math.max(8, depth.walls.length);
  const sorted = [...depth.walls].sort((a, b) => a.price - b.price);
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <line x1={mid} y1={0} x2={mid} y2={height} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
      {sorted.map((w, i) => {
        const h = Math.max(1, (w.usd / max) * (height - 2));
        const bid = w.side === 'bid';
        const x = bid ? mid - (i + 1) * bw : mid + i * bw;
        if (x < 0 || x > width - bw) return null;
        return <rect key={i} x={x} y={height - h} width={Math.max(1, bw - 0.8)} height={h} rx={0.6} fill={bid ? BULL : BEAR} opacity={0.5} />;
      })}
    </svg>
  );
}

/** A ring gauge for the flow score. */
export function Ring({ score, size = 40, stroke = 3.5 }: { score: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, score / 100));
  const color = pct >= 0.66 ? BULL : pct >= 0.4 ? AMBER : BEAR;
  return (
    <svg width={size} height={size} style={{ display: 'block' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
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
        style={{ filter: `drop-shadow(0 0 4px ${color}88)` }}
      />
      <text x={size / 2} y={size / 2 + 0.5} textAnchor="middle" dominantBaseline="central" fontSize={size * 0.34} fontWeight={800} fill="#e6ebf4" fontFamily="'JetBrains Mono',monospace">
        {Math.round(score)}
      </text>
    </svg>
  );
}

/**
 * The big detail chart: price line + filled area, the R1/R2/S1/S2/Z ladder as
 * dotted levels, a glowing last-price dot, and a real OI-change overlay
 * (m5/h1/h4/d1) in the lower band. Nothing here is synthesised.
 */
export function DetailChart({
  row,
  price,
  width = 468,
  height = 132,
}: {
  row: AssetRow;
  price?: number;
  width?: number;
  height?: number;
}) {
  const bull = row.side === 'bullish';
  const color = bull ? BULL : BEAR;
  const oiH = 20;

  const model = useMemo(() => {
    const levels = chartLevels(row);
    const s = row.setup;
    const px = price ?? row.price;
    const all = [...row.spark, ...levels.map((l) => l.price)];
    if (s) all.push(px);
    const d = domain(all);
    const plotH = height - oiH - 8;
    const { line, area, ys } = linePath(row.spark, d, width, 2, plotH);
    const yOf = (v: number) => 2 + plotH - ((v - d.min) / (d.max - d.min || 1)) * plotH;
    const lastY = ys.length ? ys[ys.length - 1] : null;
    const lastX = row.spark.length > 1 ? width : 0;

    const oi = row.derivatives?.oiChange ?? null;
    const series = oi
      ? [
          { k: '5m', v: oi.m5 },
          { k: '1h', v: oi.h1 },
          { k: '4h', v: oi.h4 },
          { k: '1d', v: oi.d1 },
        ].filter((p) => typeof p.v === 'number') as { k: string; v: number }[]
      : [];
    const od = series.length ? domain(series.map((p) => p.v)) : { min: 0, max: 1 };
    return { levels, d, line, area, yOf, lastY, lastX, series, od, plotH, px };
  }, [row, price, width, height, oiH]);

  const oiTop = height - oiH;
  const oiColor = '#8ab4e8';

  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      {/* level rules */}
      {model.levels.map((l, i) => {
        const y = model.yOf(l.price);
        const zone = l.tone === 'zone';
        return (
          <g key={`${l.label}-${i}`}>
            <line x1={0} y1={y} x2={width} y2={y} stroke={zone ? color : AMBER} strokeWidth={zone ? 1.1 : 0.9} strokeDasharray={zone ? '3 2' : '2 4'} opacity={zone ? 0.5 : 0.7} />
            <text x={width - 2} y={y - 2} fontSize={10} textAnchor="end" fill={zone ? color : AMBER} fontFamily="'JetBrains Mono',monospace" fontWeight={700}>
              {l.label}
            </text>
          </g>
        );
      })}

      {/* price area + line */}
      {model.area && <path d={model.area} fill={color} opacity={0.09} />}
      {model.line && <path d={model.line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />}

      {/* last price */}
      {model.lastY !== null && (
        <g>
          <line x1={0} y1={model.lastY} x2={width} y2={model.lastY} stroke={color} strokeWidth={0.6} opacity={0.35} strokeDasharray="1 3" />
          <circle cx={model.lastX} cy={model.lastY} r={3.2} fill={color} style={{ filter: `drop-shadow(0 0 5px ${color})` }} />
          <circle cx={model.lastX} cy={model.lastY} r={1.3} fill="#05070b" />
        </g>
      )}

      {/* OI overlay band */}
      <line x1={0} y1={oiTop - 4} x2={width} y2={oiTop - 4} stroke="rgba(255,255,255,0.07)" strokeWidth={0.8} />
      <text x={0} y={oiTop + 1} fontSize={9.5} fill={oiColor} fontFamily="'JetBrains Mono',monospace" fontWeight={700}>
        OI Δ
      </text>
      {model.series.length >= 2 && (
        <>
          <path
            d={linePath(model.series.map((p) => p.v), model.od, width, oiTop + 4, oiH - 6).line}
            fill="none"
            stroke={oiColor}
            strokeWidth={1.1}
            opacity={0.85}
            strokeLinejoin="round"
          />
          {model.series.map((p, i) => {
            const step = width / (model.series.length - 1);
            const y = oiTop + 4 + (oiH - 6) - ((p.v - model.od.min) / (model.od.max - model.od.min || 1)) * (oiH - 6);
            return <circle key={p.k} cx={i * step} cy={y} r={1.6} fill={p.v >= 0 ? BULL : BEAR} />;
          })}
        </>
      )}
      {model.series.length < 2 && (
        <text x={width / 2} y={oiTop + oiH / 2 + 1} fontSize={10} textAnchor="middle" fill="rgba(154,165,181,0.6)" fontFamily="'JetBrains Mono',monospace">
          no OI history in snapshot
        </text>
      )}
    </svg>
  );
}
