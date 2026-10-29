import { useMemo, useState } from 'react';
import type { DerivRow, LiqEvent } from '../../shared/types';
import { isUnavailable } from '../../shared/types';
import { usePolling } from '../lib/api';
import { fmtCompact, fmtPrice, fmtPct } from '../lib/format';
import { Chip, Empty, Panel, Spinner, LiveBadge } from './ui';

/**
 * Phase 2 UI — the derivatives heatmap.
 *
 * Sorted by whatever column you click, with the extremes highlighted. Every
 * number here feeds a conviction component, so a wrong reading here becomes a
 * wrong grade and then a wrong frozen signal in the ledger.
 */

type SortKey = 'funding' | 'oiH1' | 'oiH4' | 'quadrant' | 'ls' | 'liq' | 'basis' | 'cvd';

const FUNDING_COLOR: Record<DerivRow['fundingLabel'], string> = {
  NEUTRAL: 'var(--muted)',
  CROWDED_LONG: '#f97316',
  CROWDED_SHORT: '#0ea5e9',
  EXTREME_LONG: '#dc2626',
  EXTREME_SHORT: '#2563eb',
  SQUEEZE_FUEL: '#16a34a',
};

const QUADRANT_SHORT: Record<DerivRow['quadrant'], string> = {
  'new-longs': 'New longs',
  'short-cover': 'Short cover',
  'new-shorts': 'New shorts',
  'long-liquidation': 'Long liq',
  flat: 'Flat',
};

const QUADRANT_COLOR: Record<DerivRow['quadrant'], string> = {
  'new-longs': '#16a34a',
  'new-shorts': '#dc2626',
  'short-cover': '#d97706',
  'long-liquidation': '#7c3aed',
  flat: 'var(--faint)',
};

interface DerivPayload {
  rows: DerivRow[];
  asOf: number;
  source: 'binance-futures' | 'bybit-linear' | null;
  unavailable: string | null;
}

function Cell({
  children,
  color,
  title,
  testId,
}: {
  children: React.ReactNode;
  color?: string;
  title?: string;
  testId?: string;
}) {
  return (
    <td
      className="px-2 py-1.5 text-right mono"
      style={color ? { color } : undefined}
      title={title}
      data-testid={testId}
    >
      {children}
    </td>
  );
}

export function DerivativesTab({ onSelect }: { onSelect: (symbol: string) => void }) {
  const { data, error, loading, refresh: reload } = usePolling<DerivPayload>(
    (s) => fetch('/api/derivatives', { signal: s }).then((r) => r.json()),
    30_000,
  );
  const liq = usePolling<{ recent: LiqEvent[]; note: string; asOf: number }>(
    (s) => fetch('/api/liquidations', { signal: s }).then((r) => r.json()),
    15_000,
  );
  const [sort, setSort] = useState<SortKey>('funding');
  const [desc, setDesc] = useState(true);

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
    const key = sort;
    list.sort((a, b) => {
      const val = (r: DerivRow): number => {
        switch (key) {
          case 'funding': return r.funding8h;
          case 'oiH1': return r.oiChange.h1;
          case 'oiH4': return r.oiChange.h4;
          case 'quadrant': return r.oiChange.h1;
          case 'ls': return r.lsDivergence ?? 0;
          case 'liq':
            // An unavailable liquidation feed sorts as 0 rather than throwing,
            // so the column still orders; the cell itself says why it is empty.
            return isUnavailable(r.liq) ? 0 : r.liq.h1;
          case 'basis': return r.basisPct ?? 0;
          case 'cvd': return r.cvd;
        }
      };
      return desc ? val(b) - val(a) : val(a) - val(b);
    });
    return list;
  }, [data, sort, desc]);

  const header = (key: SortKey, label: string, extra = '') => (
    <th
      className="font-medium px-2 py-1.5 cursor-pointer select-none whitespace-nowrap hover:opacity-80"
      style={{ color: sort === key ? 'var(--text)' : 'var(--faint)' }}
      onClick={() => {
        if (sort === key) setDesc((d) => !d);
        else { setSort(key); setDesc(true); }
      }}
      title={`Sort by ${label}${extra}`}
    >
      {label}{sort === key ? (desc ? ' ▾' : ' ▴') : ''}
    </th>
  );

  if (error && !data) return <Empty message="Derivatives unavailable." hint={error} />;

  const sourceLabel =
    data?.source === 'bybit-linear'
      ? 'Bybit linear'
      : data?.source === 'binance-futures'
        ? 'Binance futures'
        : 'no venue';

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_340px]" style={{ height: '100%' }}>
      <Panel
        title="Derivatives heatmap"
        subtitle={
          data
            ? `${data.rows.length} perps · ${sourceLabel} · funding normalised to 8h · CVD in USD notional`
            : undefined
        }
        right={data ? <LiveBadge updatedAt={data.asOf} /> : <button onClick={reload} className="text-[11px] px-2 py-0.5 rounded" style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}>Refresh</button>}
        bodyClass="overflow-y-auto"
      >
        {loading && !data ? <Spinner label="Loading perps…" /> : !data ? null : data.rows.length === 0 ? (
          <Empty
            message="No perp rows returned."
            hint={data.unavailable ?? 'The venue answered but none of the tracked symbols matched.'}
          />
        ) : (
          <table className="w-full border-collapse text-[11.5px]">
            <thead className="sticky top-0 z-10" style={{ background: 'var(--panel)' }}>
              <tr className="text-left" style={{ color: 'var(--faint)' }}>
                {header('funding', 'Symbol')}
                {header('funding', 'Fund 8h')}
                <th className="font-medium px-2 py-1.5">State</th>
                {header('oiH1', 'OI 1h')}
                {header('oiH4', 'OI 4h')}
                {header('quadrant', 'Quadrant')}
                {header('cvd', 'CVD')}
                {header('ls', 'Retail vs top')}
                {header('liq', 'Liq 1h')}
                {header('basis', 'Basis')}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.symbol}
                  onClick={() => onSelect(r.symbol.replace(/USDT$/, ''))}
                  className="cursor-pointer border-t hover:bg-[var(--panel-2)]"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <td className="px-2 py-1.5 font-semibold">{r.symbol.replace(/USDT$/, '')}</td>
                  <Cell
                    color={FUNDING_COLOR[r.fundingLabel]}
                    /**
                     * `fundingZ` is null until a funding history is collected, and
                     * null renders as a dash. It used to be a hardcoded 0 shown
                     * as "z=0.00", which is a placeholder wearing the label of a
                     * computed statistic.
                     */
                    title={
                      `${r.fundingLabel} · ` +
                      (r.fundingZ === null
                        ? 'z not computed — no funding history collected yet'
                        : `z=${r.fundingZ.toFixed(2)}`) +
                      ` · interval ${r.fundingIntervalH}h`
                    }
                  >
                    {(r.funding8h * 100).toFixed(4)}%
                  </Cell>
                  <td className="px-2 py-1.5">
                    <Chip color={FUNDING_COLOR[r.fundingLabel]} bg="transparent">
                      {r.fundingLabel.replace(/_/g, ' ')}
                    </Chip>
                  </td>
                  <Cell color={r.oiChange.h1 > 0 ? 'var(--color-up)' : r.oiChange.h1 < 0 ? 'var(--color-down)' : undefined}>
                    {fmtPct(r.oiChange.h1, 1)}
                  </Cell>
                  <Cell color={r.oiChange.h4 > 0 ? 'var(--color-up)' : r.oiChange.h4 < 0 ? 'var(--color-down)' : undefined}>
                    {fmtPct(r.oiChange.h4, 1)}
                  </Cell>
                  <td className="px-2 py-1.5 text-right" style={{ color: QUADRANT_COLOR[r.quadrant] }}>
                    {QUADRANT_SHORT[r.quadrant]}
                    {!isUnavailable(r.liq) && r.liq.cascade && (
                      <span className="ml-1" style={{ color: '#dc2626' }} title="Liquidation cascade in the last 5m">⚡</span>
                    )}
                  </td>
                  <Cell color={r.cvd > 0 ? 'var(--color-up)' : r.cvd < 0 ? 'var(--color-down)' : undefined}
                    /**
                     * The tooltip states that CVD is derived from spot kline
                     * taker-buy notional, because it is. A reader who assumes
                     * "CVD" means a futures trade tape would otherwise be
                     * reading a price-action proxy as if it were order flow.
                     */
                    title={`CVD ${r.cvd.toFixed(0)} USD · slope ${r.cvdSlope} · taker ratio ${(r.takerRatio ?? 0.5).toFixed(3)}` +
                      `${r.cvdDivergence ? ' · price high without CVD confirmation' : ''}` +
                      `\nDerived from spot kline taker-buy notional — a price-action proxy, not a futures trade tape.`}>
                    {r.cvd > 0 ? '▲' : r.cvd < 0 ? '▼' : '·'}{fmtCompact(Math.abs(r.cvd))}
                  </Cell>
                  <Cell
                    color={r.lsDivergence === null ? undefined : r.lsDivergence > 0.15 ? '#d97706' : r.lsDivergence < -0.15 ? '#0ea5e9' : undefined}
                    title={r.lsDivergence === null ? 'no data' : 'positive = retail longer than top traders'}
                  >
                    {r.lsDivergence === null ? '—' : `${r.lsDivergence > 0 ? '+' : ''}${(r.lsDivergence * 100).toFixed(0)}%`}
                  </Cell>
                  <Cell
                    /**
                     * A zero here would claim "no liquidations occurred". When the
                     * feed is simply not attached, the cell says so instead, with
                     * the reason on hover.
                     */
                    title={
                      isUnavailable(r.liq)
                        ? r.liq.reason
                        : `5m long ${fmtCompact(r.liq.longM5)} / short ${fmtCompact(r.liq.shortM5)}` +
                          `${r.liq.isSample ? ' · forceOrder samples at most 1/symbol/second — a lower bound' : ''}`
                    }
                    testId="liq-cell"
                  >
                    {isUnavailable(r.liq) ? 'n/a' : r.liq.h1 > 0 ? `$${fmtCompact(r.liq.h1)}` : '—'}
                  </Cell>
                  <Cell color={r.basisPct === null ? undefined : Math.abs(r.basisPct) > 1 ? '#d97706' : undefined}
                    title={r.basisPct === null ? 'Index price looks stale — basis not shown rather than reported wrongly' : undefined}>
                    {r.basisPct === null ? 'n/a' : `${r.basisPct > 0 ? '+' : ''}${r.basisPct.toFixed(3)}%`}
                  </Cell>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && (
          <p className="px-3 py-2 text-[10px]" style={{ color: 'var(--faint)' }}>
            Quadrant is the single most useful read: new longs and new shorts are healthy
            continuations, short covering and long liquidation are weaker and fade-prone.
            Basis is shown as a raw gap, not annualised — on illiquid perps the index goes stale.
          </p>
        )}
      </Panel>

      <div className="flex flex-col gap-3 min-h-0">
        <Panel
          title="Liquidation tape"
          subtitle="Live, lower bound"
          right={liq.data ? <LiveBadge updatedAt={liq.data.asOf} /> : undefined}
          className="min-h-[220px]"
          bodyClass="overflow-y-auto"
        >
          {!liq.data ? <Spinner /> : liq.data.recent.length === 0 ? (
            <Empty message="No liquidations sampled yet." hint="forceOrder@arr only fires during a cascade." />
          ) : (
            <>
              <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
                <LiqSplit longUsd={sumSide(liq.data.recent, 'SELL')} shortUsd={sumSide(liq.data.recent, 'BUY')} />
              </div>
              {liq.data.recent.slice(0, 40).map((e, i) => (
                <div key={`${e.t}-${i}`} className="flex items-center gap-2 px-3 py-1 border-b text-[11px]" style={{ borderColor: 'var(--border)' }}>
                  <span style={{ color: e.side === 'SELL' ? 'var(--color-down)' : 'var(--color-up)', width: 14 }}>
                    {e.side === 'SELL' ? '▼' : '▲'}
                  </span>
                  <span className="font-semibold w-14">{e.symbol.replace(/USDT$/, '')}</span>
                  <span className="mono" style={{ color: 'var(--muted)' }}>{fmtPrice(e.price)}</span>
                  <span className="mono ml-auto">${fmtCompact(e.usd)}</span>
                </div>
              ))}
              <p className="px-3 py-2 text-[10px]" style={{ color: 'var(--faint)' }}>
                {liq.data.note}
              </p>
            </>
          )}
        </Panel>

        <Panel title="Reading this panel" bodyClass="p-3">
          <ul className="text-[11px] leading-relaxed space-y-1.5" style={{ color: 'var(--muted)' }}>
            <li><strong style={{ color: FUNDING_COLOR.EXTREME_LONG }}>Extreme funding</strong> with rising OI is genuine crowding. Extreme funding with <em>falling</em> OI is positions unwinding, which is worse.</li>
            <li><strong>CVD</strong> is in USD notional, computed from the taker-buy quote volume Binance already sends. Negative CVD on a rising price means the rally is not being bought.</li>
            <li><strong>Liquidation totals are a lower bound.</strong> Binance only pushes the latest liquidation per symbol per second.</li>
            <li><strong>Basis</strong> reads <em>n/a</em> rather than a number when the index looks stale. A fabricated basis is worse than no basis.</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function sumSide(events: LiqEvent[], side: 'BUY' | 'SELL'): number {
  return events.filter((e) => e.side === side).reduce((a, e) => a + e.usd, 0);
}

function LiqSplit({ longUsd, shortUsd }: { longUsd: number; shortUsd: number }) {
  const total = longUsd + shortUsd;
  const longPct = total > 0 ? (longUsd / total) * 100 : 50;
  return (
    <div>
      <div className="flex justify-between text-[10px] mb-1">
        <span className="down">Longs liquidated ${fmtCompact(longUsd)}</span>
        <span className="up">Shorts ${fmtCompact(shortUsd)}</span>
      </div>
      <div className="flex h-2 rounded-full overflow-hidden" style={{ background: 'var(--panel-2)' }}>
        <div style={{ width: `${longPct}%`, background: 'var(--color-down)' }} />
        <div style={{ width: `${100 - longPct}%`, background: 'var(--color-up)' }} />
      </div>
    </div>
  );
}
