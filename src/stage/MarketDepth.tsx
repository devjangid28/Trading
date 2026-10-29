import { useMemo } from 'react';
import type { AssetRow, ScanResult } from '../../shared/types';
import { fmtPct, istStamp } from '../lib/format';
import { ObSpark, GradePips, liveFor } from './charts';
import type { LivePriceMap } from './types';

/**
 * Market-depth section — clone of order-block.com's #mh block.
 * Left: the butterfly split (bullish pool vs bearish pool). Right: the pick lists.
 */
export function MarketDepth({
  data,
  prices,
  onSelect,
  selected,
}: {
  data: ScanResult;
  prices?: LivePriceMap;
  onSelect: (symbol: string) => void;
  selected: string | null;
}) {
  const b = data.butterfly;
  const bullPicks = data.bullish.slice(0, 3);
  const bearPicks = data.bearish.slice(0, 3);

  const maxCount = useMemo(() => Math.max(1, ...b.buckets.map((k) => Math.max(k.bullish, k.bearish))), [b]);

  const bullPct = b.bullish + b.bearish > 0 ? (b.bullish / (b.bullish + b.bearish)) * 100 : 50;
  const bearPct = 100 - bullPct;

  return (
    <section className="mh">
      <div className="mh-top">
        <div className="cell">
          <span className="dot green" />
          <span className="t">ORDER BLOCK SCAN</span>
          <span className="sep" />
          <span className="sub">market depth as of {b.n} pairs</span>
        </div>
        <div className="cell right">
          <span className="t">as of</span>
          <b className="z mono">{istStamp(data.updatedAt)} IST</b>
          <span className="sep" />
          <span className="sub">5m closed candles</span>
        </div>
      </div>

      <div className="mh-body">
        <div className="dp-wrap">
          <div className="dp-head">
            <div className="side bull">
              <i />
              BULL <b className="mono">{b.bullish}</b>
              <em className="mono">{bullPct.toFixed(1)}%</em>
            </div>
            <div className="spine-label">move %</div>
            <div className="side bear">
              <i />
              BEAR <b className="mono">{b.bearish}</b>
              <em className="mono">{bearPct.toFixed(1)}%</em>
            </div>
          </div>

          <svg className="dp" viewBox="0 0 640 220" preserveAspectRatio="none" style={{ width: '100%', height: 148, display: 'block' }}>
            <line x1={320} y1={8} x2={320} y2={196} stroke="#11151B" strokeWidth={1} />
            {b.buckets.map((k, idx) => {
              const slot = b.buckets.length;
              const top = 8 + (idx * 176) / slot;
              const h = Math.max(3, 176 / slot - 2.5);
              const wBull = (k.bullish / maxCount) * 290;
              const wBear = (k.bearish / maxCount) * 290;
              const label = Math.abs(k.to ?? k.from ?? 0);
              return (
                <g key={`${k.from}-${k.to}-${idx}`}>
                  {wBull > 0 && (
                    <rect x={320 - wBull} y={top} width={wBull} height={h} rx={1.5} fill="rgba(63,212,135,0.55)" />
                  )}
                  {wBear > 0 && (
                    <rect x={320} y={top} width={wBear} height={h} rx={1.5} fill="rgba(248,113,113,0.55)" />
                  )}
                  <line x1={320} y1={top + h / 2} x2={640} y2={top + h / 2} stroke="rgba(255,255,255,0.04)" />
                  <text x={320 + (wBear > 0 ? wBear + 6 : 6)} y={top + h / 2 + 3} fontSize={10} fill="#78828F" fontFamily="JetBrains Mono,monospace">
                    +{label}%
                  </text>
                  <text x={320 - (wBull > 0 ? wBull + 6 : 6)} y={top + h / 2 + 3} fontSize={10} fill="#78828F" textAnchor="end" fontFamily="JetBrains Mono,monospace">
                    -{label}%
                  </text>
                  <text x={322} y={top + h / 2 + 3} fontSize={9.5} fill="#9AA5B5" fontFamily="JetBrains Mono,monospace">
                    {k.total}
                  </text>
                </g>
              );
            })}
            <text x={320} y={212} fontSize={10} fill="#4A5465" textAnchor="middle" fontFamily="JetBrains Mono,monospace">
              spine · count of pairs per % move
            </text>
          </svg>
        </div>

        <div className="mh-picks">
          <PickList title="BULLISH" side="bullish" rows={bullPicks} prices={prices} onSelect={onSelect} selected={selected} />
          <PickList title="BEARISH" side="bearish" rows={bearPicks} prices={prices} onSelect={onSelect} selected={selected} />
        </div>
      </div>
    </section>
  );
}

function PickList({
  title,
  side,
  rows,
  prices,
  onSelect,
  selected,
}: {
  title: string;
  side: 'bullish' | 'bearish';
  rows: AssetRow[];
  prices?: LivePriceMap;
  onSelect: (symbol: string) => void;
  selected: string | null;
}) {
  const color = side === 'bullish' ? '#3FD487' : '#F87171';
  return (
    <div className={`pk-col ${side}`}>
      <div className="pk-head">
        <i style={{ background: color }} />
        {title}
        <span className="mono">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="pk-empty">no setups on this side</div>
      ) : (
        rows.map((r, i) => {
          const live = liveFor(r, prices);
          const sec = r.sector && r.sector.length > 0 ? r.sector : r.name;
          return (
            <button
              key={r.id}
              type="button"
              className={`pk ${side} ${selected === r.base ? 'sel' : ''}`}
              onClick={() => onSelect(r.base)}
            >
              <div className="lg" style={{ borderColor: color, color }}>
                {i + 1}
              </div>
              <div className="nm">
                <div className="row1">
                  <span className="nm-t">{r.base}</span>
                  <span className="pill" style={{ color, background: `${color}22` }}>{side === 'bullish' ? 'BULL' : 'BEAR'}</span>
                  <GradePips n={pipsFor(r)} color={color} size={4} />
                </div>
                <div className="sec">{r.name} · {sec}</div>
              </div>
              <div className="pk-ch">
                <ObSpark row={r} width={86} height={30} showLadder={false} />
              </div>
              <div className="pc">
                <div className="px" style={{ color }}>{fmtPct(live?.changePct ?? r.changePct)}</div>
                <div className="pr mono">${r.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div>
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}

export function pipsFor(r: AssetRow): number {
  const g = r.conviction?.grade ?? 'C';
  if (g === 'A') return 5;
  if (g === 'B') return 4;
  if (g === 'C') return 3;
  return 2;
}