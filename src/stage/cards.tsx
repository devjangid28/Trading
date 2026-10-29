import type { AssetRow, Side } from '../../shared/types';
import { fmtPct, fmtPrice } from '../lib/format';
import { livePrice } from '../lib/priceStore';
import { ObSpark, GradePips } from './charts';
import { DepthStrip, DetailChart, MicroBar, ProfileHist, Ring } from './FlowCharts';
import { buildUp, buildUpShort, buildUpTone, flowScore, ladder, type Ladder } from './flowData';

const TONE: Record<Side, { color: string; pill: string }> = {
  bullish: { color: '#3fd487', pill: 'BULL' },
  bearish: { color: '#f87171', pill: 'BEAR' },
};

function px(row: AssetRow): number {
  return livePrice(`${row.base}USDT`)?.price ?? livePrice(row.base)?.price ?? row.price;
}
function chg(row: AssetRow): number {
  return livePrice(`${row.base}USDT`)?.changePct ?? livePrice(row.base)?.changePct ?? row.changePct;
}

function digits(price: number): number {
  if (price >= 1) return 2;
  if (price >= 0.01) return 4;
  return 6;
}
function fmtLvl(price: number, v: number | null): string {
  if (v === null) return '—';
  return v.toFixed(digits(price));
}

function TickerIcon({ row, size = 18 }: { row: AssetRow; size?: number }) {
  const tone = TONE[row.side];
  if (row.logoUrl) {
    return (
      <span className="ob-icon" style={{ width: size, height: size, borderColor: tone.color }}>
        <img src={row.logoUrl} alt="" width={Math.round(size * 0.72)} height={Math.round(size * 0.72)} loading="lazy" decoding="async" />
      </span>
    );
  }
  return (
    <span className="ob-icon mono" style={{ width: size, height: size, borderColor: tone.color, color: tone.color, fontSize: Math.round(size * 0.42) }}>
      {row.base.slice(0, 3)}
    </span>
  );
}

/** One ranked row in the left source panel, with its right-edge river anchor. */
export function SourceRow({
  row,
  active,
  dim,
  onHover,
  onSelect,
}: {
  row: AssetRow;
  active: boolean;
  dim: boolean;
  onHover: (sym: string | null) => void;
  onSelect: (sym: string) => void;
}) {
  const side = row.side;
  const c = chg(row);
  return (
    <button
      type="button"
      data-anchor={`src:${row.base}`}
      data-anchor-side="right"
      className={`ob-srcrow ${side}${active ? ' active' : ''}${dim ? ' dim' : ''}`}
      onMouseEnter={() => onHover(row.base)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(row.base)}
      onBlur={() => onHover(null)}
      onClick={() => onSelect(row.base)}
    >
      <span className="rk mono">{String(row.rank).padStart(2, '0')}</span>
      <span className="tk">{row.displayTicker || row.base}</span>
      <span className="chg mono">{fmtPct(c)}</span>
    </button>
  );
}

export function MiniCard({
  row,
  kind,
  frac,
  active,
  dim,
  onHover,
  onSelect,
}: {
  row: AssetRow;
  kind: 'tiny' | 'small' | 'medium' | 'tall';
  frac: number;
  active: boolean;
  dim: boolean;
  onHover: (sym: string | null) => void;
  onSelect: (sym: string) => void;
}) {
  const side = row.side;
  const c = chg(row);
  const tone = TONE[side];
  const bu = buildUp(row);
  const buTone = buildUpTone(bu);
  const className = `ob-tile ${side} ${kind}${active ? ' active' : ''}${dim ? ' dim' : ''}`;
  const handlers = {
    onMouseEnter: () => onHover(row.base),
    onMouseLeave: () => onHover(null),
    onFocus: () => onHover(row.base),
    onBlur: () => onHover(null),
    onClick: () => onSelect(row.base),
  };

  if (kind === 'tiny') {
    return (
      <button type="button" data-anchor={`tile:${row.base}`} data-anchor-side="left" className={className} {...handlers}>
        <span className="ob-tile-row">
          <span className="rk mono">#{String(row.rank).padStart(2, '0')}</span>
          <span className="tk">{row.displayTicker || row.base}</span>
          <span className="chg mono">{fmtPct(c)}</span>
        </span>
        <span className="ob-tile-spark">
          <ObSpark row={row} width={62} height={16} showLadder={false} />
        </span>
      </button>
    );
  }

  if (kind === 'small') {
    return (
      <button type="button" data-anchor={`tile:${row.base}`} data-anchor-side="left" className={className} {...handlers}>
        <span className="ob-tile-row">
          <span className="tk">{row.displayTicker || row.base}</span>
          <span className="chg mono">{fmtPct(c)}</span>
        </span>
        <span className="ob-tile-bar">
          <MicroBar frac={frac} side={side} width={88} height={5} />
        </span>
        <span className="ob-tile-depth" title="Binance futures book — bids left, asks right">
          <DepthStrip row={row} width={88} height={12} />
        </span>
      </button>
    );
  }

  if (kind === 'medium') {
    return (
      <button type="button" data-anchor={`tile:${row.base}`} data-anchor-side="left" className={className} {...handlers}>
        <span className="ob-tile-row">
          <span className="tk">{row.displayTicker || row.base}</span>
          <span className="chg mono">{fmtPct(c)}</span>
        </span>
        <span className={`ob-badge ${buTone}`}>{buildUpShort(bu)} BUILD-UP</span>
        <span className="ob-tile-pips">
          <GradePips n={Math.max(1, Math.round(flowScore(row) / 20))} color={tone.color} size={3} />
        </span>
        <span className="ob-tile-hist">
          <ProfileHist row={row} width={102} height={26} side={side} />
        </span>
      </button>
    );
  }

  return (
    <button type="button" data-anchor={`tile:${row.base}`} data-anchor-side="left" className={className} {...handlers}>
      <span className="ob-corner tl" aria-hidden />
      <span className="ob-corner tr" aria-hidden />
      <span className="ob-corner bl" aria-hidden />
      <span className="ob-corner br" aria-hidden />
      <span className="ob-tile-row">
        <TickerIcon row={row} size={18} />
        <span className="tk">{row.displayTicker || row.base}</span>
        <span className="chg mono">{fmtPct(c)}</span>
      </span>
      <span className={`ob-badge ${buTone}`}>{buildUpShort(bu)}</span>
      <span className="ob-tile-hist" title="Futures book depth by price (falls back to path profile)">
        <ProfileHist row={row} width={140} height={40} side={side} />
      </span>
      <span className="ob-tile-foot mono">rr {row.setup && row.setup.rr > 0 ? row.setup.rr.toFixed(1) : '—'}</span>
      <span data-anchor={`tileR:${row.base}`} data-anchor-side="right" className="ob-anchor-right" aria-hidden />
    </button>
  );
}

export function DetailCard({
  row,
  position,
  active,
  dim,
  onHover,
  onSelect,
  chartH: chartHProp,
}: {
  row: AssetRow;
  position: number;
  active: boolean;
  dim: boolean;
  onHover: (sym: string | null) => void;
  onSelect: (sym: string) => void;
  chartH?: number;
}) {
  const side = row.side;
  const tone = TONE[side];
  const price = px(row);
  const c = chg(row);
  const score = flowScore(row);
  const l: Ladder = ladder(row, price);
  const bu = buildUp(row);
  const buTone = buildUpTone(bu);
  const hero = position === 1;
  const chartW = 448;
  const chartH = chartHProp ?? (hero ? 104 : 76);

  const lo = l.s1;
  const hi = l.r1;
  let prog = 0.5;
  if (lo !== null && hi !== null && hi > lo) prog = Math.max(0, Math.min(1, (price - lo) / (hi - lo)));
  const gradient = side === 'bullish'
    ? 'linear-gradient(90deg,#fbbf24,#3fd487)'
    : 'linear-gradient(90deg,#3fd487,#fbbf24,#f87171)';

  return (
    <button
      type="button"
      data-anchor={`detail:${row.base}`}
      data-anchor-side="left"
      className={`ob-detail ${side}${active ? ' active' : ''}${dim ? ' dim' : ''}`}
      onMouseEnter={() => onHover(row.base)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(row.base)}
      onBlur={() => onHover(null)}
      onClick={() => onSelect(row.base)}
    >
      <div className="ob-detail-hdr">
        <span className="ob-detail-rank mono">{position}</span>
        <span className="ob-detail-ttl">
          <span className="ob-detail-nm">{row.displayTicker || row.base}</span>
          <span className="ob-detail-name">{row.displayName || row.name}</span>
        </span>
        <span className={`ob-pill ${side}`}>{tone.pill}</span>
        <span className="ob-detail-quote">
          <span className="ob-detail-price mono">${fmtPrice(price)}</span>
          <span className={`ob-detail-chg mono ${c >= 0 ? 'pos' : 'neg'}`}>{fmtPct(c)}</span>
        </span>
        <span className="ob-detail-ring">
          <Ring score={score} size={38} />
        </span>
      </div>

      <div className="ob-detail-chart">
        <DetailChart row={row} price={price} width={chartW} height={chartH} />
      </div>

      <div className="ob-detail-meta">
        <span className={`ob-badge ${buTone} sm`}>{bu}</span>
        <span className="ob-detail-oi mono">
          OI 1h{' '}
          {row.derivatives?.oiChange.h1 === undefined ? '—' : `${row.derivatives.oiChange.h1 >= 0 ? '+' : ''}${row.derivatives.oiChange.h1.toFixed(2)}%`}
        </span>
        <span className="ob-detail-q mono">{row.derivatives?.quadrantLabel ?? '—'}</span>
      </div>

      <div className="ob-detail-foot">
        <span className="cell">
          <em>S1</em>
          <b className="mono">{fmtLvl(price, l.s1)}</b>
        </span>
        <span className="cell">
          <em>ZONE</em>
          <b className="mono z">{l.zoneLow !== null && l.zoneHigh !== null ? `${fmtLvl(price, l.zoneLow)}–${fmtLvl(price, l.zoneHigh)}` : '—'}</b>
        </span>
        <span className="cell">
          <em>R1</em>
          <b className="mono">{fmtLvl(price, l.r1)}</b>
        </span>
        <span className="cell">
          <em>R2</em>
          <b className="mono">{fmtLvl(price, l.r2)}</b>
        </span>
        <span className="cell">
          <em>RISK</em>
          <b className="mono">{l.riskPct === null ? '—' : `${l.riskPct.toFixed(2)}%`}</b>
        </span>
        <span className="cell">
          <em>R:R</em>
          <b className="mono">{l.rr > 0 ? l.rr.toFixed(1) : '—'}</b>
        </span>
      </div>

      <div className="ob-prog" title="Price position between S1 and R1">
        <span className="ob-prog-bar" style={{ background: gradient }} />
        <span className="ob-prog-marker" style={{ left: `${prog * 100}%` }} />
      </div>
    </button>
  );
}
