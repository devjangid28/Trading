import type { AssetRow } from '../../shared/types';
import { fmtPct, fmtPrice } from '../lib/format';
import type { LivePrice } from '../lib/liveContext';

interface Props {
  rows: AssetRow[];
  prices?: Record<string, LivePrice>;
}

/**
 * A slow auto-scrolling ticker of the day's strongest absolute movers — the
 * `#idxTags` row of the reference stage. Pauses on hover.
 */
export function TickerStrip({ rows, prices }: Props) {
  const movers = rows
    .slice()
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 14);

  if (movers.length === 0) return null;

  const item = (r: AssetRow) => {
    const live = prices?.[`${r.base}USDT`];
    const chg = live?.changePct ?? r.changePct;
    const up = chg >= 0;
    return (
      <span key={r.id} className="ticker-item">
        <b>{r.base}</b>
        <span className="mono ticker-px">{fmtPrice(live?.price ?? r.price)}</span>
        <span className={`mono ticker-ch ${up ? 'up' : 'down'}`}>{fmtPct(chg)}</span>
      </span>
    );
  };

  return (
    <div className="ticker-strip">
      <div className="ticker-track">
        {movers.map(item)}
        {movers.map(item)}
      </div>
    </div>
  );
}