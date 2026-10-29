import { useMemo } from 'react';
import type { AssetRow } from '../../shared/types';
import { ScoreRing, GradePips, liveFor } from './charts';
import { pipsFor } from './MarketDepth';
import type { LivePriceMap } from './types';

/**
 * Detail ticket — clone of the reference #tickets column.
 * hero = first rank of a side (230px tall, plan bar), std = rank 2..3 (bottom
 * level strip). Info block on the left, order-block chart on the right, a side
 * rail showing where price sits inside the plan.
 */
export function Ticket({
  row,
  hero = false,
  height,
  prices,
  onSelect,
  selected,
}: {
  row: AssetRow;
  rank: number;
  hero?: boolean;
  height: number;
  prices?: LivePriceMap;
  onSelect: (symbol: string) => void;
  selected: string | null;
}) {
  const bull = row.side === 'bullish';
  const color = bull ? '#3FD487' : '#F87171';
  const live = liveFor(row, prices);
  const px = live?.price ?? row.price;
  const chg = live?.changePct ?? row.changePct;
  const score = row.conviction?.score ?? row.percentile;
  const s = row.setup;

  const invLabel = bull ? 'S1' : 'R1';
  const t1Label = bull ? 'R1' : 'S1';
  const t2Label = bull ? 'R2' : 'S2';
  const t1 = s?.targets[0];
  const t2 = s?.targets[1];
  const riskPct = s && Number.isFinite(s.z) && Number.isFinite(s.invalidation) ? (Math.abs(s.z - s.invalidation) / s.z) * 100 : 0;
  const rr = s?.rr ?? 0;
  const pts = px * (chg / 100);
  const name = row.displayName ?? row.name;
  const tkr = row.displayTicker ?? row.base;

  return (
    <button
      type="button"
      className={`st-tick ${bull ? 'bull' : 'bear'} ${hero ? 'hero' : ''} ${selected === row.base ? 'sel' : ''}`}
      style={{ height }}
      onClick={() => onSelect(row.base)}
      aria-label={row.base}
    >
      <span className="gb" aria-hidden />
      <span className="sheen" aria-hidden />
      <span className="spec" aria-hidden />
      <span className="acc" aria-hidden />

      <div className="ab info">
        <div className="rowa">
          <span className="mg">{row.base.slice(0, 2).toUpperCase()}</span>
          <span className="idc">
            <span className="tkr">{tkr}</span>
            <span className="nm">
              <em className="nmn">{name}</em>
            </span>
          </span>
        </div>
        <div className="rowb">
          <span className="pill">{bull ? 'BULL' : 'BEAR'}</span>
          <span className="cgrp">
            <span className="cring">
              <ScoreRing score={score} size={hero ? 40 : 30} stroke={3.5} />
            </span>
            <span className="pips">
              <GradePips n={pipsFor(row)} color={color} size={3} />
            </span>
          </span>
        </div>
        <div className="rowc">
          <span className={`pc ${hero ? 'hero-pc' : ''} ${chg >= 0 ? 'pos' : 'neg'}`}>
            {chg >= 0 ? '+' : ''}
            {chg.toFixed(2)}%
          </span>
        </div>
        <div className="rowd mono">
          <span className="ltp">{fmtPx(px)}</span>
          <span className={`pts ${chg >= 0 ? 'pos' : 'neg'}`}>{chg >= 0 ? '+' : ''}{pts.toFixed(2)}</span>
          <span className="pctl">P{Number.isFinite(row.percentile) ? row.percentile.toFixed(1) : '—'}</span>
        </div>
      </div>

      <div className={`chart ${hero ? '' : 'std'}`}>
        <TicketChart row={row} width={hero ? 316 : 312} height={hero ? 142 : 93} color={color} />
      </div>

      {hero ? (
        <div className="plan">
          <div className="cells">
            <span className="pcell sl mono">{invLabel} {s ? fmtLvl(row, s.invalidation) : '—'}</span>
            <span className="pcell en mono">ZONE {s ? fmtLvl(row, s.z) : '—'}</span>
            <span className="pcell t1 mono">{t1Label} {t1 ? fmtLvl(row, t1.price) : '—'}</span>
            <span className="pcell t2 mono">{t2Label} {t2 ? fmtLvl(row, t2.price) : '—'}</span>
            <span className="pcell rr kabs mono">RISK {riskPct.toFixed(2)}% 1:{rr > 0 ? rr.toFixed(1) : '—'}</span>
          </div>
          <div className="rrbar" aria-hidden>
            <i className="r0" />
            <i className="r1" />
            <i className="tk" />
            <i className="tk" />
          </div>
        </div>
      ) : (
        <div className="lvlstrip nosep two">
          <div className="l1">
            <span>ZONE <b className="mono">{s ? fmtLvl(row, s.z) : '—'}</b></span>
            <span>{invLabel} <b className="mono">{s ? fmtLvl(row, s.invalidation) : '—'}</b></span>
          </div>
          <div className="l2">
            <span>{t1Label} <b className="mono">{s && t1 ? fmtLvl(row, t1.price) : '—'}</b></span>
            <span>{t2Label} <b className="mono">{s && t2 ? fmtLvl(row, t2.price) : '—'}</b></span>
            <span>R:R <b className="mono">{rr > 0 ? rr.toFixed(1) : '—'}</b></span>
          </div>
        </div>
      )}

      <StartRail row={row} px={px} height={height} color={color} />
      <div className="railsep" aria-hidden />
    </button>
  );
}

/** Right-edge chart: spark, order-block band, plan levels and live point. */
function TicketChart({ row, width, height, color }: { row: AssetRow; width: number; height: number; color: string }) {
  const { path, area, ob, lvs, lp, rise } = useMemo(() => {
    const s = row.setup;
    const spark = row.spark.length >= 2 ? row.spark : [s?.z ?? 0, s?.z ?? 0];
    const vals = [...spark];
    if (s) vals.push(s.z, s.invalidation, s.obLow, s.obHigh);
    s?.targets.slice(0, 2).forEach((t) => vals.push(t.price));
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { path: '', area: '', ob: null, lvs: [], lp: null, rise: [] };
    const pad = (max - min) * 0.14 || 1;
    min -= pad;
    max += pad;
    const span = max - min || 1;
    const X = (i: number) => i * (width / (Math.max(1, spark.length - 1)));
    const Y = (v: number) => height - ((v - min) / span) * (height - 4) - 2;
    let p = '';
    spark.forEach((v, i) => {
      p += `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
    });
    const area = p ? `${p}L${width},${height}L0,${height}Z` : '';
    const bull = row.side === 'bullish';
    const lvs: { price: number; label: string; color: string; y: number }[] = [];
    if (s) {
      lvs.push({ price: s.invalidation, label: invLbl(bull), color: '#FBBF24', y: Y(s.invalidation) });
      lvs.push({ price: s.z, label: 'Z', color, y: Y(s.z) });
      s.targets.slice(0, 2).forEach((t, i) => lvs.push({ price: t.price, label: bull ? `R${i + 1}` : `S${i + 1}`, color: '#8AB4E8', y: Y(t.price) }));
    }
    lvs.sort((a, b) => b.price - a.price);
    const last = spark[spark.length - 1];
    const lp = { x: width - 2, y: Y(last) };
    let ob: { y0: number; y1: number } | null = null;
    if (s && Number.isFinite(s.obLow) && Number.isFinite(s.obHigh)) {
      ob = { y0: Y(Math.max(s.obLow, s.obHigh)), y1: Y(Math.min(s.obLow, s.obHigh)) };
    }
    const rise = [
      { x1: width - 24, y1: lp.y, x2: width - 10, y2: Math.max(2, lp.y - height * 0.08) },
      { x1: width - 12, y1: height - 3, x2: width - 1, y2: Math.max(2, height - 3 - height * 0.06) },
    ];
    return { path: p, area, ob, lvs, lp, rise };
  }, [row, width, height, color]);

  const oi = row.derivatives?.oiChange?.h1;
  const cvd = row.derivatives?.cvd;
  const bull = row.side === 'bullish';

  return (
    <div className="tc" style={{ width, height }}>
      <svg width={width} height={height} aria-hidden>
        {ob && (
          <rect x={0} y={ob.y0} width={width} height={Math.max(1, ob.y1 - ob.y0)} fill={color} opacity={0.14} />
        )}
        {area && <path d={area} fill={color} opacity={0.08} stroke="none" />}
        {path && (
          <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.95} />
        )}
        {lvs.map((l, i) => (
          <g key={i}>
            <line x1={0} y1={l.y} x2={width} y2={l.y} stroke={l.color} strokeWidth={0.9} strokeDasharray={l.label === 'Z' ? 'none' : '2 3'} opacity={l.label === 'Z' ? 0.9 : 0.6} />
            <rect x={width - 34} y={l.y - 8} width={32} height={12} rx={2} fill="#0A0D11" opacity={0.9} />
            <text x={width - 18} y={l.y - 0.5} textAnchor="middle" fontSize={9.5} fontWeight={700} fill={l.color} fontFamily="JetBrains Mono, monospace">
              {l.label}
            </text>
          </g>
        ))}
        {rise.map((r, i) => (
          <line key={i} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} stroke={color} strokeWidth={1.2} opacity={0.35} />
        ))}
        {lp && (
          <g>
            <circle cx={lp.x} cy={lp.y} r={2.2} fill="#E6EBF4" />
            <circle cx={lp.x} cy={lp.y} r={4.5} fill="none" stroke="#E6EBF4" opacity={0.4} />
          </g>
        )}
      </svg>
      {row.setup && (
        <div className="ovl lg">
          <span className="buc">{bull ? 'LONG BUILD-UP' : 'SHORT BUILD-UP'}</span>
          <span className="oi">OI {oi == null ? '—' : `${oi >= 0 ? '+' : ''}${oi.toFixed(1)}%`}</span>
          <span className="dl">Δ {cvd == null ? '—' : fmtCvd(cvd)}</span>
        </div>
      )}
    </div>
  );
}

/** The 20px side rail — where price sits inside the plan. */
function StartRail({ row, px, height, color }: { row: AssetRow; px: number; height: number; color: string }) {
  const { segs, pos } = useMemo(() => {
    const s = row.setup;
    const def = {
      segs: [
        { y0: 4, y1: height - 4, kind: 'risk' },
      ],
      pos: Math.max(0.04, Math.min(0.96, 0.5)),
      risk: false,
    };
    if (!s || !Number.isFinite(s.invalidation) || !s.targets[0]) return def;
    const t2p = s.targets[1]?.price ?? s.targets[0].price;
    const lo = Math.min(s.invalidation, s.z, t2p);
    const hi = Math.max(s.invalidation, s.z, t2p);
    const span = hi - lo || 1;
    const Y = (v: number) => height - ((v - lo) / span) * (height - 10) + 2;
    const yz = Y(s.z);
    const yi = Y(s.invalidation);
    const yt = Y(t2p);
    const segs = [
      { y0: Math.min(yi, yz), y1: Math.max(yi, yz), kind: 'risk' },
      { y0: Math.min(yz, yt), y1: Math.max(yz, yt), kind: 'gain' },
    ].map((g) => ({ ...g, y0: Math.round(g.y0), y1: Math.round(g.y1) }));
    const pos = (px - lo) / span;
    return { segs, pos: Math.max(0.02, Math.min(0.98, pos)), risk: Math.abs(s.z - s.invalidation) < 1e-9 };
  }, [row, px, height]);

  return (
    <svg className="rail" width={20} height={height} aria-hidden>
      {segs.map((g, i) => (
        <rect
          key={i}
          x={8}
          y={g.y0}
          width={3}
          height={Math.max(1, g.y1 - g.y0)}
          rx={1.5}
          fill={g.kind === 'risk' ? 'rgba(255,77,103,0.5)' : color}
          opacity={g.kind === 'risk' ? 0.55 : 0.5}
        />
      ))}
      <line x1={1} y1={4 + (height - 8) * (1 - pos)} x2={18} y2={4 + (height - 8) * (1 - pos)} stroke="#E6EBF4" strokeWidth={1.4} />
    </svg>
  );
}

function invLbl(bull: boolean): string {
  return bull ? 'S1' : 'R1';
}

function fmtCvd(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  if (v <= -1000) return `${(v / 1000).toFixed(1)}K`;
  return `${v >= 0 ? '+' : ''}${v.toFixed(0)}`;
}

function fmtPx(v: number): string {
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: v >= 1 ? 2 : 4 })}`;
}

function fmtLvl(row: AssetRow, v: number): string {
  const digits = row.price >= 1 ? 2 : 6;
  return v.toFixed(digits);
}