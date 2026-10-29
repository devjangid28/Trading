import { useEffect, useMemo, useRef, useState } from 'react';
import type { AssetRow } from '../../shared/types';
import { fmtPct, fmtPrice, niceTicks } from '../lib/format';
import type { LivePrice } from '../lib/liveContext';

const UP = '#16a34a';
const DOWN = '#dc2626';

interface Props {
  row: AssetRow;
  rank: number;
  prices?: Record<string, LivePrice>;
  onClick?: () => void;
  isSelected?: boolean;
  bridge?: string;
}

export function PickCard({ row, rank, prices, onClick, isSelected, bridge }: Props) {
  const setup = row.setup;
  const bullish = row.side === 'bullish';
  const color = bullish ? UP : DOWN;
  const live = prices?.[`${row.base}USDT`];

  const chartRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(280);

  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => {
      const w = e[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.clientWidth || 280);
    return () => ro.disconnect();
  }, []);

  const view = useMemo(() => {
    if (!setup || !row.spark.length) return null;

    const visible = row.spark.slice(-60);
    const n = visible.length;

    let min = Infinity;
    let max = -Infinity;
    for (const v of visible) {
      if (v < min) min = v;
      if (v > max) max = v;
    }

    if (setup) {
      [setup.obLow, setup.obHigh, setup.z, setup.invalidation, ...setup.targets.map((t) => t.price)].forEach((v) => {
        if (v < min) min = v;
        if (v > max) max = v;
      });
    }

    const pad = (max - min) * 0.1 || max * 0.02;
    min -= pad;
    max += pad;

    const PAD_T = 4;
    const plotW = width;
    const plotH = 68;

    const x = (i: number) => (i / Math.max(1, n - 1)) * plotW;
    const y = (p: number) => PAD_T + (1 - (p - min) / (max - min)) * plotH;

    return { visible, n, min, max, plotW, plotH, x, y };
  }, [row.spark, setup, width]);

  if (!view) {
    return (
      <div
        ref={chartRef}
        className="pick-card"
        onClick={onClick}
        data-bridge-card={bridge}
        style={{
          background: isSelected ? 'var(--panel-2)' : 'var(--panel)',
          borderColor: isSelected ? color : 'var(--border)',
        }}
      >
        <div className="pick-header">
          <span className="pick-rank" style={{ color }}>{String(rank).padStart(2, '0')}</span>
          <div className="pick-info">
            <b className="pick-symbol">{row.base}</b>
            <span className="pick-sector">{row.sector}</span>
          </div>
          <div className="pick-price">
            <span className="mono pick-current">{fmtPrice(live?.price ?? row.price)}</span>
            <span className={`mono pick-change ${(live?.changePct ?? row.changePct) >= 0 ? 'up' : 'down'}`}>
              {fmtPct(live?.changePct ?? row.changePct)}
            </span>
          </div>
        </div>
        <div className="pick-empty">No chart data</div>
      </div>
    );
  }

  const { visible, n, plotW, plotH, x, y } = view;

  return (
    <div
      ref={chartRef}
      className="pick-card"
      onClick={onClick}
      data-bridge-card={bridge}
      style={{
        background: isSelected ? 'var(--panel-2)' : 'var(--panel)',
        borderColor: isSelected ? color : 'var(--border)',
      }}
    >
      <div className="pick-header">
        <span className="pick-rank" style={{ color }}>{String(rank).padStart(2, '0')}</span>
        <div className="pick-info">
          <b className="pick-symbol">{row.base}</b>
          <span className="pick-sector">{row.sector}</span>
        </div>
        <div className="pick-price">
          <span className="mono pick-current">{fmtPrice(live?.price ?? row.price)}</span>
          <span className={`mono pick-change ${(live?.changePct ?? row.changePct) >= 0 ? 'up' : 'down'}`}>
            {fmtPct(live?.changePct ?? row.changePct)}
          </span>
        </div>
      </div>

      <div className="pick-chart">
        <svg width={width} height={plotH + 8} style={{ display: 'block' }}>
          <defs>
            <linearGradient id="obFillPick" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0.03" />
            </linearGradient>
          </defs>

          {niceTicks(view.min, view.max, 3).map((p, i) => (
            <line
              key={i}
              x1={0}
              x2={plotW}
              y1={y(p)}
              y2={y(p)}
              stroke="var(--grid)"
              strokeWidth={0.5}
            />
          ))}

          {setup && (() => {
            const obIdx = Math.floor(n * 0.2);
            const left = x(obIdx);
            const right = plotW;
            const top = y(setup.obHigh);
            const bot = y(setup.obLow);
            return (
              <g>
                <rect x={left} y={top} width={right - left} height={Math.max(1, bot - top)} fill="url(#obFillPick)" />
                <rect
                  x={left}
                  y={top}
                  width={right - left}
                  height={Math.max(1, bot - top)}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.2}
                  rx={2}
                />
              </g>
            );
          })()}

          {visible.map((v, i) => {
            const cx = x(i);
            const isUp = i > 0 ? v >= visible[i - 1] : true;
            const c = isUp ? UP : DOWN;
            return (
              <line
                key={i}
                x1={cx}
                x2={cx}
                y1={y(Math.max(v, visible[Math.max(0, i - 1)]))}
                y2={y(Math.min(v, visible[Math.max(0, i - 1)]))}
                stroke={c}
                strokeWidth={1}
                opacity={0.7}
              />
            );
          })}

          {setup && setup.z >= view.min && setup.z <= view.max && (
            <line
              x1={0}
              x2={plotW}
              y1={y(setup.z)}
              y2={y(setup.z)}
              stroke={color}
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          )}

          {setup && setup.invalidation >= view.min && setup.invalidation <= view.max && (
            <line
              x1={0}
              x2={plotW}
              y1={y(setup.invalidation)}
              y2={y(setup.invalidation)}
              stroke={bullish ? DOWN : UP}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          )}

          {setup?.targets.slice(0, 2).map((t) =>
            t.price >= view.min && t.price <= view.max ? (
              <line
                key={t.label}
                x1={0}
                x2={plotW}
                y1={y(t.price)}
                y2={y(t.price)}
                stroke="#2563eb"
                strokeWidth={1}
                strokeDasharray="4 3"
              />
            ) : null
          )}

          <line
            x1={0}
            x2={plotW}
            y1={y(visible[n - 1])}
            y2={y(visible[n - 1])}
            stroke="var(--faint)"
            strokeWidth={0.5}
            strokeDasharray="1 3"
          />
        </svg>
      </div>

      <div className="pick-levels">
        {setup && (
          <>
            <span className="level-chip z-chip" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
              Z {fmtPrice(setup.z)}
            </span>
            <span className="level-chip inv-chip" style={{ background: `color-mix(in srgb, ${bullish ? DOWN : UP} 18%, transparent)`, color: bullish ? DOWN : UP }}>
              {bullish ? 'S1' : 'R1'} {fmtPrice(setup.invalidation)}
            </span>
            {setup.targets.slice(0, 2).map((t) => (
              <span key={t.label} className="level-chip tgt-chip" style={{ background: 'color-mix(in srgb, #2563eb 18%, transparent)', color: '#2563eb' }}>
                {t.label} {fmtPrice(t.price)}
              </span>
            ))}
            {setup.rr > 0 && (
              <span className="level-chip rr-chip" style={{ background: `color-mix(in srgb, ${setup.rr >= 2 ? UP : 'var(--muted)'} 18%, transparent)`, color: setup.rr >= 2 ? UP : 'var(--muted)' }}>
                1:{setup.rr.toFixed(1)}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}