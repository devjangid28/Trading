import { useMemo, useState } from 'react';
import type { AssetRow, ScanResult, SectorFlow } from '../../shared/types';
import { fmtPct, istStamp } from '../lib/format';

/**
 * Sector panel (B5).
 *
 * Structure per spec: a large "sectors up" number, a segmented row of squares,
 * a "Sector flow" header with the average and the window, then a ranked list
 * with diverging bars and one cell per member coin.
 *
 * The old panel carried a large multi-line flow chart that took the full band
 * and pushed the ranked list below the fold. The list is the useful part — the
 * per-member cells are what tell you WHICH coin inside a sector is actually
 * moving — so it is promoted and the chart is replaced by the segmented share
 * bar.
 */

export function SectorsPanel({ data }: { data: ScanResult }) {
  const [expanded, setExpanded] = useState(false);
  const sectors = data.sectors;
  const nUp = sectors.filter((s) => s.avgChange > 0).length;
  const nDn = sectors.length - nUp;
  const maxAbs = Math.max(0.5, ...sectors.map((s) => Math.abs(s.avgChange)));

  const ranked = useMemo(
    () => [...sectors].sort((a, b) => b.avgChange - a.avgChange),
    [sectors],
  );
  const visible = expanded ? ranked : ranked.slice(0, 6);
  const avgChange = sectors.length
    ? sectors.reduce((a, s) => a + s.avgChange, 0) / sectors.length
    : 0;

  return (
    <section className="of-card of-sectors" data-testid="sectors-panel">
      <header className="of-sec-h">
        <h2>Sectors now</h2>
        <button type="button" className="of-link" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Collapse' : 'Open'}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </header>

      <div className="of-sx-top">
        <div className="of-sx-num">
          <b data-testid="sectors-up">{nUp}</b>
          <span>Sectors up</span>
          <em>{sectors.length ? ((nUp / sectors.length) * 100).toFixed(0) : '—'}%</em>
        </div>

        {/* Segmented share bar: one square per sector, filled green when up. */}
        <div className="of-sx-seg" data-testid="sector-segments" aria-hidden="true">
          {sectors.map((s) => (
            <i key={s.sector} className={s.avgChange > 0 ? 'up' : 'dn'} title={`${s.sector} ${fmtPct(s.avgChange)}`} />
          ))}
        </div>

        <div className="of-sx-dn">
          <b>{nDn}</b>
          <span>down</span>
        </div>
      </div>

      <header className="of-sx-flowh">
        <h3>Sector flow</h3>
        <em>avg {fmtPct(avgChange)} · as of {istStamp(data.updatedAt)} IST</em>
      </header>

      <ul className="of-sx-list" data-testid="sector-list">
        {visible.map((s, i) => (
          <SectorRow key={s.sector} s={s} rank={i + 1} maxAbs={maxAbs} />
        ))}
        {sectors.length === 0 && (
          <li className="of-sx-empty">No sector data yet — the scan has not classified any members.</li>
        )}
      </ul>
    </section>
  );
}

function SectorRow({ s, rank, maxAbs }: { s: SectorFlow; rank: number; maxAbs: number }) {
  const w = Math.min(100, (Math.abs(s.avgChange) / maxAbs) * 50);
  return (
    <li className="of-sx-r" data-testid="sector-row" data-sector={s.sector}>
      <span className="rk">{String(rank).padStart(2, '0')}</span>
      <span className="nm">{s.sector}</span>
      <span className="bar" aria-hidden="true">
        <i className={s.avgChange >= 0 ? 'up' : 'dn'}
          style={s.avgChange >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
      </span>
      <span className="cells" aria-hidden="true">
        {s.members.slice(0, 12).map((m) => (
          <i key={m.symbol} className={m.changePct >= 0 ? 'up' : 'dn'} title={`${m.symbol} ${fmtPct(m.changePct)}`} />
        ))}
      </span>
      <b className={s.avgChange >= 0 ? 'up' : 'dn'}>{fmtPct(s.avgChange)}</b>
    </li>
  );
}

export type { AssetRow };