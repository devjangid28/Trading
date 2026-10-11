import { useEffect, type ReactNode } from 'react';
import type { Candle, AssetRow, Setup } from '../../shared/types';
import { useLazy } from '../lib/api';
import { fmtPct, fmtPrice } from '../lib/format';
import { CandleChart } from './CandleChart';
import { ChecklistPanel } from './signalChips';
import { Chip, Spinner } from './ui';

export interface AssetDetail {
  id: string;
  pair: string;
  name: string;
  sector: string;
  candles: Candle[];
  setup: Setup | null;
  side: 'bullish' | 'bearish';
  choppiness: number;
  strength: number;
  rangePct: number;
  changePct: number;
  price: number;
  updatedAt: number;
}

function Row({
  label,
  children,
  tone,
}: {
  label: string;
  children: ReactNode;
  tone?: 'up' | 'down' | 'muted';
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
      <span className="text-[11px] shrink-0" style={{ color: 'var(--muted)' }}>
        {label}
      </span>
      <span
        className={`mono text-[12px] font-medium text-right ${tone === 'up' ? 'up' : tone === 'down' ? 'down' : ''}`}
      >
        {children}
      </span>
    </div>
  );
}

/** The four-point alignment check: how much of the context agrees with the setup. */
function AlignmentCheck({
  checks,
}: {
  checks: { label: string; ok: boolean }[];
}) {
  const score = checks.filter((c) => c.ok).length;
  const color =
    score >= 4 ? 'var(--color-up)' : score === 3 ? 'var(--color-amber)' : 'var(--color-down)';
  const verdict =
    score >= 4 ? 'Full attention' : score === 3 ? 'Workable, size down' : 'Usually a pass';
  return (
    <div className="px-3 py-2 rounded-lg" style={{ background: 'var(--panel-2)' }}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>
          Alignment check
        </span>
        <span className="text-[11px] font-bold" style={{ color }}>
          {score}/4 · {verdict}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1 mt-1.5">
        {checks.map((c) => (
          <span key={c.label} className="text-[10.5px] flex items-center gap-1.5">
            <span
              style={{
                color: c.ok ? 'var(--color-up)' : 'var(--faint)',
                fontWeight: 700,
              }}
            >
              {c.ok ? '✓' : '✕'}
            </span>
            <span style={{ color: c.ok ? 'var(--text)' : 'var(--faint)' }}>{c.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function AssetPopup({
  assetId,
  row,
  breadthBias,
  sectorAvgChange,
  onClose,
}: {
  assetId: string;
  row: AssetRow | null;
  breadthBias: 'bullish' | 'bearish' | 'two-way';
  sectorAvgChange: number | null;
  onClose: () => void;
}) {
  const { data, error, loading } = useLazy<AssetDetail>(
    (s) => fetch(`/api/asset/${assetId}`, { signal: s }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
    !!assetId,
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setup = data?.setup ?? row?.setup ?? null;
  const bullish = (data?.side ?? row?.side) === 'bullish';
  const color = bullish ? 'var(--color-up)' : 'var(--color-down)';
  const price = data?.price ?? row?.price ?? 0;
  const vwap = row?.vwap ?? null;

  const checks = [
    { label: 'Top of its board', ok: !!row && row.rank <= 20 },
    {
      label: 'Sector leans same way',
      ok: sectorAvgChange !== null && (bullish ? sectorAvgChange >= 0 : sectorAvgChange <= 0),
    },
    {
      label: 'Breadth leans same way',
      ok: breadthBias === (bullish ? 'bullish' : 'bearish'),
    },
    {
      label: bullish ? 'Price above VWAP' : 'Price below VWAP',
      ok: !!vwap && ((bullish && price > vwap) || (!bullish && price < vwap)),
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="panel w-full sm:max-w-3xl max-h-[92vh] overflow-y-auto of-in"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="panel-header sticky top-0 z-10" style={{ background: 'var(--panel)' }}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-bold tracking-tight">{assetId}</h2>
              <span className={`text-[12px] font-semibold mono ${(data?.changePct ?? row?.changePct ?? 0) >= 0 ? 'up' : 'down'}`}>
                {fmtPrice(price)} {fmtPct(data?.changePct ?? row?.changePct ?? 0)}
              </span>
            </div>
            <p className="text-[11px] truncate" style={{ color: 'var(--muted)' }}>
              {data?.name ?? row?.name} · {data?.sector ?? row?.sector} ·{' '}
              {bullish ? 'Bullish setup' : 'Bearish setup'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-[16px]"
            style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {loading && !data && <Spinner label="Loading chart…" />}
        {error && (
          <div className="p-6 text-center text-[12px] down">{error}</div>
        )}

        {data && (
          <div className="p-3 space-y-3">
            {data.candles.length > 0 ? (
              <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                <CandleChart candles={data.candles} setup={setup} vwap={vwap ?? null} height={300} />
              </div>
            ) : (
              <div className="p-6 text-center text-[12px]" style={{ color: 'var(--muted)' }}>
                No chart data.
              </div>
            )}

            {!setup ? (
              <div className="px-3 py-4 text-center text-[12px]" style={{ color: 'var(--muted)' }}>
                No valid order block right now.
                <br />
                <span style={{ color: 'var(--faint)' }}>
                  A zone needs a closed 5m candle, a close beyond structure, and a forceful move away
                  that has not since been closed through.
                </span>
              </div>
            ) : (
              <>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="rounded-lg px-3 py-2" style={{ background: 'var(--panel-2)' }}>
                    <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--faint)' }}>
                      The ladder
                    </div>
                    <Row label="Order block" tone={bullish ? 'up' : 'down'}>
                      {fmtPrice(setup.obLow)} – {fmtPrice(setup.obHigh)}
                    </Row>
                    <Row label="Zone (Z)">{fmtPrice(setup.z)}</Row>
                    <Row label={bullish ? 'Wrong below (S1)' : 'Wrong above (R1)'} tone="down">
                      {fmtPrice(setup.invalidation)}
                    </Row>
                    {setup.targets.length ? (
                      setup.targets.map((t) => (
                        <Row key={t.label} label={`Liquidity ${t.label}`}>
                          {fmtPrice(t.price)}
                        </Row>
                      ))
                    ) : (
                      <Row label="Liquidity ahead" tone="muted">
                        none in range
                      </Row>
                    )}
                    <Row label="R:R" tone={setup.rr >= 2 ? 'up' : 'muted'}>
                      {setup.rr > 0 ? `1 : ${setup.rr.toFixed(1)}` : '—'}
                    </Row>
                  </div>

                  <div className="rounded-lg px-3 py-2" style={{ background: 'var(--panel-2)' }}>
                    <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--faint)' }}>
                      Proof and context
                    </div>
                    <Row label="Side">{bullish ? 'Bullish' : 'Bearish'}</Row>
                    <Row label="Proof">
                      {setup.fvg ? (
                        <Chip color="var(--color-up)" bg="rgba(22,163,74,0.16)">
                          Fair-value gap
                        </Chip>
                      ) : (
                        `${setup.displacement.toFixed(2)}× avg range`
                      )}
                    </Row>
                    <Row label="Zone age">{setup.ageMinutes} min</Row>
                    <Row label="Choppiness">{data.choppiness.toFixed(0)} / 100</Row>
                    <Row label="Day range">{data.rangePct.toFixed(2)}%</Row>
                    <Row label="Prior setups">{setup.previous.length}</Row>
                    <Row label="VWAP">
                      {vwap ? fmtPrice(vwap) : <span style={{ color: 'var(--faint)' }}>n/a</span>}
                    </Row>
                  </div>
                </div>

                <AlignmentCheck checks={checks} />

                <div className="rounded-lg p-3" style={{ background: 'var(--panel-2)' }}>
                  <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--faint)' }}>
                    Signal
                  </div>
                  <ChecklistPanel conviction={row?.conviction ?? null} plan={row?.plan ?? null} />
                </div>

                <div
                  className="px-3 py-2 rounded-lg text-[11px] leading-relaxed"
                  style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}
                >
                  {bullish ? (
                    <>
                      The zone sits below price at <strong style={{ color }}>{fmtPrice(setup.z)}</strong>.
                      It is wrong once a 5m candle closes below{' '}
                      <strong style={{ color: 'var(--color-down)' }}>{fmtPrice(setup.invalidation)}</strong>.
                      Act at the zone, not wherever price happens to be.
                    </>
                  ) : (
                    <>
                      The zone sits above price at <strong style={{ color }}>{fmtPrice(setup.z)}</strong>.
                      It is wrong once a 5m candle closes above{' '}
                      <strong style={{ color: 'var(--color-down)' }}>{fmtPrice(setup.invalidation)}</strong>.
                      Act at the zone, not wherever price happens to be.
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
