import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AssetRow, PickRule } from '../../shared/types';
import { fmtPct, fmtPrice, istClock, istStamp } from '../lib/format';
import { useLivePrice } from '../lib/priceStore';
import { CoinAvatar } from './CoinAvatar';
import {
  POPUP_FADE_MS, POPUP_SLIDE_PX, POPUP_WIDTH_PX,
} from './motion';

/**
 * `PickRule` is a string union, not an object (see shared/types.ts). Turning it
 * into something readable is a display concern, so it lives here rather than in
 * the engine â€” and it never invents a reason the engine did not give.
 */
function ruleLabel(rule: PickRule | undefined): string {
  if (!rule) return 'â€”';
  if (rule === 'PICK') return 'PICK';
  return rule
    .replace(/^NOT_PICKED_/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * The hover preview.
 *
 * PLACEMENT
 *
 * Positioned over the seam between the two board columns and top-aligned near
 * the hovered row, then clamped inside the viewport. The flip logic matters
 * more than it looks: a popup that renders off the bottom edge on the last row
 * of a list is worse than no popup, because the user cannot tell whether the
 * page or the popup is broken.
 *
 * It is rendered in a fixed-position layer and takes no space in flow, so
 * opening it cannot shift the layout (C2, asserted by the layout tests as
 * cumulative layout shift 0).
 */

export interface PopupPlacement {
  left: number;
  top: number;
  /** True when it had to flip to stay on screen. */
  flipped: boolean;
}

const MARGIN = 12;
const ESTIMATED_HEIGHT = 520;

export function computePlacement(
  anchor: DOMRect,
  viewport: { w: number; h: number },
  popupW = POPUP_WIDTH_PX,
  popupH = ESTIMATED_HEIGHT,
): PopupPlacement {
  // Centred over the seam between the two columns.
  const seamX = window.innerWidth / 2;
  let left = seamX - popupW / 2;

  // Clamp horizontally.
  left = Math.max(MARGIN, Math.min(left, viewport.w - popupW - MARGIN));

  // Top-align near the hovered row, but never let the top go off screen.
  let top = anchor.top - 12;
  let flipped = false;
  if (top + popupH > viewport.h - MARGIN) {
    const below = anchor.bottom + 12;
    if (below + popupH <= viewport.h - MARGIN) {
      top = below;
      flipped = true;
    } else {
      // Neither above nor below fits: pin to the bottom and let the card
      // scroll internally rather than disappearing off the edge.
      top = Math.max(MARGIN, viewport.h - popupH - MARGIN);
      flipped = true;
    }
  }

  return { left, top: Math.max(MARGIN, top), flipped };
}

export interface RowPreviewProps {
  /** True when a click has pinned the popup open. */
  pinned?: boolean;
  row: AssetRow | null;
  /** Element the popup is anchored to. */
  anchor: HTMLElement | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onOpenFull?: (row: AssetRow) => void;
  onAddToJournal?: (row: AssetRow) => void;
}

export function RowPreview({
  row, anchor, onClose, onPrev, onNext, onOpenFull, onAddToJournal,
}: RowPreviewProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<PopupPlacement | null>(null);
  const [entered, setEntered] = useState(false);

  // The popup used to show the frozen snapshot price from the scan row. It now
  // subscribes to the same tick store the rows use, so it moves while it is
  // open (the acceptance check: "the popup price changes while open").
  const live = useLivePrice(row?.symbol);

  useLayoutEffect(() => {
    if (!row || !anchor) { setPlacement(null); return; }
    const compute = () => {
      const h = cardRef.current?.offsetHeight ?? ESTIMATED_HEIGHT;
      setPlacement(computePlacement(anchor.getBoundingClientRect(), { w: window.innerWidth, h: window.innerHeight }, POPUP_WIDTH_PX, h));
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [row, anchor]);

  useEffect(() => {
    if (!row) return;
    // Next frame, so the enter transition actually runs.
    const id = requestAnimationFrame(() => setEntered(true));
    return () => { cancelAnimationFrame(id); setEntered(false); };
  }, [row]);

  // Esc closes. Left/right step between coins (C1, INFERRED).
  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); onPrev?.(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); onNext?.(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [row, onClose, onPrev, onNext]);

  if (!row) return null;

  const bull = row.side === 'bullish';
  const accent = bull ? 'var(--color-up)' : 'var(--color-down)';
  // Live tick wins; the scan snapshot is the fallback until the first tick.
  const price = live?.price ?? row.price;
  const changePct = live?.changePct ?? row.changePct;
  const ticker = row.displayTicker || row.base;
  const name = row.displayName ?? row.name ?? 'name unavailable';
  const s = row.setup;
  const d = row.derivatives;

  const stats = [
    { k: 'RANK', v: `p${row.percentile.toFixed(1)} Â· #${row.rank}`, side: 'left' },
    // Real fields on DerivRow: oiChange.d1 (not oiChangePct24h) and cvd (not
    // cvdUsd). Read from shared/types rather than guessed.
    { k: 'OI', v: d ? `${d.oiChange.d1 >= 0 ? '+' : ''}${(d.oiChange.d1 * 100).toFixed(2)}% 24h` : 'â€”', side: 'left' },
    { k: 'VWAP', v: row.vwap
      ? `${fmtPrice(row.vwap)} · ${price >= row.vwap ? 'above' : 'below'}`
      : 'â€”', side: 'left' },
    { k: bull ? 'Z / S1' : 'Z / R1', v: s ? `${fmtPrice(s.z)} / ${fmtPrice(s.invalidation)}` : 'â€”', side: 'left' },
    { k: 'R:R', v: row.plan && row.plan.rr > 0 ? `${row.plan.rr.toFixed(2)}` : 'â€”', side: 'left' },
    { k: 'CONV', v: row.conviction ? `${row.conviction.grade} Â· ${row.conviction.score.toFixed(1)}` : 'â€”', side: 'right' },
    { k: 'DELTA', v: d
      ? `${d.cvd >= 0 ? '+' : 'âˆ’'}$${Math.abs(d.cvd).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : 'â€”', side: 'right' },
    { k: 'OB', v: s ? `${fmtPrice(s.obLow)}â€“${fmtPrice(s.obHigh)}` : 'â€”', side: 'right' },
    { k: bull ? 'R1 / R2' : 'S1 / S2', v: s && s.targets.length
      ? `${fmtPrice(s.targets[0].price)}${s.targets[1] ? ` / ${fmtPrice(s.targets[1].price)}` : ''}`
      : 'â€”', side: 'right' },
    { k: 'RULE', v: row.conviction?.vetoes?.[0] ?? ruleLabel(row.conviction?.rule), side: 'right' },
  ];

  return (
    <div
      ref={cardRef}
      className={`of-popup ${bull ? 'is-bull' : 'is-bear'} ${entered ? 'is-in' : ''}`}
      data-testid="row-preview"
      data-ticker={ticker}
      role="dialog"
      aria-modal="false"
      aria-label={`${ticker} preview`}
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        width: POPUP_WIDTH_PX,
        opacity: entered ? 1 : 0,
        transform: entered ? 'translateY(0)' : `translateY(${POPUP_SLIDE_PX}px)`,
        transitionDuration: `${POPUP_FADE_MS}ms`,
        ['--popup-accent' as string]: accent,
      }}
    >
      <header className="of-popup-h">
        <CoinAvatar ticker={ticker} logoUrl={row.logoUrl} side={row.side} size={38} />
        <span className="of-popup-id">
          <b>{ticker}</b>
          <em>{name} Â· {row.sector}</em>
        </span>
        <DayPath row={row} />
      </header>

      <div className="of-popup-price">
        <b data-testid="preview-price">{fmtPrice(price)}</b>
        <span className={changePct >= 0 ? 'up' : 'dn'}>
          {fmtPct(changePct)} · {changePct >= 0 ? '+' : '−'}
          {fmtPrice(Math.abs(price - price / (1 + changePct / 100)))}
        </span>
      </div>

      <div className="of-popup-stats" data-testid="preview-stats">
        {stats.filter((x) => x.side === 'left').map((x) => (
          <Fragment key={`l${x.k}`}>
            <Stat k={x.k} v={x.v} />
            {/* Grid ignores whitespace-only text nodes, but textContent keeps
                the stats apart: "aboveZ / S1" would hide the Z/S1 boundary. */}
            {' '}
          </Fragment>
        ))}
        {stats.filter((x) => x.side === 'right').map((x) => (
          <Fragment key={`r${x.k}`}>
            <Stat k={x.k} v={x.v} />
            {' '}
          </Fragment>
        ))}
      </div>

      <div className="of-popup-chart" data-testid="preview-chart">
        <MiniSetupChart row={row} />
      </div>

      <footer className="of-popup-f">
        <button type="button" onClick={() => onOpenFull?.(row)}>Open full view</button>
        <button type="button" onClick={() => onAddToJournal?.(row)}>Add to journal</button>
        <span className="of-popup-nav">
          <button type="button" aria-label="Previous coin" onClick={() => onPrev?.()}>â€¹</button>
          <button type="button" aria-label="Next coin" onClick={() => onNext?.()}>â€º</button>
        </span>
      </footer>

      <span className="of-popup-asof" data-testid="preview-asof">
        {live ? `live tick · ${istClock(live.at)} IST` : `as of ${istStamp(row.updatedAt)} IST (snapshot)`}
      </span>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="of-stat" data-testid={`stat-${k.replace(/[^A-Z]/g, '')}`}>
      {/* The space keeps the label and value separate in textContent as well
          as on screen, so "Z / S1" never reads as "Z / S10.8683" to a reader
          or a test. */}
      <span>{k}</span>{' '}
      <b title={v}>{v}</b>
    </div>
  );
}

function DayPath({ row }: { row: AssetRow }) {
  const pts = row.spark.length >= 2 ? row.spark : [row.price];
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const d = pts
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (pts.length - 1)) * 60},${18 - ((v - min) / span) * 16}`)
    .join(' ');
  return (
    <svg className="of-daypath" width="64" height="20" viewBox="0 0 60 20" aria-hidden="true">
      <path d={d} fill="none" strokeWidth="1.4" stroke="currentColor" />
      <circle cx="60" cy={18 - ((pts[pts.length - 1] - min) / span) * 16} r="2.2" fill="currentColor" />
    </svg>
  );
}

/**
 * Compact setup chart: candles, the OB box, level lines, VWAP and a now-dot.
 *
 * Deliberately simplified relative to the full CandleChart â€” the popup has to
 * render in under a frame on hover, and the full chart's timeframes, context
 * levels and crosshair are all wasted at this size.
 */
function MiniSetupChart({ row }: { row: AssetRow }) {
  const s = row.setup;
  const spark = row.spark;
  const bull = row.side === 'bullish';
  const levels = useMemo<{ price: number; label: string; tone: 'accent' | 'amber' | 'violet' }[]>(() => {
    const out: { price: number; label: string; tone: 'accent' | 'amber' | 'violet' }[] = [];
    if (!s) return out;
    out.push({ price: s.z, label: 'Z', tone: 'accent' });
    out.push({ price: s.invalidation, label: bull ? 'S1' : 'R1', tone: 'accent' });
    s.targets.slice(0, 2).forEach((t, i) => {
      out.push({ price: t.price, label: bull ? `R${i + 1}` : `S${i + 1}`, tone: 'amber' });
    });
    s.context.slice(0, 3).forEach((c) => out.push({ price: c.price, label: '', tone: 'amber' }));
    if (row.vwap) out.push({ price: row.vwap, label: '', tone: 'violet' });
    return out.filter((l) => Number.isFinite(l.price));
  }, [s, row.vwap, bull]);

  const prices = [row.price, ...levels.map((l) => l.price), ...(s ? [s.obLow, s.obHigh] : [])];
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  const pad = (max - min) * 0.12 || max * 0.01 || 1;
  min -= pad;
  max += pad;

  const W = 470;
  const H = 290;
  const y = (p: number) => H - 18 - ((p - min) / (max - min)) * (H - 40);
  const pts = spark.length >= 2 ? spark : [row.price];
  const path = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (pts.length - 1)) * W},${y(v)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="of-mini-chart" role="img" aria-label={`${row.displayTicker || row.base} setup chart`}>
      <rect className="mc-bg" x="0" y="0" width={W} height={H} rx="8" />

      {s && (
        <g data-testid="ob-box">
          <rect className="mc-ob" x="0" y={y(Math.max(s.obHigh, s.obLow))}
            width={W} height={Math.abs(y(s.obLow) - y(s.obHigh))}
            fill="var(--color-up)" opacity="0.12" />
          <line className="mc-ob-edge" x1="0" x2={W} y1={y(s.obHigh)} y2={y(s.obHigh)} />
          <line className="mc-ob-edge" x1="0" x2={W} y1={y(s.obLow)} y2={y(s.obLow)} />
          <text className="mc-lbl" x="6" y={y(s.obHigh) - 4}>OB</text>
          <line className="mc-z" x1="0" x2={W} y1={y(s.z)} y2={y(s.z)} />
          <text className="mc-lbl" x="6" y={y(s.z) - 4}>Z</text>
        </g>
      )}

      {levels.filter((l) => l.tone !== 'accent' || l.label === 'S1' || l.label === 'R1').map((l, i) => (
        <g key={`lv${i}${l.price}`}>
          <line
            className={`mc-lv ${l.tone}`}
            x1="0" x2={W} y1={y(l.price)} y2={y(l.price)}
            strokeDasharray={l.tone === 'violet' ? '2 4' : '5 4'}
          />
          {l.label && <text className="mc-lbl" x={W - 6} y={y(l.price) - 3} textAnchor="end">{l.label}</text>}
        </g>
      ))}

      <path className="mc-price" d={path} fill="none" strokeWidth="1.5" />

      <line className="mc-now" x1={W - 8} x2={W - 8} y1="6" y2={H - 16} strokeDasharray="2 3" />
      <circle className="mc-nowdot" cx={W - 8} cy={y(row.price)} r="3.4" />
    </svg>
  );
}
