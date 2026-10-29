import type { AssetRow, Side } from '../../shared/types';

/**
 * Order-block flow — derived reads for the rebuilt page.
 *
 * Everything here is computed from fields the scan already carries (price,
 * % change, the setup ladder and the Binance-futures derivatives row). Nothing
 * is invented: when an input is missing the caller renders a dash, never a
 * fabricated number — that is house rule 2.
 */

/** Rows shown per side in the source list / river / matrix. */
export const PER_SIDE = 20;

/** How the 20 rows per side split across the four mini-card columns. */
export const MATRIX = { tiny: 8, small: 4, medium: 4, tall: 4 } as const;

export type BuildUp =
  | 'LONG BUILD-UP'
  | 'SHORT BUILD-UP'
  | 'SHORT COVER'
  | 'LONG UNWIND'
  | 'FLAT';

export type BuildUpTone = 'long' | 'short' | 'warn';

/**
 * OI change over the last hour, in %, straight from the derivatives row.
 * Falls back to the 4h window only when the 1h window is genuinely absent.
 */
export function oiH1(row: AssetRow): number | null {
  const oi = row.derivatives?.oiChange;
  if (!oi) return null;
  if (typeof oi.h1 === 'number') return oi.h1;
  if (typeof oi.h4 === 'number') return oi.h4;
  if (typeof oi.m5 === 'number') return oi.m5;
  return null;
}

/**
 * LONG BUILD-UP  = price up   and OI up.
 * SHORT BUILD-UP = price down and OI up.
 * SHORT COVER / LONG UNWIND = OI falling (positions closing, weaker).
 * A row with no derivatives feed reads FLAT, not a guess.
 */
export function buildUp(row: AssetRow): BuildUp {
  const oi = oiH1(row);
  if (oi === null) return 'FLAT';
  const up = row.changePct >= 0;
  if (oi >= 0.1) return up ? 'LONG BUILD-UP' : 'SHORT BUILD-UP';
  if (oi <= -0.1) return up ? 'SHORT COVER' : 'LONG UNWIND';
  return 'FLAT';
}

export function buildUpTone(b: BuildUp): BuildUpTone {
  if (b === 'LONG BUILD-UP') return 'long';
  if (b === 'SHORT BUILD-UP') return 'short';
  return 'warn';
}

/** Short badge text for the compact tiles. */
export function buildUpShort(b: BuildUp): string {
  switch (b) {
    case 'LONG BUILD-UP': return 'LONG';
    case 'SHORT BUILD-UP': return 'SHORT';
    case 'SHORT COVER': return 'COVER';
    case 'LONG UNWIND': return 'UNWIND';
    default: return 'FLAT';
  }
}

/**
 * Ring score 0-100 = weighted mix of momentum, OI change and proximity to the
 * order-block zone. Weights are normalised over whichever inputs are present,
 * so a missing derivatives feed cannot silently drag the score to zero.
 */
export function flowScore(row: AssetRow): number {
  const momentum = Math.min(100, (Math.abs(row.changePct) / 8) * 100);
  const oi = oiH1(row);
  const oiScore = oi === null ? null : Math.min(100, (Math.abs(oi) / 3) * 100);
  const s = row.setup;
  const prox =
    s && row.price > 0
      ? Math.max(0, 100 - (Math.abs(row.price - s.z) / s.z) * 100 * 8)
      : null;

  let num = momentum * 0.45;
  let den = 0.45;
  if (oiScore !== null) {
    num += oiScore * 0.3;
    den += 0.3;
  }
  if (prox !== null) {
    num += prox * 0.25;
    den += 0.25;
  }
  return Math.round(den > 0 ? num / den : 0);
}

export interface Ladder {
  s1: number | null;
  r1: number | null;
  r2: number | null;
  zoneLow: number | null;
  zoneHigh: number | null;
  z: number | null;
  rr: number;
  /** |Z - invalidation| — the price distance the idea is proven wrong over. */
  risk: number;
  /** Distance from the live price to the invalidation, in %. */
  riskPct: number | null;
}

/** The S1 / ZONE / R1 / R2 footer ladder, mapped consistently for both sides. */
export function ladder(row: AssetRow, price?: number): Ladder {
  const s = row.setup;
  const px = price ?? row.price;
  if (!s) {
    return { s1: null, r1: null, r2: null, zoneLow: null, zoneHigh: null, z: null, rr: 0, risk: 0, riskPct: null };
  }
  const t0 = s.targets[0]?.price ?? null;
  const t1 = s.targets[1]?.price ?? null;
  const risk = Math.abs(s.z - s.invalidation);
  const riskPct = px > 0 ? (Math.abs(px - s.invalidation) / px) * 100 : null;
  if (row.side === 'bullish') {
    return { s1: s.invalidation, r1: t0, r2: t1, zoneLow: s.obLow, zoneHigh: s.obHigh, z: s.z, rr: s.rr, risk, riskPct };
  }
  return { s1: t0, r1: s.invalidation, r2: t1, zoneLow: s.obLow, zoneHigh: s.obHigh, z: s.z, rr: s.rr, risk, riskPct };
}

export interface Profile {
  bins: number[];
  /** 'depth' = real Binance-futures book walls; 'path' = distribution of closes. */
  source: 'depth' | 'path';
  max: number;
}

/**
 * Liquidity / price profile for the mini-cards.
 *
 * Prefers the real futures depth walls (USD per price level). When the book
 * snapshot is missing it falls back to the distribution of the session's own
 * closes, and the tile labels which one it is showing.
 */
export function profileBars(row: AssetRow, n = 14): Profile {
  const walls = row.derivatives?.depth?.walls ?? [];
  if (walls.length >= 3) {
    const prices = walls.map((w) => w.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || 1;
    const bins = new Array<number>(n).fill(0);
    for (const w of walls) {
      const i = Math.min(n - 1, Math.max(0, Math.floor(((w.price - min) / span) * n)));
      bins[i] += w.usd;
    }
    return { bins, source: 'depth', max: Math.max(...bins) || 1 };
  }

  const spark = row.spark;
  if (spark.length >= 3) {
    const min = Math.min(...spark);
    const max = Math.max(...spark);
    const span = max - min || 1;
    const bins = new Array<number>(n).fill(0);
    for (const v of spark) {
      const i = Math.min(n - 1, Math.max(0, Math.floor(((v - min) / span) * n)));
      bins[i] += 1;
    }
    return { bins, source: 'path', max: Math.max(...bins) || 1 };
  }

  return { bins: new Array<number>(n).fill(0), source: 'path', max: 1 };
}

/** Normalise a side's |% change| into 0..1 for thread weight / speed. */
export function normChange(rows: AssetRow[], row: AssetRow): number {
  const max = Math.max(0.01, ...rows.map((r) => Math.abs(r.changePct)));
  return Math.min(1, Math.abs(row.changePct) / max);
}

export function sideOf(row: AssetRow): Side {
  return row.side;
}

/** Levels for the detail chart, in draw order. */
export interface ChartLevel {
  price: number;
  label: string;
  tone: 'zone' | 'level';
}

export function chartLevels(row: AssetRow): ChartLevel[] {
  const l = ladder(row);
  const out: ChartLevel[] = [];
  if (l.zoneLow !== null && l.zoneHigh !== null) {
    out.push({ price: l.zoneLow, label: 'ZONE', tone: 'zone' });
    out.push({ price: l.zoneHigh, label: 'ZONE', tone: 'zone' });
  }
  const push = (price: number | null, label: string) => {
    if (price !== null && Number.isFinite(price)) out.push({ price, label, tone: 'level' });
  };
  push(l.r2, 'R2');
  push(l.r1, 'R1');
  push(l.s1, 'S1');
  return out;
}
