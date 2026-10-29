import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AssetRow, FanPayload, MarketPicture, ScanResult, SectorFlow } from '../../shared/types';
import { api, usePolling } from '../lib/api';
import { fmtPct, istStamp } from '../lib/format';
import './stage.css';
import { FanCanvas } from './FanCanvas';
import { GradePips, fitScale, liveFor } from './charts';
import { pipsFor } from './MarketDepth';
import { usePriceRevision } from '../lib/priceStore';
import { Ticket } from './Ticket';
import {
  BEAR_Y_OFFSET,
  BOARD_PER_SIDE,
  BRIDGE_TOPS,
  CHIP_DY,
  CHIPS_X,
  COUNT,
  CREST,
  IDXTAGS,
  LANES,
  LADDER_X,
  LENS,
  NODE,
  NOW_LINE,
  RET,
  SPINE,
  TICKETS_W,
  slotIndex,
} from './geometry';
import type { LivePriceMap, StageProps } from './types';

/**
 * Full 1920x1200 order-block stage, scaled to fit its container.
 * Every box mirrors order-block.com/app/orderblock #stage: crest with bull/bear
 * counts and leading-sector tag, sector chips (up col then down col), the rank
 * ladder, the node pipeline (source -> now -> gate -> lens -> reactor) wired by
 * the spine, the tile funnel c1..c4, bridges, detail tickets and the fx
 * connectors. The 24h fan plays the reference #cvPlume.
 */
export function StageView(props: StageProps) {
  const { data } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<string | null>(null);

  // The 24h fan — one thread per tracked asset; the reference `#cvPlume`.
  const fanState = usePolling((s) => api.fan(s), 60_000);
  const fan = fanState.data;
  const active = hover ?? props.selected;
  const onHover = useCallback((base: string | null) => setHover(base), []);

  // Re-render the stage when any displayed price changes. This view renders a
  // whole list of prices at once, so a single coarse subscription is cheaper
  // than one per cell — and it is scoped to the stage, never the app shell.
  usePriceRevision();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = fitScale(w);
  const bull = data.bullish.slice(0, BOARD_PER_SIDE);
  const bear = data.bearish.slice(0, BOARD_PER_SIDE);

  return (
    <div
      ref={wrapRef}
      className="stage-scroll"
      style={{ position: 'relative', borderRadius: 12, width: '100%', height: Math.round(1200 * scale), overflow: 'hidden' }}
    >
      {w > 0 && (
        <div className="stage-shell" style={{ transform: `scale(${scale})`, width: 1920, height: 1200 }}>
          <Plume fan={fan} active={active} onHover={onHover} onSelect={props.onSelect} onClear={props.onClear} />
          <LensBox />
          <Spine />
          <TopRail data={data} />
          <Crest market={data.market} sectors={data.sectors} />
          <Chips sectors={data.sectors} />
          <IdxTags bull={bull} bear={bear} />
          <Ladder bull={bull} bear={bear} />
          <Nodes total={data.market.total} bull={bull.length} bear={bear.length} picks={countPicks(data)} />
          <Tiles bull={bull} bear={bear} prices={props.prices} selected={props.selected} onSelect={props.onSelect} />
          <Bridges bull={bull} bear={bear} onSelect={props.onSelect} />
          <Fx bull={bull} bear={bear} selected={props.selected} />
          <Tickets bull={bull} bear={bear} prices={props.prices} selected={props.selected} onSelect={props.onSelect} />
          <Footer updatedAt={data.updatedAt} regime={data.regime} />
        </div>
      )}
    </div>
  );
}

function countPicks(data: ScanResult): number {
  return [...data.bullish, ...data.bearish].filter((r) => r.isPick).length;
}

function Plume({
  fan,
  active,
  onHover,
  onSelect,
  onClear,
}: {
  fan?: FanPayload | null;
  active: string | null;
  onHover: (base: string | null) => void;
  onSelect: (symbol: string) => void;
  onClear: () => void;
}) {
  return (
    <>
      <div className="st-plume" />
      {fan && fan.assets.length > 0 && (
        <div className="st-fan">
          <FanCanvas fan={fan} active={active} sector={null} onHover={onHover} onSelect={onSelect} onClear={onClear} />
        </div>
      )}
    </>
  );
}

/** The reference #cvLens — a faint funnel that pools threads into the gate. */
function LensBox() {
  return (
    <div className="st-lensbox" style={{ left: LENS.x, top: LENS.y, width: LENS.w, height: LENS.h }} aria-hidden />
  );
}

/** The reference #cvSpine — full-width band carrying the node pipeline. */
function Spine() {
  return (
    <div className="st-spine" style={{ left: SPINE.x, top: SPINE.y, width: SPINE.w, height: SPINE.h }} aria-hidden>
      <i className="sk a" />
      <i className="sk b" />
      <i className="sk c" />
    </div>
  );
}

/** The reference #cvFx — left-to-right connectors from tiles, through bridges, into tickets. */
function Fx({ bull, bear, selected }: { bull: AssetRow[]; bear: AssetRow[]; selected: string | null }) {
  const segs = useMemo(() => {
    const out: { side: 'bullish' | 'bearish'; y: number; on: boolean }[] = [];
    for (const side of ['bullish', 'bearish'] as const) {
      const list = side === 'bullish' ? bull : bear;
      const tops = side === 'bullish' ? BRIDGE_TOPS.bull : BRIDGE_TOPS.bear;
      list.slice(0, 3).forEach((r, i) => out.push({ side, y: tops[i] + 55, on: selected == null || selected === r.base }));
    }
    return out;
  }, [bull, bear, selected]);

  return (
    <svg className="st-fx" width={1920} height={1200} viewBox="0 0 1920 1200" aria-hidden>
      {segs.map((s, i) => (
        <g key={i} className={`fx-g ${s.side}${s.on ? ' on' : ''}`}>
          <path d={`M 1356 ${s.y} C 1361 ${s.y - 6}, 1364 ${s.y + 6}, 1368 ${s.y}`} />
        </g>
      ))}
    </svg>
  );
}

function TopRail({ data }: { data: ScanResult }) {
  return (
    <div className="st-rail">
      <span className="dot green" />
      <b className="t">BLOCK SCAN</b>
      <span className="sep" />
      <span>TRACKING {data.market.total} PAIRS</span>
      <span className="sep" />
      <span>BREADTH {data.breadthBias.toUpperCase()}</span>
      <span className="sep" />
      <span>REGIME {data.regime.replace(/_/g, ' ').toUpperCase()}</span>
      <span className="spacer" />
      <b className="t mono">#{(data.totalScanned ?? data.market.total).toLocaleString('en-US')}</b>
      <span className="sep" />
      <span className="mono">{istStamp(data.updatedAt)} IST</span>
    </div>
  );
}

function Crest({ market, sectors }: { market: MarketPicture; sectors: SectorFlow[] }) {
  const lead = market.leadingSector ? sectors.find((s) => s.sector === market.leadingSector) : null;
  const leadPct = lead?.avgChange ?? 0;
  const leadUp = leadPct >= 0;
  return (
    <div className="st-crest" style={{ left: CREST.x, top: CREST.y, width: CREST.w, height: CREST.h }}>
      <div className="pcount">
        <div className="share bull">
          <span className="tri">
            <svg width={11} height={9} viewBox="0 0 11 9" aria-hidden>
              <path d="M5.5 0 L11 9 L0 9 Z" fill="currentColor" />
            </svg>
          </span>
          <span className="k">BULLISH</span>
          <b className="n mono">{market.bullishCount}</b>
        </div>
        <div className="share bear">
          <span className="tri">
            <svg width={11} height={9} viewBox="0 0 11 9" aria-hidden>
              <path d="M5.5 9 L11 0 L0 0 Z" fill="currentColor" />
            </svg>
          </span>
          <span className="k">BEARISH</span>
          <b className="n mono">{market.bearishCount}</b>
        </div>
      </div>
      <i className="pz" aria-hidden />
      <div className={`ptag ${leadUp ? 'up' : 'dn'}`} data-sec={market.leadingSector ?? ''}>
        <span className="arr" aria-hidden>
          {leadUp ? (
            <svg width={11} height={9} viewBox="0 0 11 9">
              <path d="M5.5 0 L11 9 L0 9 Z" fill="currentColor" />
            </svg>
          ) : (
            <svg width={11} height={9} viewBox="0 0 11 9">
              <path d="M5.5 9 L11 0 L0 0 Z" fill="currentColor" />
            </svg>
          )}
        </span>
        <span className="k">LEADING SECTOR</span>
        <b>{market.leadingSector ?? '—'}</b>
        <span className="v mono">{lead ? fmtPct(leadPct) : '—'}</span>
      </div>
    </div>
  );
}

function Chips({ sectors }: { sectors: SectorFlow[] }) {
  // Reference sorts the up half (strongest first, top 112 step 26) and packs the
  // down half in the lower band (top 806.857 step ~48.16).
  const { up, dn } = useMemo(() => {
    const up: SectorFlow[] = [];
    const dn: SectorFlow[] = [];
    for (const s of sectors) (s.avgChange >= 0 ? up : dn).push(s);
    up.sort((a, b) => b.avgChange - a.avgChange);
    dn.sort((a, b) => a.avgChange - b.avgChange);
    return { up, dn };
  }, [sectors]);

  return (
    <div className="st-chips" style={{ left: CHIPS_X, top: 0 }}>
      {up.map((s, i) => (
        <SectorChip key={s.sector} s={s} top={112 + i * CHIP_DY} up tall />
      ))}
      {dn.map((s, i) => (
        <SectorChip key={s.sector} s={s} top={806.857 + i * 48.163} up={false} />
      ))}
    </div>
  );
}

function SectorChip({ s, top, up, tall = false }: { s: SectorFlow; top: number; up: boolean; tall?: boolean }) {
  const members = s.members.slice(0, 18);
  return (
    <div className={`st-chip ${up ? 'up' : 'dn'}${tall ? ' tall' : ''}`} style={{ top, height: up ? (tall ? CHIP_DY - 4 : 44) : 44 }}>
      <div className="r1">
        <span className="cap">{abbrev(s.sector)}</span>
        <span className="v mono">{up && s.avgChange > 0 ? '+' : ''}{s.avgChange.toFixed(2)}%</span>
      </div>
      <span className="strip">
        {members.map((m, j) => (
          <i
            key={`${m.symbol}-${j}`}
            style={{
              background: m.changePct >= 0 ? 'rgba(30,158,110,.9)' : 'rgba(194,58,82,.75)',
              opacity: 0.3 + 0.7 * (1 - j / Math.max(1, members.length)),
            }}
          />
        ))}
      </span>
    </div>
  );
}

function abbrev(name: string): string {
  const words = name.split(/[\s&/]+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 5).toUpperCase();
  return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

/** Index-tag strip — the top movers, dotted across the gap below the chips. */
function IdxTags({ bull, bear }: { bull: AssetRow[]; bear: AssetRow[] }) {
  const movers = useMemo(
    () => [...bull, ...bear].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 8),
    [bull, bear],
  );
  if (movers.length === 0) return null;
  return (
    <div className="st-idxtags" style={{ left: IDXTAGS.x, top: IDXTAGS.y, width: IDXTAGS.w }} aria-hidden>
      {movers.map((r) => (
        <span key={r.id} className={`tag ${r.changePct >= 0 ? 'up' : 'dn'}`}>
          <i className={`ld ${r.changePct >= 0 ? 'u' : 'd'}`} />
          <b>{r.base}</b>
          <em className="mono">{r.changePct >= 0 ? '+' : ''}{r.changePct.toFixed(2)}%</em>
        </span>
      ))}
    </div>
  );
}

function Ladder({ bull, bear }: { bull: AssetRow[]; bear: AssetRow[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const W = 118;
    const H = 1072;
    const dpr = 2;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const draw = (rows: AssetRow[], up: boolean) => {
      const max = Math.max(0.001, ...rows.map((r) => Math.abs(r.changePct)));
      rows.forEach((r, i) => {
        const frac = Math.abs(r.changePct) / max;
        const cx = 20 + (up ? 0 : W - 20);
        const cy = (up ? 20 : H - 20) + (up ? i : -i) * 26 + 13;
        const bw = Math.max(4, (W - 24) * Math.min(1, frac));
        const x0 = up ? cx : cx - bw;
        const y0 = cy - 5;
        ctx.beginPath();
        ctx.rect(x0, y0, bw, 10);
        ctx.fillStyle = up ? 'rgba(63,212,135,0.5)' : 'rgba(248,113,113,0.5)';
        ctx.globalAlpha = 0.22 + 0.6 * frac;
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    };
    draw(bull, true);
    draw(bear, false);
  }, [bull, bear]);

  return (
    <div className="st-ladder" style={{ left: LADDER_X, top: 92, height: 1072 }}>
      <canvas ref={ref} className="lcan" aria-hidden />
      {Array.from({ length: Math.min(BOARD_PER_SIDE, 20) }, (_, i) => (
        <span key={i} className={`rk ${i < 6 ? 'hot' : ''}`} style={{ top: 20 + i * 26, left: 24 }}>
          {String(i + 1).padStart(2, '0')}
        </span>
      ))}
      {Array.from({ length: Math.min(BOARD_PER_SIDE, 20) }, (_, i) => (
        <span key={`b${i}`} className={`rk bm ${i < 6 ? 'hot' : ''}`} style={{ top: 1072 - 20 - i * 26 - 14, right: 24 }}>
          {String(i + 1).padStart(2, '0')}
        </span>
      ))}
    </div>
  );
}

function Nodes({ total, bull, bear, picks }: { total: number; bull: number; bear: number; picks: number }) {
  return (
    <>
      <div className="st-nowglow" style={{ left: NOW_LINE.x, top: NOW_LINE.y, height: NOW_LINE.h }} aria-hidden />
      <div className="st-nowline" style={{ left: NOW_LINE.x, top: NOW_LINE.y, height: NOW_LINE.h }} aria-hidden />
      <div className="st-node beacon" style={{ left: NODE.beacon, top: 702.857 }} aria-label="source" title="source">
        <span className="ring" />
      </div>
      <div className="st-node now" style={{ left: NODE.now, top: 702.857 }} aria-label="now" title="now">
        <span className="dia" />
      </div>
      <div className="st-node gate" style={{ left: NODE.gate, top: 702.857 }} aria-label="gate" title="gate">
        <i />
      </div>
      <div className="st-node lens" style={{ left: NODE.lens, top: 596 }} aria-label="lens" title="lens">
        <i />
      </div>
      <div className="st-cnt universe" style={{ left: COUNT.universe.x, top: 694.857 }}>
        <span className="ld" aria-hidden />
        <b className="mono">{total}</b>
      </div>
      <div className="st-cnt board" style={{ left: 698, top: 694.857 }}>
        <span className="ld" aria-hidden />
        <b className="mono">{bull + bear}</b>
      </div>
      <div className="st-cnt picks" style={{ left: COUNT.picks.x, top: 590 }}>
        <span className="ld" aria-hidden />
        <b className="mono">{picks}</b>
      </div>
      <div className="st-node reactor" style={{ left: NODE.reactor, top: 590 }} aria-label="reactor" title="reactor">
        <span className="halo" aria-hidden />
        <svg className="rings" width={40} height={40} viewBox="0 0 40 40" aria-hidden>
          <circle className="r1" cx={20} cy={20} r={13} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="22 14" />
          <circle className="r2" cx={20} cy={20} r={17} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="6 8" />
        </svg>
        <span className="core" aria-hidden />
      </div>
      <div className="st-gwin top" style={{ left: 593, top: 104 }}>
        {gmotes()}
      </div>
      <div className="st-gwin bot" style={{ left: 593, top: 1052.19 }}>
        {gmotes()}
      </div>
    </>
  );
}

function gmotes() {
  return Array.from({ length: 9 }, (_, i) => {
    const css = {
      '--dx': `${-80 + ((i * 53) % 160)}px`,
      '--dy': `${-50 + ((i * 41) % 100)}px`,
      '--md': `${(0.9 + (i % 4) * 0.4).toFixed(2)}s`,
      '--mdl': `${(0.15 + (i % 5) * 0.23).toFixed(2)}s`,
      '--mo': `${(0.05 + (i % 4) * 0.1).toFixed(2)}`,
      '--mc': i % 2 === 0 ? '63,212,135' : '248,113,113',
    } as CSSProperties;
    return <i key={i} className="gmote" style={css} />;
  });
}

interface BoardProps {
  bull: AssetRow[];
  bear: AssetRow[];
  prices?: LivePriceMap;
  selected: string | null;
  onSelect: (symbol: string) => void;
}

function Tiles({ bull, bear, prices, selected, onSelect }: BoardProps) {
  const renderSide = (rows: AssetRow[], wrapOffset: number) => {
    const els: JSX.Element[] = [];
    rows.forEach((r) => {
      const lane = LANES.find((l) => l.key === slotKey(r.rank)) ?? LANES[0];
      const slot = lane.slots[Math.min(slotIndex(r.rank), lane.slots.length - 1)];
      const bullTile = r.side === 'bullish';
      const rgb = bullTile ? '63,212,135' : '248,113,113';
      const color = bullTile ? '#3FD487' : '#F87171';
      const live = liveFor(r, prices);
      const chg = live?.changePct ?? r.changePct;
      const pick = r.isPick && lane.key === 'c1';
      const depth = lane.key.slice(1);
      els.push(
        <div
          key={r.id}
          style={{ position: 'absolute', left: lane.x - 810, top: wrapOffset + slot.y, width: lane.w, height: slot.h }}
        >
          <button
            type="button"
            className={`st-tile ${bullTile ? 'bull' : 'bear'} ${pick ? 'pick' : ''} ${selected === r.base ? 'sel' : ''} c${depth}`}
            style={{ '--sc': rgb, top: 0, left: 0, width: '100%', height: '100%' } as CSSProperties}
            onClick={() => onSelect(r.base)}
            aria-label={r.base}
          >
            <TileChart row={r} width={lane.w} height={slot.h} color={color} />
            <div className={`plate ${pick ? 'pick' : ''}`}>
              {pick ? (
                <>
                  <div className="row1">
                    <span className="mg">{r.base.slice(0, 2).toUpperCase()}</span>
                    <span className="tw">
                      <span className="tkr">{r.base}</span>
                      <span className={`pc ${chg >= 0 ? 'pos' : 'neg'}`}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>
                    </span>
                  </div>
                  <div className="sub">
                    <span className="buc">{bullTile ? 'LONG BUILD-UP' : 'SHORT BUILD-UP'}</span>
                    <span className="pips">
                      <GradePips n={pipsFor(r)} color={color} size={3} />
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <span className="tkr">{r.base}</span>
                  <span className={`pc ${chg >= 0 ? 'pos' : 'neg'}`}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>
                </>
              )}
            </div>
            <span className="rk mono">{r.rank}</span>
            <span className="br tl" />
            <span className="br tr" />
            <span className="br bl" />
            <span className="br brr" />
            {pick && <span className="latch" aria-hidden />}
          </button>
        </div>,
      );
      if (pick) els.push(<RetGlow key={`${r.id}-ret`} i={slotIndex(r.rank)} side={r.side} />);
    });
    return els;
  };

  return (
    <div className="st-tiles">
      {renderSide(bull, 0)}
      {renderSide(bear, BEAR_Y_OFFSET)}
    </div>
  );
}

function slotKey(rank: number): 'c1' | 'c2' | 'c3' | 'c4' {
  if (rank <= 3) return 'c1';
  if (rank <= 7) return 'c2';
  if (rank <= 12) return 'c3';
  return 'c4';
}

function RetGlow({ i, side }: { i: number; side: AssetRow['side'] }) {
  const g = (side === 'bullish' ? RET.bull : RET.bear)[i];
  if (!g) return null;
  return (
    <div className={`st-ret ${side === 'bullish' ? 'bull' : 'bear'}`} style={{ left: RET.x - 810, top: g.y, width: RET.w, height: g.h }} aria-hidden>
      <i />
      <i />
      <i />
      <i />
    </div>
  );
}

/** Per-tile canvas: the spark line + zone level, sized by the tile box. */
function TileChart({ row, width, height, color }: { row: AssetRow; width: number; height: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [dw, dh] = [Math.max(1, width - 6), Math.max(1, height - 6)];
  useEffect(() => {
    const cv = ref.current;
    if (!cv || row.spark.length < 2) return;
    const dpr = 2;
    cv.width = Math.max(1, Math.round(dw * dpr));
    cv.height = Math.max(1, Math.round(dh * dpr));
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, dw, dh);
    const s = row.setup;
    const vals = [...row.spark];
    if (s) vals.push(s.z, s.invalidation, s.obLow, s.obHigh, ...s.targets.slice(0, 2).map((t) => t.price));
    let min = Infinity;
    let max = -Infinity;
    for (const v of vals) {
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min)) return;
    const pad = (max - min) * 0.14 || 1;
    min -= pad;
    max += pad;
    const span = max - min || 1;
    const X = (i: number) => (i / (row.spark.length - 1)) * dw;
    const Y = (v: number) => dh - ((v - min) / span) * (dh - 4) - 2;
    ctx.beginPath();
    row.spark.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.lineTo(dw, dh);
    ctx.lineTo(0, dh);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    row.spark.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (s) {
      ctx.beginPath();
      ctx.moveTo(0, Y(s.z));
      ctx.lineTo(dw, Y(s.z));
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }, [row, dw, dh, color]);
  return <canvas ref={ref} className="tcv" style={{ position: 'absolute', left: 3, top: 3, width: dw, height: dh }} aria-hidden />;
}

function Bridges({ bull, bear, onSelect }: { bull: AssetRow[]; bear: AssetRow[]; onSelect: (symbol: string) => void }) {
  const sides = [
    { side: 'bullish' as const, list: bull, offset: 0 },
    { side: 'bearish' as const, list: bear, offset: BEAR_Y_OFFSET },
  ];
  return (
    <div className="st-bridges">
      {sides.map(({ side, list, offset }) => {
        const rgb = side === 'bullish' ? '63,212,135' : '248,113,113';
        return list.slice(0, 3).map((r, i) => (
          <div
            key={r.id}
            className={`st-bridge ${side === 'bullish' ? 'bull' : 'bear'}`}
            style={{ top: (side === 'bullish' ? BRIDGE_TOPS.bull[i] : BRIDGE_TOPS.bear[i]) - 20 + offset, height: 110, '--sc': rgb } as CSSProperties}
            onClick={() => onSelect(r.base)}
            aria-label={r.base}
            data-k={r.base}
          />
        ));
      })}
    </div>
  );
}

function Tickets({ bull, bear, prices, selected, onSelect }: BoardProps) {
  const hHero = 230;
  const hStd = 164;
  const hStd3 = 156;
  const gap = 6;

  const renderSide = (rows: AssetRow[], offset: number) => {
    let y = offset;
    return rows.slice(0, 3).map((r, i) => {
      const h = i === 0 ? hHero : i === 1 ? hStd : hStd3;
      const el = (
        <div key={r.id} style={{ position: 'absolute', left: 0, width: TICKETS_W, top: y, paddingBottom: gap }}>
          <Ticket row={r} rank={r.rank} hero={i === 0} height={h} prices={prices} onSelect={onSelect} selected={selected} />
        </div>
      );
      y += h + gap;
      return el;
    });
  };

  return (
    <div className="st-tickets">
      {renderSide(bull, 20)}
      {renderSide(bear, BEAR_Y_OFFSET + 20)}
    </div>
  );
}

function Footer({ updatedAt, regime }: { updatedAt: number; regime: string }) {
  return (
    <div className="st-footer">
      <span>OrderFlow · order block scan</span>
      <span className="mono">regime {regime.replace(/_/g, ' ')}</span>
      <span className="mono">{istStamp(updatedAt)} IST</span>
      <span className="spacer" style={{ flex: 1 }} />
      <span className="warn">research tool — not investment advice</span>
    </div>
  );
}