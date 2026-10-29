import { useMemo, useRef, useEffect, useState } from 'react';
import type { Conviction, DerivRow, Setup, TradePlan } from '../../shared/types';
import { api, usePolling } from '../lib/api';
import { livePrice } from '../lib/liveContext';
import { AssetPopup } from './AssetPopup';
import { MindSignalBlock } from './MindBits';
import type {
  CalibrationReportView,
  MindHealthView,
  MindSignalRow,
} from '../lib/api';
import '../components/mind.css';

interface VolumeProfile {
  poc: number; vah: number; val: number; totalVolume: number;
  buckets: { price: number; volume: number; delta: number }[];
}
interface FootprintCandle {
  t: number; o: number; h: number; l: number; c: number;
  buyVol: number; sellVol: number; delta: number; cvd: number; deltaDiv: boolean;
}
interface GexSnapshot {
  symbol: string; price: number; maxPainStrike: number;
  totalNetGex: number; dealersShortGamma: boolean;
  strikes: { strike: number; callOi: number; putOi: number; netGex: number }[];
  asOf: number;
}
/**
 * `/api/signals` re-sends the scan board rows with order-flow fields added, so
 * `setup`, `plan`, `conviction` and `derivatives` are the engine's own types
 * and are declared as such rather than copied out field by field.
 *
 * They used to be hand-copied subsets. That is what made this row impossible to
 * hand to `AssetPopup` without a cast, which is what the popup was opened with
 * `row={null}` — and a `null` row meant no VWAP and no board rank in the chart
 * the user opened by tapping a signal card.
 */
interface SignalRow {
  base: string; symbol: string; displayTicker: string;
  displayName: string | null; logoUrl: string | null;
  sector: string; side: 'bullish' | 'bearish';
  price: number; changePct: number; volumeUsd: number;
  strength: number; percentile: number;
  /** Board position, 1-based. These rows are the scan board rows. */
  rank?: number;
  isPick: boolean;
  conviction: Conviction | null;
  setup: Setup | null;
  vwap: number | null;
  derivatives: DerivRow | null;
  newsDot: { nis: number; direction: -1 | 0 | 1; count: number } | null;
  plan: TradePlan | null;
  volumeProfile: VolumeProfile | null;
  footprint: FootprintCandle[];
  confluenceScore: number;
  recentDeltaDivergence: boolean;
  updatedAt: number;
  /**
   * The Mind layer's calibrated read, present when the server ran the pass.
   * Optional and nullable on purpose: a row without one renders nothing, which
   * is different from rendering a neutral-looking zero.
   */
  mind?: MindSignalRow | null;
}
interface SignalsResponse {
  updatedAt: number;
  bullish: SignalRow[];
  bearish: SignalRow[];
  gex: { btc: GexSnapshot | null; eth: GexSnapshot | null };
  regime: string;
  breadthBias: string;
  blackedOut: boolean;
}

function fmtPx(v: number): string {
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: v >= 1 ? 2 : 4 })}`;
}
function fmtVol(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
}
function scoreColor(s: number): string {
  if (s >= 75) return '#3fd487';
  if (s >= 50) return '#eab308';
  return '#f87171';
}

function ConfluenceRing({ score }: { score: number }) {
  const r = 18; const circ = 2 * Math.PI * r;
  const fill = (score / 100) * circ;
  const color = scoreColor(score);
  return (
    <svg width={44} height={44} viewBox="0 0 44 44" style={{ flexShrink: 0 }}>
      <circle cx={22} cy={22} r={r} fill="none" stroke="var(--panel-2)" strokeWidth={4} />
      <circle cx={22} cy={22} r={r} fill="none" stroke={color} strokeWidth={4}
        strokeDasharray={`${fill} ${circ - fill}`} strokeLinecap="round"
        transform="rotate(-90 22 22)" />
      <text x={22} y={26} textAnchor="middle" fontSize={11} fontWeight={700}
        fill={color} fontFamily="monospace">{score}</text>
    </svg>
  );
}

function VolumeProfileBar({ vp, price, side }: { vp: VolumeProfile; price: number; side: 'bullish' | 'bearish' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const W = 52; const H = 80;
    cv.width = W * 2; cv.height = H * 2;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.scale(2, 2); ctx.clearRect(0, 0, W, H);
    const maxVol = Math.max(...vp.buckets.map((b) => b.volume), 1);
    const priceRange = (vp.buckets[vp.buckets.length - 1]?.price ?? 0) - (vp.buckets[0]?.price ?? 0) || 1;
    const bh = H / vp.buckets.length;
    vp.buckets.forEach((b, i) => {
      const bw = (b.volume / maxVol) * (W - 6);
      const y = H - (i + 1) * bh;
      const inVA = b.price >= vp.val && b.price <= vp.vah;
      const isPoc = Math.abs(b.price - vp.poc) < priceRange / vp.buckets.length;
      ctx.fillStyle = isPoc ? '#eab308' : inVA ? 'rgba(99,179,237,0.55)' : 'rgba(99,179,237,0.2)';
      ctx.fillRect(0, y, bw, Math.max(1, bh - 0.5));
    });
    const priceY = H - ((price - (vp.buckets[0]?.price ?? 0)) / priceRange) * H;
    ctx.strokeStyle = side === 'bullish' ? '#3fd487' : '#f87171';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, priceY); ctx.lineTo(W, priceY); ctx.stroke();
  }, [vp, price, side]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <canvas ref={ref} style={{ width: 52, height: 80, borderRadius: 3 }} />
      <span style={{ fontSize: 9, color: 'var(--faint)', fontFamily: 'monospace' }}>POC {fmtPx(vp.poc)}</span>
      <span style={{ fontSize: 9, color: 'var(--faint)', fontFamily: 'monospace' }}>VA {fmtPx(vp.val)}–{fmtPx(vp.vah)}</span>
    </div>
  );
}

function FootprintBar({ fp }: { fp: FootprintCandle[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv || !fp.length) return;
    const W = 80; const H = 40;
    cv.width = W * 2; cv.height = H * 2;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.scale(2, 2); ctx.clearRect(0, 0, W, H);
    const maxAbs = Math.max(...fp.map((f) => Math.abs(f.delta)), 1);
    const bw = W / fp.length;
    fp.forEach((f, i) => {
      const h = (Math.abs(f.delta) / maxAbs) * (H / 2 - 2);
      ctx.fillStyle = f.deltaDiv ? '#f59e0b' : f.delta >= 0 ? '#3fd487' : '#f87171';
      ctx.globalAlpha = 0.85;
      if (f.delta >= 0) ctx.fillRect(i * bw + 0.5, H / 2 - h, bw - 1, h);
      else ctx.fillRect(i * bw + 0.5, H / 2, bw - 1, h);
    });
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    const cvdMin = Math.min(...fp.map((f) => f.cvd));
    const cvdMax = Math.max(...fp.map((f) => f.cvd));
    const cvdRange = cvdMax - cvdMin || 1;
    ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 1;
    ctx.beginPath();
    fp.forEach((f, i) => {
      const x = i * bw + bw / 2;
      const y = H - ((f.cvd - cvdMin) / cvdRange) * (H - 4) - 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, [fp]);
  const last = fp[fp.length - 1];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <canvas ref={ref} style={{ width: 80, height: 40, borderRadius: 3 }} />
      <div style={{ display: 'flex', gap: 6, fontSize: 9, fontFamily: 'monospace' }}>
        <span style={{ color: last?.delta >= 0 ? '#3fd487' : '#f87171' }}>
          Δ {last ? (last.delta >= 0 ? '+' : '') + last.delta.toFixed(0) : '—'}
        </span>
        <span style={{ color: '#60a5fa' }}>CVD {last ? last.cvd.toFixed(0) : '—'}</span>
      </div>
    </div>
  );
}

function GexPanel({ gex }: { gex: GexSnapshot }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv || !gex.strikes.length) return;
    const W = 200; const H = 72;
    cv.width = W * 2; cv.height = H * 2;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.scale(2, 2); ctx.clearRect(0, 0, W, H);
    const sorted = [...gex.strikes].sort((a, b) => a.strike - b.strike).slice(0, 16);
    const maxAbs = Math.max(...sorted.map((s) => Math.abs(s.netGex)), 1);
    const bw = W / sorted.length;
    sorted.forEach((s, i) => {
      const h = (Math.abs(s.netGex) / maxAbs) * (H / 2 - 4);
      ctx.fillStyle = s.netGex >= 0 ? 'rgba(63,212,135,0.7)' : 'rgba(248,113,113,0.7)';
      if (s.netGex >= 0) ctx.fillRect(i * bw + 0.5, H / 2 - h, bw - 1, h);
      else ctx.fillRect(i * bw + 0.5, H / 2, bw - 1, h);
    });
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    const prices = sorted.map((s) => s.strike);
    const minP = Math.min(...prices); const maxP = Math.max(...prices);
    const priceX = ((gex.price - minP) / (maxP - minP || 1)) * W;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(priceX, 0); ctx.lineTo(priceX, H); ctx.stroke();
    ctx.setLineDash([]);
  }, [gex]);
  return (
    <div style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--panel-2)', border: '1px solid var(--border)', minWidth: 220 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700 }}>{gex.symbol} GEX</span>
        <span style={{ fontSize: 10, color: gex.dealersShortGamma ? '#f87171' : '#3fd487' }}>
          {gex.dealersShortGamma ? '⚡ SHORT GAMMA' : '🛡 LONG GAMMA'}
        </span>
      </div>
      <canvas ref={ref} style={{ width: 200, height: 72, borderRadius: 4, display: 'block' }} />
      <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace' }}>
        <span>Max Pain <b style={{ color: 'var(--text)' }}>{fmtPx(gex.maxPainStrike)}</b></span>
        <span>Spot <b style={{ color: 'var(--text)' }}>{fmtPx(gex.price)}</b></span>
      </div>
    </div>
  );
}

function SignalCard({
  row,
  livePx,
  onOpen,
  calibration,
  regimeEvidence,
}: {
  row: SignalRow;
  livePx?: number;
  onOpen: (base: string) => void;
  calibration: CalibrationReportView | null;
  regimeEvidence: Array<{ input: string; value: number | string | null; reading: string }>;
}) {
  const bull = row.side === 'bullish';
  const color = bull ? '#3fd487' : '#f87171';
  const px = livePx ?? row.price;
  const s = row.setup;
  const d = row.derivatives;

  const factors = [
    { label: 'Order Block', ok: !!s, value: s ? s.retest.replace(/-/g, ' ') : 'none' },
    { label: 'HTF Aligned', ok: !!s?.htf.aligned, value: s?.htf.aligned ? 'yes' : 'no' },
    { label: 'VWAP Side', ok: row.vwap !== null && (bull ? px > row.vwap! : px < row.vwap!), value: row.vwap ? fmtPx(row.vwap) : '—' },
    { label: 'CVD Slope', ok: d ? (bull ? d.cvdSlope > 0 : d.cvdSlope < 0) : false, value: d ? (d.cvdSlope > 0 ? '↑' : '↓') : '—' },
    { label: 'Funding', ok: d ? !(d.fundingLabel === 'CROWDED_LONG' && bull) && !(d.fundingLabel === 'CROWDED_SHORT' && !bull) : true, value: d?.fundingLabel.replace(/_/g, ' ').toLowerCase() ?? '—' },
    { label: 'DOM', ok: d?.depth ? (bull ? d.depth.imbalance > 0.05 : d.depth.imbalance < -0.05) : false, value: d?.depth ? `${(d.depth.imbalance * 100).toFixed(0)}%` : '—' },
    { label: 'News', ok: row.newsDot ? (bull ? row.newsDot.direction >= 0 : row.newsDot.direction <= 0) : true, value: row.newsDot ? `NIS ${row.newsDot.nis.toFixed(0)}` : 'quiet' },
    { label: 'Vol Profile', ok: !!row.volumeProfile, value: row.volumeProfile ? `POC ${fmtPx(row.volumeProfile.poc)}` : '—' },
  ];

  const okCount = factors.filter((f) => f.ok).length;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(row.base)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(row.base)}
      style={{
        borderRadius: 10, padding: '10px 12px',
        border: `1px solid ${row.isPick ? color : 'var(--border)'}`,
        background: 'var(--panel)',
        boxShadow: row.isPick ? `0 0 14px ${color}22` : 'none',
        display: 'flex', flexDirection: 'column', gap: 8,
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {row.logoUrl && <img src={row.logoUrl} alt="" style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>{row.displayTicker}</span>
            {row.isPick && <span style={{ fontSize: 9, fontWeight: 700, color, background: `${color}22`, padding: '1px 5px', borderRadius: 4 }}>PICK</span>}
            <span style={{ fontSize: 10, color: 'var(--muted)' }}>{row.sector}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, fontSize: 11, fontFamily: 'monospace', marginTop: 1 }}>
            <span style={{ fontWeight: 600 }}>{fmtPx(px)}</span>
            <span style={{ color: row.changePct >= 0 ? '#3fd487' : '#f87171' }}>{row.changePct >= 0 ? '+' : ''}{row.changePct.toFixed(2)}%</span>
            <span style={{ color: 'var(--faint)' }}>{fmtVol(row.volumeUsd)}</span>
          </div>
        </div>
        <ConfluenceRing score={row.confluenceScore} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px' }}>
        {factors.map((f) => (
          <div key={f.label} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
            <span style={{ color: f.ok ? '#3fd487' : '#f87171', fontSize: 11 }}>{f.ok ? '✓' : '✗'}</span>
            <span style={{ color: 'var(--muted)' }}>{f.label}</span>
            <span style={{ color: 'var(--faint)', fontFamily: 'monospace', marginLeft: 'auto', fontSize: 9 }}>{f.value}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {row.volumeProfile && <VolumeProfileBar vp={row.volumeProfile} price={px} side={row.side} />}
        {row.footprint.length > 0 && <FootprintBar fp={row.footprint} />}
        {row.plan && (
          <div style={{ flex: 1, minWidth: 120, fontSize: 10, fontFamily: 'monospace', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ color: 'var(--muted)', fontSize: 9, fontWeight: 600, letterSpacing: '0.05em' }}>ENTRY PLAN</div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--faint)' }}>Zone</span>
              <span style={{ color }}>{fmtPx(row.plan.entryLow)}–{fmtPx(row.plan.entryHigh)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--faint)' }}>Stop</span>
              <span style={{ color: '#f87171' }}>{fmtPx(row.plan.stop)}</span>
            </div>
            {row.plan.targets.slice(0, 2).map((t) => (
              <div key={t.label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--faint)' }}>{t.label}</span>
                <span style={{ color: '#60a5fa' }}>{fmtPx(t.price)} <span style={{ color: 'var(--faint)' }}>({t.rr.toFixed(1)}R)</span></span>
              </div>
            ))}
            {row.recentDeltaDivergence && (
              <div style={{ color: '#f59e0b', fontSize: 9, marginTop: 2 }}>⚠ Delta div — confirm entry</div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ flex: 1, height: 3, borderRadius: 2, background: 'var(--panel-2)', overflow: 'hidden' }}>
          <div style={{ width: `${(okCount / factors.length) * 100}%`, height: '100%', background: scoreColor(row.confluenceScore), borderRadius: 2, transition: 'width 0.3s' }} />
        </div>
        <span style={{ fontSize: 9, color: 'var(--faint)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{okCount}/{factors.length} factors</span>
        <span style={{ fontSize: 9, color: 'var(--faint)' }}>↗ tap for chart</span>
      </div>

      {/* The Mind block sits BELOW the confluence bar on purpose: the bar is the
          engine's existing points tally, the block is the calibrated read. Putting
          the probability last means the reader has already seen what it is
          correcting. When the row carries no Mind signal nothing renders — the
          gap is honest, and it is not filled with a 50%. */}
      {row.mind && (
        <MindSignalBlock
          signal={row.mind as unknown as MindSignalRow}
          calibration={calibration}
          grade={row.conviction?.grade ?? 'C'}
          evidence={regimeEvidence}
        />
      )}
    </div>
  );
}

export function SignalsView() {
  const [sideFilter, setSideFilter] = useState<'both' | 'bullish' | 'bearish'>('both');
  const [minScore, setMinScore] = useState(0);
  const [chartFor, setChartFor] = useState<string | null>(null);

  const state = usePolling<SignalsResponse>(
    (s) => fetch('/api/signals', { signal: s }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<SignalsResponse>;
    }),
    60_000,
  );

  // The Mind health read is what makes the per-card probability mean something:
  // it carries the Brier score against the base rate. A probability with no
  // reliability attached is decoration, so this is fetched rather than skipped.
  const mindHealth = usePolling<MindHealthView>((s) => api.mindHealth(s), 60_000);

  const allRows = useMemo(() => [
    ...(state.data?.bullish ?? []),
    ...(state.data?.bearish ?? []),
  ], [state.data]);

  const bullish = useMemo(() => (state.data?.bullish ?? []).filter((r) => r.confluenceScore >= minScore), [state.data, minScore]);
  const bearish = useMemo(() => (state.data?.bearish ?? []).filter((r) => r.confluenceScore >= minScore), [state.data, minScore]);

  const chartRow = useMemo(() => allRows.find((r) => r.base === chartFor) ?? null, [allRows, chartFor]);

  const sectorAvg = useMemo(() => {
    if (!chartRow) return null;
    const peers = allRows.filter((r) => r.sector === chartRow.sector);
    if (!peers.length) return null;
    return peers.reduce((sum, r) => sum + r.changePct, 0) / peers.length;
  }, [chartRow, allRows]);

  const getLivePx = (base: string) => livePrice(`${base}USDT`)?.price;

  if (state.loading && !state.data) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--muted)', fontSize: 13 }}>
        Building signals… fetching volume profiles (~15s on first load)
      </div>
    );
  }

  if (state.error && !state.data) {
    return <div style={{ padding: 16, color: '#f87171', fontSize: 12 }}>Signals unavailable: {state.error}</div>;
  }

  const data = state.data;

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['both', 'bullish', 'bearish'] as const).map((s) => (
              <button key={s} type="button" onClick={() => setSideFilter(s)} style={{
                padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                cursor: 'pointer', border: 'none',
                background: sideFilter === s
                  ? (s === 'bullish' ? '#3fd487' : s === 'bearish' ? '#f87171' : 'var(--panel-2)')
                  : 'var(--panel)',
                color: sideFilter === s ? (s === 'both' ? 'var(--text)' : '#000') : 'var(--muted)',
              }}>
                {s === 'both' ? 'Both' : s === 'bullish' ? '▲ Bullish' : '▼ Bearish'}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <span style={{ color: 'var(--muted)' }}>Min score</span>
            <input type="range" min={0} max={80} step={5} value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))} style={{ width: 80 }} />
            <span style={{ fontFamily: 'monospace', color: scoreColor(minScore), minWidth: 24 }}>{minScore}</span>
          </div>
          {data && (
            <span style={{ fontSize: 10, color: 'var(--faint)', marginLeft: 'auto' }}>
              {bullish.length}↑ {bearish.length}↓ · {data.regime.replace(/_/g, ' ')} · breadth {data.breadthBias}
              {data.blackedOut && <span style={{ color: '#f59e0b', marginLeft: 6 }}>⚠ BLACKOUT</span>}
            </span>
          )}
        </div>

        {data?.gex && (data.gex.btc || data.gex.eth) && (
          <div style={{ display: 'flex', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
            {data.gex.btc && <GexPanel gex={data.gex.btc} />}
            {data.gex.eth && <GexPanel gex={data.gex.eth} />}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 10, paddingBottom: 16 }}>
            {sideFilter !== 'bearish' && bullish.map((row) => (
              <SignalCard
                key={`${row.base}-bull`}
                row={row}
                livePx={getLivePx(row.base)}
                onOpen={setChartFor}
                calibration={mindHealth.data?.calibration ?? null}
                regimeEvidence={mindHealth.data?.regimeEvidence ?? []}
              />
            ))}
            {sideFilter !== 'bullish' && bearish.map((row) => (
              <SignalCard
                key={`${row.base}-bear`}
                row={row}
                livePx={getLivePx(row.base)}
                onOpen={setChartFor}
                calibration={mindHealth.data?.calibration ?? null}
                regimeEvidence={mindHealth.data?.regimeEvidence ?? []}
              />
            ))}
            {bullish.length === 0 && bearish.length === 0 && (
              <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 12 }}>
                No signals above score {minScore}. Lower the threshold or wait for the next scan.
              </div>
            )}
          </div>
        </div>

        <div style={{ fontSize: 9, color: 'var(--faint)', flexShrink: 0, paddingTop: 4, borderTop: '1px solid var(--border)' }}>
          Confluence = structure + volume profile + order flow + positioning + news. Not investment advice. Refreshes every 60s.
        </div>
      </div>

      {chartFor && (
        <AssetPopup
          assetId={chartFor}
          row={chartRow}
          breadthBias={(state.data?.breadthBias ?? 'two-way') as 'bullish' | 'bearish' | 'two-way'}
          sectorAvgChange={sectorAvg}
          volumeProfile={chartRow?.volumeProfile ?? null}
          onClose={() => setChartFor(null)}
        />
      )}
    </>
  );
}
