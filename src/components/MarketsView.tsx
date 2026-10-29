import { useEffect, useMemo, useState } from 'react';
import { api, type MarketsResponse } from '../lib/api';
import { useLivePrice } from '../lib/priceStore';
import { fmtPct, fmtPrice } from '../lib/format';

/**
 * Markets — the whole scanned universe, not just the board.
 *
 * The two boards show the top 20 per side, so a coin that is simply quiet has
 * no row anywhere. This tab lists EVERY pair in the universe (sorted by 24h
 * volume) and each row subscribes to the same tick store the board uses, so its
 * price moves live rather than sitting at the value it had when the page
 * loaded.
 *
 * The list itself is fetched on mount and refreshed every 15s only for volume
 * and membership; prices come from the socket.
 */
const REFRESH_MS = 15_000;

export function MarketsView({ onSelect }: { onSelect: (base: string) => void }) {
  const [data, setData] = useState<MarketsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'volume' | 'change' | 'ticker'>('volume');

  useEffect(() => {
    let alive = true;
    const load = () => {
      api
        .markets()
        .then((r) => {
          if (!alive) return;
          setData(r);
          setError(null);
        })
        .catch((e: Error) => {
          if (!alive) return;
          setError(e.message);
        });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const rows = useMemo(() => {
    const base = data?.rows ?? [];
    const needle = q.trim().toUpperCase();
    const filtered = needle
      ? base.filter((r) => r.base.includes(needle) || r.name.toUpperCase().includes(needle))
      : base;
    const sorted = [...filtered];
    if (sort === 'change') sorted.sort((a, b) => b.changePct - a.changePct);
    else if (sort === 'ticker') sorted.sort((a, b) => a.base.localeCompare(b.base));
    else sorted.sort((a, b) => b.volumeUsd - a.volumeUsd);
    return sorted;
  }, [data, q, sort]);

  return (
    <div className="of-card" style={{ padding: 0, overflow: 'hidden' }}>
      <header
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div>
          <b style={{ fontSize: 13 }}>Markets</b>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            {data ? `${data.n} pairs in the scanned universe · prices live from the tick stream` : 'Loading universe…'}
          </div>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter…"
          data-testid="markets-filter"
          style={{
            marginLeft: 'auto', padding: '4px 8px', borderRadius: 6, fontSize: 12,
            background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)',
          }}
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          data-testid="markets-sort"
          style={{
            padding: '4px 8px', borderRadius: 6, fontSize: 12,
            background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)',
          }}
        >
          <option value="volume">Volume</option>
          <option value="change">24h change</option>
          <option value="ticker">Ticker</option>
        </select>
      </header>

      {error && <div style={{ padding: 14, color: 'var(--color-down)', fontSize: 12 }}>Markets unavailable: {error}</div>}

      <div style={{ maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' }} data-testid="markets-list">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, background: 'var(--panel)', color: 'var(--muted)', textAlign: 'left' }}>
              <th style={{ padding: '6px 14px', fontWeight: 600 }}>Ticker</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>Name</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>Sector</th>
              <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>Price</th>
              <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>24h</th>
              <th style={{ padding: '6px 14px', fontWeight: 600, textAlign: 'right' }}>Volume</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <MarketRow key={r.pair} row={r} onSelect={onSelect} />
            ))}
          </tbody>
        </table>
        {data && rows.length === 0 && (
          <div style={{ padding: 14, color: 'var(--muted)', fontSize: 12 }}>No pairs match “{q}”.</div>
        )}
      </div>
    </div>
  );
}

function MarketRow({ row, onSelect }: { row: MarketsResponse['rows'][number]; onSelect: (base: string) => void }) {
  const live = useLivePrice(row.pair);
  const price = live?.price ?? row.price;
  const changePct = live?.changePct ?? row.changePct;
  const up = changePct >= 0;
  return (
    <tr
      onClick={() => onSelect(row.base)}
      data-testid="market-row"
      data-base={row.base}
      style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}
    >
      <td style={{ padding: '6px 14px', fontWeight: 700 }}>{row.base}</td>
      <td style={{ padding: '6px 8px', color: 'var(--muted)' }}>{row.name || '—'}</td>
      <td style={{ padding: '6px 8px', color: 'var(--faint)' }}>{row.sector}</td>
      <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {fmtPrice(price)}
        {live && <span title="Live tick" style={{ color: 'var(--color-up)', marginLeft: 4 }}>•</span>}
      </td>
      <td style={{ padding: '6px 8px', textAlign: 'right', color: up ? 'var(--color-up)' : 'var(--color-down)' }}>
        {fmtPct(changePct)}
      </td>
      <td style={{ padding: '6px 14px', textAlign: 'right', color: 'var(--muted)' }}>
        ${(row.volumeUsd / 1e6).toFixed(1)}M
      </td>
    </tr>
  );
}
