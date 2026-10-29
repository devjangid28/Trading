import { useMemo } from 'react';
import type { AssetRow, ChecklistTick } from '../../shared/types';
import { fmtPct, fmtPrice } from '../lib/format';
import { useAssetDetail } from '../lib/api';
import { useLivePrice } from '../lib/priceStore';
import type { LivePrice } from '../lib/liveContext';
import { CandleChart } from './CandleChart';

const UP = '#16a34a';
const DOWN = '#dc2626';

interface Props {
  row: AssetRow;
  live?: LivePrice;
  onClose: () => void;
  type?: 'hero' | 'standard';
}

export function TicketPanel({ row, live, onClose, type = 'standard' }: Props) {
  // Read the live price for this ticket's own symbol from the external store,
  // so the ticket stays current without the app passing a prices map down.
  const storeLive = useLivePrice(`${row.base}USDT`);
  const px = storeLive ?? live;
  const setup = row.setup;
  const bullish = row.side === 'bullish';
  const color = bullish ? UP : DOWN;
  const isHero = type === 'hero';

  /**
   * Real candles, from the same endpoint the detail popup uses.
   *
   * This component used to draw "candles" synthesised from `row.spark` ΓÇö a
   * close-only series turned into open = previous close and high/low = the
   * envelope of two closes. Those wicks never happened in the market, so the
   * chart was showing invented numbers. It now reads real OHLC, and while it
   * loads or when it fails it says so, rather than drawing something plausible.
   *
   * Every hook runs before the `!setup` early return below. A ticket opened on
   * a row with no setup renders null, and the next row may have one; returning
   * early above a hook would change the hook count between renders and take
   * React down with it.
   */
  const detail = useAssetDetail(row.id);

  const alignment = useMemo(() => {
    const checks: ChecklistTick[] = [
      {
        key: 'rank',
        label: 'Rank within side',
        ok: row.rank <= 3,
        reason: row.rank <= 3 ? 'Top 3' : `Rank #${row.rank}`,
      },
      {
        key: 'sector',
        label: 'Sector not capped',
        ok: !row.conviction?.checklist.some((c) => c.key === 'sector' && !c.ok),
        reason: 'Sector pick limit not reached',
      },
      {
        key: 'breadth',
        label: 'Breadth aligned',
        ok: row.side === 'bullish' || row.side === 'bearish',
        reason: 'Market breadth favors this side',
      },
      {
        key: 'vwap',
        label: 'VWAP aligned',
        ok: row.vwap !== null ? (bullish ? row.price >= row.vwap : row.price <= row.vwap) : true,
        reason: row.vwap !== null ? (bullish ? 'Price above VWAP' : 'Price below VWAP') : 'VWAP unavailable',
      },
    ];
    return checks;
  }, [row, setup]);

  if (!setup) return null;

  const score = row.conviction?.score ?? null;
  const grade = row.conviction?.grade ?? null;
  const oi1h = row.derivatives?.oiChange.h1 ?? null;
  const riskPct = setup ? (Math.abs(setup.z - setup.invalidation) / setup.z) * 100 : null;

  const ring = score !== null ? (
    <svg className="conv-ring" width={44} height={44} viewBox="0 0 44 44">
      <circle cx={22} cy={22} r={18} fill="none" stroke="var(--border)" strokeWidth={3.5} />
      <circle
        cx={22}
        cy={22}
        r={18}
        fill="none"
        stroke={color}
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeDasharray={`${2 * Math.PI * 18}`}
        strokeDashoffset={`${2 * Math.PI * 18 * (1 - Math.min(100, score) / 100)}`}
        transform="rotate(-90 22 22)"
      />
      <text x={22} y={26} textAnchor="middle" fontSize={12} fontWeight={700} fill="var(--text)" className="mono">
        {Math.round(score)}
      </text>
    </svg>
  ) : null;

  const planCells = [
    { label: bullish ? 'S1' : 'R1', value: fmtPrice(setup.invalidation), desc: 'Invalidation', accent: bullish ? DOWN : UP },
    { label: 'ZONE', value: fmtPrice(setup.z), desc: 'Zone anchor', accent: color },
    ...setup.targets.slice(0, 2).map((t) => ({
      label: t.label,
      value: fmtPrice(t.price),
      desc: t.kind === 'liquidity' ? 'Liquidity pool' : 'Structure level',
      accent: '#2563eb',
    })),
    {
      label: 'RISK',
      value: riskPct !== null ? `${riskPct.toFixed(1)}%` : '—',
      desc: `from Z to ${bullish ? 'S1' : 'R1'}`,
      accent: 'var(--muted)',
    },
    {
      label: 'R:R',
      value: setup.rr > 0 ? `1:${setup.rr.toFixed(1)}` : '—',
      desc: setup.rr > 0 ? 'to liquidity' : 'no target',
      accent: setup.rr >= 2 ? UP : 'var(--muted)',
    },
  ];

  return (
    <div className={`ticket-panel ${isHero ? 'hero' : 'standard'}`} role="dialog" aria-label={`${row.base} ticket`} data-bridge-ticket={row.base}>
      <button className="ticket-close" onClick={onClose} aria-label="Close ticket">×</button>

      <div className="ticket-top">
        <div className="ticket-badge" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
          {bullish ? '▲' : '▼'} {row.base} #{row.rank}
        </div>
        {ring}
      </div>
      <div className="ticket-header">
        <div className="ticket-title">
          <h3>{row.name}</h3>
          <span className="ticket-sector">{row.sector}</span>
        </div>
        <div className="ticket-price">
          <span className="mono ticket-current">{fmtPrice(px?.price ?? row.price)}</span>
          <span className={`mono ticket-change ${(px?.changePct ?? row.changePct) >= 0 ? 'up' : 'down'}`}>
            {fmtPct(px?.changePct ?? row.changePct)}
          </span>
          {row.vwap && (
            <span className="ticket-vwap mono" style={{ color: '#eab308' }}>
              VWAP {fmtPrice(row.vwap)}
            </span>
          )}
          {oi1h !== null && (
            <span className={`ticket-oi mono ${oi1h >= 0 ? 'up' : 'down'}`} title="Perp open interest, last hour">
              OI {oi1h >= 0 ? '+' : ''}{oi1h.toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      <div className="ticket-chart" data-testid="ticket-chart">
        {detail.loading && !detail.data && (
          <div className="ticket-chart-note" data-testid="ticket-chart-loading">
            Loading 5m candlesΓÇª
          </div>
        )}
        {!detail.loading && detail.error && (
          <div className="ticket-chart-note" data-testid="ticket-chart-error">
            Chart unavailable ΓÇö {detail.error}
          </div>
        )}
        {detail.data && detail.data.candles.length > 0 && (
          <CandleChart
            candles={detail.data.candles}
            setup={setup}
            vwap={row.vwap}
            height={isHero ? 200 : 150}
            maxCandles={isHero ? 90 : 50}
            showPrevious={false}
            showContext={false}
          />
        )}
      </div>

      <div className="ticket-plan">
        {planCells.map((c) => (
          <div key={c.label} className="plan-cell" style={{ borderLeftColor: c.accent }}>
            <span className="plan-label">{c.label}</span>
            <span className="plan-value mono">{c.value}</span>
            <span className="plan-desc">{c.desc}</span>
          </div>
        ))}
      </div>

      {grade && <div className="ticket-grade" style={{ color }}>Grade {grade}</div>}

      <div className="ticket-alignment">
        <div className="alignment-title">Alignment check</div>
        <div className="alignment-grid">
          {alignment.map((c) => (
            <div key={c.key} className={`alignment-item ${c.ok ? 'pass' : 'fail'}`}>
              <span className="alignment-icon">{c.ok ? '✓' : '✗'}</span>
              <span className="alignment-label">{c.label}</span>
              <span className="alignment-reason">{c.reason}</span>
            </div>
          ))}
        </div>
        <div className="alignment-score">
          {alignment.filter((c) => c.ok).length}/4 aligned
        </div>
      </div>

      <div className="ticket-proof">
        <div className="proof-title">Proof</div>
        <div className="proof-grid">
          <div className="proof-item">
            <span className="proof-label">Displacement</span>
            <span className="proof-value mono">{setup.displacement.toFixed(1)}× ATR</span>
          </div>
          <div className="proof-item">
            <span className="proof-label">{setup.fvg ? 'FVG' : 'Structure break'}</span>
            <span className="proof-value mono">{setup.fvg ? 'Fair-value gap' : 'Close beyond swing'}</span>
          </div>
          <div className="proof-item">
            <span className="proof-label">Violated</span>
            <span className="proof-value mono" style={{ color: setup.violated ? DOWN : UP }}>
              {setup.violated ? 'Yes' : 'No'}
            </span>
          </div>
          <div className="proof-item">
            <span className="proof-label">Age</span>
            <span className="proof-value mono">{setup.ageMinutes}m</span>
          </div>
        </div>
      </div>

      {row.conviction && (
        <div className="ticket-conviction">
          <div className="conviction-title">Conviction</div>
          <div className="conviction-score" style={{ color }}>
            {row.conviction.score.toFixed(0)} / 100 — Grade {row.conviction.grade}
          </div>
          <div className="conviction-components">
            {Object.entries(row.conviction.components).map(([k, v]) => (
              <div key={k} className="conviction-comp">
                <span className="comp-name">{k}</span>
                <span className="comp-value mono" style={{ color: v === null ? 'var(--faint)' : v >= 70 ? UP : v >= 40 ? '#eab308' : DOWN }}>
                  {v === null ? '—' : v.toFixed(0)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}