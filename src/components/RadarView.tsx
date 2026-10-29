import { useMemo, useRef, useEffect, useState } from 'react';
import type { DerivRow, Setup, TradePlan } from '../../shared/types';
import { usePolling } from '../lib/api';
import { livePrice } from '../lib/liveContext';
import { AssetPopup } from './AssetPopup';

interface VolumeProfile { poc: number; vah: number; val: number; }
interface DirVote {
  label: string;
  vote: 'bull' | 'bear' | 'neutral';
  weight: number;
}
/**
 * `/api/radar` rows. `setup`, `plan` and `derivatives` are the engine's own
 * types - declared here rather than copied out field by field, so this row can
 * be handed straight to `AssetPopup` (it used to be opened with `row={null}`,
 * which threw away the signal's own VWAP).
 *
 * There is no `side` and no `rank` here and there never will be: the radar
 * scans the whole universe independently of the scan board, so a signal may not
 * be on the board at all. `AssetPopup` marks those two points "not measured"
 * instead of scoring them as failures.
 */
interface PreMoveSignal {
  base: string; symbol: string; displayTicker: string;
  logoUrl: string | null; sector: string;
  price: number; changePct: number;
  preMoveScore: number; signals: string[];
  estimatedDirection: 'bullish' | 'bearish' | 'unclear';
  directionConfidence: number;
  dirVotes: DirVote[];
  timeframeMinutes: number;
  volumeProfile: VolumeProfile | null;
  setup: Setup | null; plan: TradePlan | null;
  derivatives: DerivRow | null;
  squeeze: boolean;
  takerRatio: number | null;
  vwap: number | null;
  trend1h: 'up' | 'down' | 'range';
  updatedAt: number;
}
interface RadarResponse {
  updatedAt: number; signals: PreMoveSignal[];
  regime: string; breadthBias: string;
}

const ALL_SIGNAL_LABELS = [
  'OI Accumulation', 'CVD Divergence', 'DOM Imbalance', 'Funding Flip',
  'Volume Profile Coil', 'Choppiness Dropping', 'Relative Strength',
];

function fmtPx(v: number): string {
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: v >= 1 ? 2 : 4 })}`;
}
function scoreColor(s: number): string {
  if (s >= 70) return '#3fd487';
  if (s >= 50) return '#eab308';
  return '#f87171';
}

function ScoreRing({ score }: { score: number }) {
  const r = 20; const circ = 2 * Math.PI * r;
  const fill = (score / 100) * circ;
  const color = scoreColor(score);
  return (
    <svg width={48} height={48} viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
      <circle cx={24} cy={24} r={r} fill="none" stroke="var(--panel-2)" strokeWidth={4} />
      <circle cx={24} cy={24} r={r} fill="none" stroke={color} strokeWidth={4}
        strokeDasharray={`${fill} ${circ - fill}`} strokeLinecap="round"
        transform="rotate(-90 24 24)" />
      <text x={24} y={28} textAnchor="middle" fontSize={12} fontWeight={700}
        fill={color} fontFamily="monospace">{score}</text>
    </svg>
  );
}

function DirectionBanner({ dir, confidence }: { dir: 'bullish' | 'bearish' | 'unclear'; confidence: number }) {
  const cfg = {
    bullish: {
      arrow: '▲', label: 'BULLISH', sub: 'Signals point UP',
      color: '#3fd487', bg: 'rgba(63,212,135,0.13)', border: 'rgba(63,212,135,0.35)',
    },
    bearish: {
      arrow: '▼', label: 'BEARISH', sub: 'Signals point DOWN',
      color: '#f87171', bg: 'rgba(248,113,113,0.13)', border: 'rgba(248,113,113,0.35)',
    },
    unclear: {
      arrow: '◆', label: 'UNCLEAR', sub: 'Mixed signals',
      color: '#eab308', bg: 'rgba(234,179,8,0.10)', border: 'rgba(234,179,8,0.3)',
    },
  }[dir];

  return (
    <div style={{
      borderRadius: 8, padding: '8px 12px',
      background: cfg.bg, border: `1px solid ${cfg.border}`,
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <span style={{ fontSize: 28, lineHeight: 1, color: cfg.color }}>{cfg.arrow}</span>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: cfg.color, letterSpacing: '0.04em' }}>
            {cfg.label}
          </span>
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>{cfg.sub}</span>
        </div>
        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'var(--panel-2)', overflow: 'hidden' }}>
            <div style={{
              width: `${confidence}%`, height: '100%',
              background: cfg.color, borderRadius: 3, transition: 'width 0.4s',
            }} />
          </div>
          <span style={{ fontSize: 10, fontFamily: 'monospace', color: cfg.color, minWidth: 36 }}>
            {confidence}% conf
          </span>
        </div>
      </div>
    </div>
  );
}

function VoteRow({ votes }: { votes: DirVote[] }) {
  const active = votes.filter((v) => v.vote !== 'neutral');
  if (!active.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {active.map((v) => (
        <span key={v.label} style={{
          fontSize: 9, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
          color: v.vote === 'bull' ? '#3fd487' : '#f87171',
          background: v.vote === 'bull' ? 'rgba(63,212,135,0.1)' : 'rgba(248,113,113,0.1)',
          border: `1px solid ${v.vote === 'bull' ? 'rgba(63,212,135,0.25)' : 'rgba(248,113,113,0.25)'}`,
        }}>
          {v.vote === 'bull' ? '▲' : '▼'} {v.label}
        </span>
      ))}
    </div>
  );
}

function VpMini({ vp, price }: { vp: VolumeProfile; price: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const W = 40; const H = 64;
    cv.width = W * 2; cv.height = H * 2;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.scale(2, 2); ctx.clearRect(0, 0, W, H);
    const range = vp.vah - vp.val || 1;
    const pocY = H - ((vp.poc - vp.val) / range) * H;
    const vahY = H - ((vp.vah - vp.val) / range) * H;
    const priceY = Math.max(0, Math.min(H, H - ((price - vp.val) / range) * H));
    ctx.fillStyle = 'rgba(99,179,237,0.15)';
    ctx.fillRect(0, vahY, W, H - vahY);
    ctx.strokeStyle = '#eab308'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, pocY); ctx.lineTo(W, pocY); ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(0, priceY); ctx.lineTo(W, priceY); ctx.stroke();
    ctx.setLineDash([]);
  }, [vp, price]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <canvas ref={ref} style={{ width: 40, height: 64, borderRadius: 3 }} />
      <span style={{ fontSize: 8, color: 'var(--faint)', fontFamily: 'monospace' }}>POC {fmtPx(vp.poc)}</span>
    </div>
  );
}

function RadarCard({ sig, livePx, onOpen }: {
  sig: PreMoveSignal; livePx?: number; onOpen: (base: string) => void;
}) {
  const px = livePx ?? sig.price;
  const p = sig.plan;
  const dirColor = sig.estimatedDirection === 'bullish' ? '#3fd487'
    : sig.estimatedDirection === 'bearish' ? '#f87171' : '#eab308';

  return (
    <div
      role="button" tabIndex={0}
      onClick={() => onOpen(sig.base)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(sig.base)}
      style={{
        borderRadius: 10, padding: '10px 12px',
        border: `1px solid ${sig.preMoveScore >= 70 ? dirColor : 'var(--border)'}`,
        background: 'var(--panel)',
        boxShadow: sig.preMoveScore >= 70 ? `0 0 16px ${dirColor}1a` : 'none',
        display: 'flex', flexDirection: 'column', gap: 8, cursor: 'pointer',
      }}
    >
      {/* Top row: logo + name + score ring */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {sig.logoUrl && (
          <img src={sig.logoUrl} alt="" style={{ width: 26, height: 26, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{sig.displayTicker}</span>
            <span style={{ fontSize: 10, color: 'var(--muted)' }}>{sig.sector}</span>
            {sig.squeeze && (
              <span style={{ fontSize: 9, fontWeight: 700, color: '#a78bfa', background: 'rgba(167,139,250,0.12)', padding: '1px 5px', borderRadius: 4 }}>
                SQUEEZE
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, fontSize: 11, fontFamily: 'monospace', marginTop: 2 }}>
            <span style={{ fontWeight: 600 }}>{fmtPx(px)}</span>
            <span style={{ color: sig.changePct >= 0 ? '#3fd487' : '#f87171' }}>
              {sig.changePct >= 0 ? '+' : ''}{sig.changePct.toFixed(2)}%
            </span>
            {sig.vwap && (
              <span style={{ color: px > sig.vwap ? '#3fd487' : '#f87171', fontSize: 10 }}>
                {px > sig.vwap ? '↑' : '↓'} VWAP
              </span>
            )}
          </div>
        </div>
        <ScoreRing score={sig.preMoveScore} />
      </div>

      {/* BIG direction banner */}
      <DirectionBanner dir={sig.estimatedDirection} confidence={sig.directionConfidence} />

      {/* Vote pills */}
      <VoteRow votes={sig.dirVotes} />

      {/* Signal checklist */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px' }}>
        {ALL_SIGNAL_LABELS.map((label) => {
          const fired = sig.signals.includes(label);
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
              <span style={{ color: fired ? '#3fd487' : 'var(--faint)', fontSize: 11 }}>{fired ? '✓' : '○'}</span>
              <span style={{ color: fired ? 'var(--text)' : 'var(--faint)' }}>{label}</span>
            </div>
          );
        })}
      </div>

      {/* Extra indicators row */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {sig.takerRatio !== null && (
          <div style={{ fontSize: 10, fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: 'var(--faint)' }}>Taker</span>
            <div style={{ width: 48, height: 5, borderRadius: 3, background: 'var(--panel-2)', overflow: 'hidden' }}>
              <div style={{
                width: `${sig.takerRatio * 100}%`, height: '100%', borderRadius: 3,
                background: sig.takerRatio > 0.55 ? '#3fd487' : sig.takerRatio < 0.45 ? '#f87171' : '#eab308',
              }} />
            </div>
            <span style={{ color: sig.takerRatio > 0.55 ? '#3fd487' : sig.takerRatio < 0.45 ? '#f87171' : 'var(--muted)' }}>
              {(sig.takerRatio * 100).toFixed(0)}%
            </span>
          </div>
        )}
        <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--faint)' }}>
          1h: <span style={{ color: sig.trend1h === 'up' ? '#3fd487' : sig.trend1h === 'down' ? '#f87171' : 'var(--muted)' }}>
            {sig.trend1h === 'up' ? '▲ up' : sig.trend1h === 'down' ? '▼ down' : '— range'}
          </span>
        </div>
        {sig.derivatives && (
          <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--faint)' }}>
            OI h1: <span style={{ color: sig.derivatives.oiChange.h1 > 0 ? '#3fd487' : '#f87171' }}>
              {sig.derivatives.oiChange.h1 > 0 ? '+' : ''}{sig.derivatives.oiChange.h1.toFixed(1)}%
            </span>
          </div>
        )}
      </div>

      {/* VP mini + entry plan */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {sig.volumeProfile && <VpMini vp={sig.volumeProfile} price={px} />}
        {p && (
          <div style={{ flex: 1, fontSize: 10, fontFamily: 'monospace', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ color: 'var(--muted)', fontSize: 9, fontWeight: 600, letterSpacing: '0.05em' }}>ENTRY PLAN</div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--faint)' }}>Zone</span>
              <span style={{ color: dirColor }}>{fmtPx(p.entryLow)}–{fmtPx(p.entryHigh)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--faint)' }}>Stop</span>
              <span style={{ color: '#f87171' }}>{fmtPx(p.stop)}</span>
            </div>
            {p.targets.slice(0, 2).map((t) => (
              <div key={t.label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--faint)' }}>{t.label}</span>
                <span style={{ color: '#60a5fa' }}>{fmtPx(t.price)} <span style={{ color: 'var(--faint)' }}>({t.rr.toFixed(1)}R)</span></span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ flex: 1, height: 3, borderRadius: 2, background: 'var(--panel-2)', overflow: 'hidden' }}>
          <div style={{
            width: `${(sig.signals.length / ALL_SIGNAL_LABELS.length) * 100}%`,
            height: '100%', background: scoreColor(sig.preMoveScore),
            borderRadius: 2, transition: 'width 0.3s',
          }} />
        </div>
        <span style={{ fontSize: 9, color: 'var(--faint)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
          {sig.signals.length}/{ALL_SIGNAL_LABELS.length} signals
        </span>
        <span style={{ fontSize: 9, color: 'var(--faint)' }}>↗ chart</span>
      </div>
    </div>
  );
}

export function RadarView() {
  const [minScore, setMinScore] = useState(40);
  const [dirFilter, setDirFilter] = useState<'all' | 'bullish' | 'bearish'>('all');
  const [chartFor, setChartFor] = useState<string | null>(null);

  const state = usePolling<RadarResponse>(
    (s) => fetch('/api/radar', { signal: s }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<RadarResponse>;
    }),
    60_000,
  );

  const filtered = useMemo(() => {
    const sigs = state.data?.signals ?? [];
    return sigs
      .filter((s) => s.preMoveScore >= minScore)
      .filter((s) => dirFilter === 'all' || s.estimatedDirection === dirFilter)
      .sort((a, b) => b.preMoveScore - a.preMoveScore);
  }, [state.data, minScore, dirFilter]);

  const chartSig = useMemo(() => filtered.find((s) => s.base === chartFor) ?? null, [filtered, chartFor]);
  const getLivePx = (base: string) => livePrice(`${base}USDT`)?.price;

  const bullCount = useMemo(() => filtered.filter((s) => s.estimatedDirection === 'bullish').length, [filtered]);
  const bearCount = useMemo(() => filtered.filter((s) => s.estimatedDirection === 'bearish').length, [filtered]);

  if (state.loading && !state.data) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--muted)', fontSize: 13 }}>
        Scanning universe for pre-move signals… (~30s on first load)
      </div>
    );
  }
  if (state.error && !state.data) {
    return <div style={{ padding: 16, color: '#f87171', fontSize: 12 }}>Radar unavailable: {state.error}</div>;
  }

  const data = state.data;

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', overflow: 'hidden' }}>

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['all', 'bullish', 'bearish'] as const).map((d) => (
              <button key={d} type="button" onClick={() => setDirFilter(d)} style={{
                padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                cursor: 'pointer', border: 'none',
                background: dirFilter === d
                  ? (d === 'bullish' ? '#3fd487' : d === 'bearish' ? '#f87171' : 'var(--panel-2)')
                  : 'var(--panel)',
                color: dirFilter === d ? (d === 'all' ? 'var(--text)' : '#000') : 'var(--muted)',
              }}>
                {d === 'all' ? 'All' : d === 'bullish' ? '▲ Bull' : '▼ Bear'}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <span style={{ color: 'var(--muted)' }}>Min score</span>
            <input type="range" min={0} max={70} step={5} value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))} style={{ width: 80 }} />
            <span style={{ fontFamily: 'monospace', color: scoreColor(minScore), minWidth: 24 }}>{minScore}</span>
          </div>
          {data && (
            <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: '#3fd487', fontFamily: 'monospace' }}>▲ {bullCount} bull</span>
              <span style={{ fontSize: 10, color: '#f87171', fontFamily: 'monospace' }}>▼ {bearCount} bear</span>
              <span style={{ fontSize: 10, color: 'var(--faint)' }}>{data.regime.replace(/_/g, ' ')}</span>
            </div>
          )}
        </div>

        {/* Disclaimer */}
        <div style={{
          fontSize: 10, color: 'var(--faint)', padding: '5px 10px', borderRadius: 6,
          background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)', flexShrink: 0,
        }}>
          ⚠ Pre-move detection — signals fire BEFORE price moves. Direction confidence uses 8 independent votes
          (HTF trend, CVD, OI, DOM, taker ratio, VWAP, vs BTC, funding). Not investment advice.
        </div>

        {/* Cards */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 10, paddingBottom: 16 }}>
            {filtered.map((sig) => (
              <RadarCard key={sig.base} sig={sig} livePx={getLivePx(sig.base)} onOpen={setChartFor} />
            ))}
            {filtered.length === 0 && (
              <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 12 }}>
                No coins above score {minScore}{dirFilter !== 'all' ? ` with ${dirFilter} direction` : ''}.
                <br />
                <span style={{ color: 'var(--faint)', fontSize: 11 }}>Lower the threshold or wait for the next scan.</span>
              </div>
            )}
          </div>
        </div>

        <div style={{ fontSize: 9, color: 'var(--faint)', flexShrink: 0, paddingTop: 4, borderTop: '1px solid var(--border)' }}>
          Score = OI accumulation + CVD divergence + DOM + funding flip + VP coil + choppiness + relative strength.
          Direction = weighted vote of 8 signals. Refreshes every 60s.
        </div>
      </div>

      {chartFor && (
        <AssetPopup
          assetId={chartFor}
          row={chartSig}
          breadthBias={(data?.breadthBias ?? 'two-way') as 'bullish' | 'bearish' | 'two-way'}
          sectorAvgChange={null}
          volumeProfile={chartSig?.volumeProfile ?? null}
          onClose={() => setChartFor(null)}
        />
      )}
    </>
  );
}
