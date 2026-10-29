import { useEffect, useMemo, useRef, useState } from 'react';
import type { Candle, Setup } from '../../shared/types';
import { clamp, fmtPrice, niceTicks } from '../lib/format';

interface Props {
  candles: Candle[];
  setup: Setup | null;
  vwap?: number | null;
  height?: number;
  showPrevious?: boolean;
  showContext?: boolean;
  maxCandles?: number;
  volumeProfile?: { poc: number; vah: number; val: number } | null;
  /** Draw the quote/base volume pane under the candles. */
  showVolume?: boolean;
}

const PAD_L = 8;
const PAD_R = 62;
const PAD_T = 10;
const PAD_B = 20;

const UP = '#16a34a';
const DOWN = '#dc2626';

function fmtClock(t: number, ist: boolean): string {
  const d = new Date(ist ? t + 330 * 60_000 : t);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function fmtDay(t: number, ist: boolean): string {
  const d = new Date(ist ? t + 330 * 60_000 : t);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()}`;
}

export function CandleChart({
  candles,
  setup,
  vwap,
  height = 320,
  showPrevious = true,
  showContext = true,
  maxCandles = 120,
  volumeProfile,
  showVolume = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  // Charts are fluid, so track the container rather than a fixed viewBox.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.clientWidth || 600);
    return () => ro.disconnect();
  }, []);

  const view = useMemo(() => {
    const n = candles.length;
    if (n === 0) return null;

    const visible = n > maxCandles ? candles.slice(-maxCandles) : candles;
    const ist = visible.length > 1 ? visible[visible.length - 1].t - visible[0].t > 12 * 3600_000 : true;

    let min = Infinity;
    let max = -Infinity;
    for (const c of visible) {
      if (c.l < min) min = c.l;
      if (c.h > max) max = c.h;
    }

    const levels: number[] = [];
    if (vwap && Number.isFinite(vwap)) levels.push(vwap);
    if (volumeProfile) {
      if (Number.isFinite(volumeProfile.poc)) levels.push(volumeProfile.poc);
      if (Number.isFinite(volumeProfile.vah)) levels.push(volumeProfile.vah);
      if (Number.isFinite(volumeProfile.val)) levels.push(volumeProfile.val);
    }
    if (setup) {
      levels.push(setup.obLow, setup.obHigh, setup.z, setup.invalidation);
      for (const t of setup.targets) levels.push(t.price);
      if (showContext) for (const c of setup.context) levels.push(c.price);
      if (showPrevious) for (const p of setup.previous) levels.push(p.obLow, p.obHigh);
    }
    for (const v of levels) {
      if (v >= min && v <= max) {
        min = v;
        max = v;
      } else if (v < min && v > min * 0.9) min = v;
      else if (v > max && v < max * 1.1) max = v;
    }

    const pad = (max - min) * 0.08 || Math.max(max * 0.01, 0.0001);
    min -= pad;
    max += pad;
    if (min < 0) min = 0;

    const padB = showVolume ? 58 : PAD_B;
    const plotW = Math.max(40, width - PAD_L - PAD_R);
    const plotH = Math.max(40, height - PAD_T - padB);
    let maxV = 0;
    if (showVolume) for (const c of visible) if (Number.isFinite(c.v) && c.v > maxV) maxV = c.v;
    const x = (i: number) => PAD_L + (i / Math.max(1, visible.length - 1)) * plotW;
    const y = (p: number) => PAD_T + (1 - (p - min) / (max - min)) * plotH;

    return { visible, ist, min, max, plotW, plotH, x, y, maxV };
  }, [candles, setup, vwap, volumeProfile, width, height, showPrevious, showContext, maxCandles, showVolume]);

  if (!view) {
    return (
      <div
        ref={wrapRef}
        className="flex items-center justify-center text-[12px]"
        style={{ height, color: 'var(--muted)' }}
      >
        No candles
      </div>
    );
  }

  const { visible, ist, min, max, plotW, plotH, x, y, maxV } = view;
  const n = visible.length;
  const bodyW = Math.max(1.5, Math.min(9, (plotW / n) * 0.66));
  const bullish = setup?.side === 'bullish';
  const accent = bullish ? UP : DOWN;

  // Time gridlines roughly every hour block.
  const gridCount = Math.min(7, Math.floor(plotW / 110));
  const gridIdx = Array.from({ length: gridCount + 1 }, (_, k) =>
    Math.round((k / gridCount) * (n - 1)),
  );

  const last = visible[n - 1];
  const hovered = hover !== null ? visible[hover] : null;
  const multiDay = last.t - visible[0].t >= 24 * 3600_000;
  const axisLabel = (i: number, k: number) => {
    if (!multiDay) return fmtClock(visible[i].t, ist);
    if (k === 0) return fmtDay(visible[i].t, ist);
    const date = new Date(visible[i].t + (ist ? 330 * 60_000 : 0));
    const prev = new Date(visible[gridIdx[k - 1]].t + (ist ? 330 * 60_000 : 0));
    return date.getUTCDate() === prev.getUTCDate()
      ? fmtClock(visible[i].t, ist)
      : fmtDay(visible[i].t, ist);
  };
  const volBase = height - 18;
  const volTop = PAD_T + plotH + 14;
  const volH = Math.max(1, volBase - volTop);

  /**
   * The chart is meaningful to a screen reader only if it says what it is
   * showing, so the description is derived from the data actually drawn rather
   * than hardcoded. It states the zone only when a zone is present, because
   * "no order block right now" is information, not a missing field.
   */
  const ariaLabel = setup
    ? `Price chart, ${n} candles, latest close ${fmtPrice(last.c)}. ` +
      `${setup.side === 'bullish' ? 'Bullish' : 'Bearish'} order block zone ` +
      `from ${fmtPrice(setup.obLow)} to ${fmtPrice(setup.obHigh)}, ` +
      `invalidation ${fmtPrice(setup.invalidation)}.`
    : `Price chart, ${n} candles, latest close ${fmtPrice(last.c)}. No order block zone is currently marked.`;

  return (
    <div
      ref={wrapRef}
      className="relative select-none"
      style={{ height }}
      onMouseLeave={() => setHover(null)}
    >
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        data-testid="candle-chart"
        style={{ display: 'block', touchAction: 'pan-y' }}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const rel = e.clientX - rect.left - PAD_L;
          const idx = Math.round((rel / plotW) * (n - 1));
          setHover(idx >= 0 && idx < n ? idx : null);
        }}
      >
        <defs>
          <linearGradient id="obFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.26" />
            <stop offset="100%" stopColor={accent} stopOpacity="0.05" />
          </linearGradient>
        </defs>

        {/* Horizontal price grid + right-hand axis */}
        {niceTicks(min, max, 5).map((p, i) => (
          <g key={i}>
            <line
              x1={PAD_L}
              x2={PAD_L + plotW}
              y1={y(p)}
              y2={y(p)}
              stroke="var(--grid)"
              strokeWidth={1}
            />
            <text
              x={PAD_L + plotW + 6}
              y={y(p) + 3}
              fontSize={9.5}
              fill="var(--faint)"
              className="mono"
            >
              {fmtPrice(p)}
            </text>
          </g>
        ))}

        {/* Vertical time gridlines */}
        {gridIdx.map((i) => (
          <line
            key={`v${i}`}
            x1={x(i)}
            x2={x(i)}
            y1={PAD_T}
            y2={PAD_T + plotH}
            stroke="var(--grid)"
            strokeWidth={1}
            strokeDasharray="2 4"
          />
        ))}

        {showVolume && maxV > 0 && (
          <g data-testid="volume-pane">
            <line
              x1={PAD_L}
              x2={PAD_L + plotW}
              y1={volTop}
              y2={volTop}
              stroke="var(--grid)"
              strokeWidth={1}
            />
            <text x={PAD_L + 1} y={volTop - 4} fontSize={8.5} fill="var(--faint)" className="mono">
              VOL
            </text>
            {visible.map((c, i) => {
              const vh = Math.max(0, (c.v / maxV) * volH);
              return (
                <rect
                  key={`vol${c.t}`}
                  data-testid="volume-bar"
                  x={x(i) - bodyW / 2}
                  y={volBase - vh}
                  width={bodyW}
                  height={vh}
                  fill={c.c >= c.o ? UP : DOWN}
                  opacity={0.42}
                />
              );
            })}
          </g>
        )}

        {/* Previous setups, left where they happened */}
        {showPrevious &&
          setup?.previous.map((p, i) => {
            const idx = visible.findIndex((c) => c.t >= p.obTime);
            if (idx < 0) return null;
            const top = y(p.obHigh);
            const bot = y(p.obLow);
            if (top < PAD_T || bot > PAD_T + plotH) return null;
            return (
              <rect
                key={`prev${i}`}
                x={x(idx)}
                y={top}
                width={PAD_L + plotW - x(idx)}
                height={Math.max(1, bot - top)}
                fill="none"
                stroke={p.side === 'bullish' ? UP : DOWN}
                strokeOpacity={0.28}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            );
          })}

        {/* Current order block: box + zone band */}
        {setup && (() => {
          const idx = visible.findIndex((c) => c.t >= setup.obTime);
          if (idx < 0) return null;
          const top = y(setup.obHigh);
          const bot = y(setup.obLow);
          const left = x(idx);
          const right = PAD_L + plotW;
          return (
            <g>
              <rect x={left} y={top} width={right - left} height={Math.max(1, bot - top)} fill="url(#obFill)" />
              <rect
                x={left}
                y={top}
                width={right - left}
                height={Math.max(1, bot - top)}
                fill="none"
                stroke={accent}
                strokeWidth={1.4}
                rx={2}
              />
              <text x={left + 5} y={top - 3} fontSize={9.5} fill={accent} fontWeight={700} className="mono">
                {`OB ${fmtPrice(setup.obLow)}–${fmtPrice(setup.obHigh)}`}
              </text>
            </g>
          );
        })()}

        {/* Candles */}
        {visible.map((c, i) => {
          const isUp = c.c >= c.o;
          const color = isUp ? UP : DOWN;
          const cx = x(i);
          const top = y(Math.max(c.o, c.c));
          const bot = y(Math.min(c.o, c.c));
          const doji = Math.abs(bot - top) < 1;
          return (
            <g key={c.t} opacity={c.closed ? 1 : 0.55} data-testid="candle" data-closed={c.closed ? 'true' : 'false'}>
              <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth={1} />
              {doji ? (
                <line x1={cx - bodyW / 2} x2={cx + bodyW / 2} y1={top} y2={top} stroke={color} strokeWidth={1.4} />
              ) : (
                <rect
                  x={cx - bodyW / 2}
                  y={top}
                  width={bodyW}
                  height={Math.max(1, bot - top)}
                  fill={color}
                  rx={0.5}
                />
              )}
            </g>
          );
        })}

        {/* VWAP */}
        {vwap && Number.isFinite(vwap) && vwap >= min && vwap <= max && (
          <g>
            <line
              x1={PAD_L}
              x2={PAD_L + plotW}
              y1={y(vwap)}
              y2={y(vwap)}
              stroke="#eab308"
              strokeWidth={1.2}
              strokeDasharray="5 4"
            />
            <text x={PAD_L + 3} y={y(vwap) - 3} fontSize={9.5} fill="#eab308" className="mono">
              VWAP
            </text>
          </g>
        )}

        {/* Volume Profile: POC (amber solid), VAH/VAL (blue dashed) */}
        {volumeProfile && [
          { price: volumeProfile.poc, label: 'POC', color: '#eab308', dash: undefined, width: 1.6 },
          { price: volumeProfile.vah, label: 'VAH', color: 'rgba(99,179,237,0.8)', dash: '4 3', width: 1 },
          { price: volumeProfile.val, label: 'VAL', color: 'rgba(99,179,237,0.8)', dash: '4 3', width: 1 },
        ].filter((l) => Number.isFinite(l.price) && l.price >= min && l.price <= max).map((l) => (
          <g key={l.label}>
            <line
              x1={PAD_L} x2={PAD_L + plotW}
              y1={y(l.price)} y2={y(l.price)}
              stroke={l.color} strokeWidth={l.width}
              strokeDasharray={l.dash}
            />
            <rect x={PAD_L + plotW - 28} y={y(l.price) - 7} width={26} height={13} rx={2} fill="#0A0D11" opacity={0.85} />
            <text x={PAD_L + plotW - 15} y={y(l.price) + 3} fontSize={9} fill={l.color} fontWeight={700} textAnchor="middle" className="mono">
              {l.label}
            </text>
          </g>
        ))}

        {/* Context levels: amber dotted, drawn across the whole chart */}
        {showContext &&
          setup?.context
            .filter((c) => c.price >= min && c.price <= max)
            .map((c, i) => (
              <g key={`ctx${i}`}>
                <line
                  x1={PAD_L}
                  x2={PAD_L + plotW}
                  y1={y(c.price)}
                  y2={y(c.price)}
                  stroke="#d97706"
                  strokeOpacity={0.55}
                  strokeWidth={1}
                  strokeDasharray="2 3"
                />
                <text x={PAD_L + 3} y={y(c.price) - 2.5} fontSize={9} fill="#d97706" opacity={0.8} className="mono">
                  {c.label}
                </text>
              </g>
            ))}

        {/* Zone level Z */}
        {setup && setup.z >= min && setup.z <= max && (
          <LevelLine
            y={y(setup.z)}
            plotW={plotW}
            color={accent}
            label={`Z ${fmtPrice(setup.z)}`}
            width={1.8}
          />
        )}

        {/* Invalidation: S1 on bullish, R1 on bearish */}
        {setup && setup.invalidation >= min && setup.invalidation <= max && (
          <LevelLine
            y={y(setup.invalidation)}
            plotW={plotW}
            color="#dc2626"
            label={`${bullish ? 'S1' : 'R1'} ${fmtPrice(setup.invalidation)}`}
            width={1.6}
            dash="6 3"
          />
        )}

        {/* Liquidity targets in the direction of the move */}
        {setup?.targets.map((t) =>
          t.price >= min && t.price <= max ? (
            <LevelLine
              key={t.label}
              y={y(t.price)}
              plotW={plotW}
              color="#2563eb"
              label={`${t.label} ${fmtPrice(t.price)}`}
              width={1.3}
              dash="4 3"
            />
          ) : null,
        )}

        {/* Last price marker */}
        <line
          x1={PAD_L}
          x2={PAD_L + plotW}
          y1={y(last.c)}
          y2={y(last.c)}
          stroke="var(--faint)"
          strokeWidth={0.8}
          strokeDasharray="1 3"
        />
        <rect
          x={PAD_L + plotW + 2}
          y={y(last.c) - 7}
          width={PAD_R - 6}
          height={14}
          rx={3}
          fill={last.c >= last.o ? UP : DOWN}
        />
        <text
          x={PAD_L + plotW + 6}
          y={y(last.c) + 3.5}
          fontSize={9.5}
          fill="#fff"
          fontWeight={700}
          className="mono"
        >
          {fmtPrice(last.c)}
        </text>

        {/* Time axis labels */}
        {gridIdx.map((i, k) => (
          <text
            key={`t${i}`}
            x={clamp(x(i), PAD_L + 12, PAD_L + plotW - 12)}
            y={height - 6}
            fontSize={9.5}
            fill="var(--faint)"
            textAnchor="middle"
            className="mono"
          >
            {axisLabel(i, k)}
          </text>
        ))}

        {/* Crosshair */}
        {hover !== null && hovered && (
          <g pointerEvents="none">
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD_T}
              y2={PAD_T + plotH}
              stroke="var(--faint)"
              strokeWidth={0.8}
            />
            <rect
              x={PAD_L + plotW + 2}
              y={y(hovered.c) - 7}
              width={PAD_R - 6}
              height={14}
              rx={3}
              fill="var(--muted)"
            />
            <text
              x={PAD_L + plotW + 6}
              y={y(hovered.c) + 3.5}
              fontSize={9.5}
              fill="#fff"
              className="mono"
            >
              {fmtPrice(hovered.c)}
            </text>
          </g>
        )}
      </svg>

      {/* OHLC readout */}
      <div
        className="mono text-[10px] absolute top-1 left-9 flex gap-3 pointer-events-none"
        style={{ color: 'var(--muted)' }}
      >
        {(hovered ?? last) && (
          <>
            <span>O {(hovered ?? last).o.toPrecision(6)}</span>
            <span>H {(hovered ?? last).h.toPrecision(6)}</span>
            <span>L {(hovered ?? last).l.toPrecision(6)}</span>
            <span>C {(hovered ?? last).c.toPrecision(6)}</span>
          </>
        )}
      </div>
    </div>
  );
}

function LevelLine({
  y,
  plotW,
  color,
  label,
  width,
  dash,
}: {
  y: number;
  plotW: number;
  color: string;
  label: string;
  width: number;
  dash?: string;
}) {
  const textWidth = label.length * 5.6 + 10;
  return (
    <g>
      <line
        x1={8}
        x2={8 + plotW}
        y1={y}
        y2={y}
        stroke={color}
        strokeWidth={width}
        strokeDasharray={dash}
      />
      <rect x={8 + plotW - textWidth - 4} y={y - 7} width={textWidth} height={14} rx={3} fill={color} />
      <text
        x={8 + plotW - textWidth + 1}
        y={y + 3.5}
        fontSize={9.5}
        fill="#fff"
        fontWeight={700}
        textAnchor="start"
        className="mono"
      >
        {label}
      </text>
    </g>
  );
}
