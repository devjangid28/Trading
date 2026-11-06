import { fmtPrice, fmtUsd } from '../lib/format';
import { fmtDeltaBtc, istSpanShort } from './format';
import type { Profile } from './types';

interface MiniHistProps {
  rows: Profile['rows'];
  max: number;
  pocPrice: number;
}

function MiniHist({ rows, max, pocPrice }: MiniHistProps) {
  const shown = rows.slice(0, 48);
  const barH = Math.max(1, (60 - shown.length) / shown.length);
  return (
    <div className="vp-minihist" aria-hidden="true">
      {shown.map((r) => (
        <div
          key={r.index}
          className={`vp-minihist-bar${r.price === pocPrice ? ' is-poc' : ''}`}
          style={{ height: barH, width: `${Math.max(1, (r.vol / Math.max(1e-9, max)) * 100)}%` }}
        />
      ))}
    </div>
  );
}

interface RightPaneProps {
  profiles: Profile[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (p: Profile | null) => void;
  empty: boolean;
}

export function RightPane({ profiles, selectedId, onSelect, onHover, empty }: RightPaneProps) {
  if (empty) {
    return (
      <aside className="vp-pane" aria-label="Profiles list">
        <div className="vp-pane-empty">no range yet</div>
      </aside>
    );
  }
  return (
    <aside className="vp-pane" aria-label="Profiles list">
      <div className="vp-pane-list">
        {profiles.map((p) => {
          const sel = selectedId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              className={`vp-card${sel ? ' is-sel' : ''}`}
              aria-pressed={sel}
              onClick={() => onSelect(sel ? null : p.id)}
              onMouseEnter={() => onHover(p)}
              onMouseLeave={() => onHover(null)}
            >
              <div className="vp-card-span">{istSpanShort(p.t0, p.t1)}</div>
              <div className="vp-card-row"><span>POC</span><b>{fmtPrice(p.pocPrice)}</b></div>
              <div className="vp-card-row"><span>VAH / VAL</span><b>{fmtPrice(p.vah)} / {fmtPrice(p.val)}</b></div>
              <div className="vp-card-row"><span>Volume</span><b>{p.totalBase.toFixed(2)} BTC · {fmtUsd(p.totalUsd)}</b></div>
              <div className="vp-card-row"><span>Delta</span><b className={p.totalDelta >= 0 ? 'is-up' : 'is-down'}>{fmtDeltaBtc(p.totalDelta)} BTC</b></div>
              <MiniHist rows={p.rows} max={p.maxUsd} pocPrice={p.pocPrice} />
            </button>
          );
        })}
        {profiles.length === 0 && <div className="vp-pane-empty">no profiles yet</div>}
      </div>
    </aside>
  );
}
