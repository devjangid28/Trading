import type { AssetRow, Grade, LiqEvent, Side } from '../../shared/types';
import { percentile } from './heatmap';

export interface GexStrike {
  strike: number;
  callOi: number;
  putOi: number;
  netGex: number;
}

/** Mirrors the server's `/api/gex` payload. */
export interface GexSnapshot {
  symbol: 'BTC' | 'ETH';
  price: number;
  maxPainStrike: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  totalNetGex: number;
  dealersShortGamma: boolean;
  strikes: GexStrike[];
  asOf: number;
}

export interface GammaResponse {
  btc: GexSnapshot | null;
  eth: GexSnapshot | null;
}

export type LevelKind = 'plan-buy' | 'plan-sell' | 'plan-target' | 'plan-stop'
  | 'gamma-call' | 'gamma-put' | 'gamma-zero' | 'gamma-pin'
  | 'liq-long' | 'liq-short' | 'user';

export interface LevelLine {
  kind: LevelKind;
  price: number;
  label: string;
  color: string;
  dash: number[];
  width: number;
}

export type TerminalSignal = 'BUY' | 'SELL' | 'WAIT';

export interface PlanContext {
  symbol: string;
  side: Side | null;
  grade: Grade | null;
  entry: number | null;
  stop: number | null;
  buyAbove: number | null;
  sellBelow: number | null;
  targets: number[];
  rr: number;
  signal: TerminalSignal;
  /** The state machine's latest verdict, shown in the rail and decision panel. */
  state: string;
  reason: string;
  hasSetup: boolean;
}

export function emptyPlan(symbol = ''): PlanContext {
  return {
    symbol,
    side: null,
    grade: null,
    entry: null,
    stop: null,
    buyAbove: null,
    sellBelow: null,
    targets: [],
    rr: 0,
    signal: 'WAIT',
    state: 'NO SETUP',
    reason: 'No reviewed setup for this market — the lines come from the live book only.',
    hasSetup: false,
  };
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function signalFor(side: Side | null, price: number | null, buyAbove: number | null, sellBelow: number | null): TerminalSignal {
  if (!side || price === null || price <= 0) return 'WAIT';
  if (side === 'bullish') {
    return buyAbove !== null && price >= buyAbove ? 'BUY' : 'WAIT';
  }
  return sellBelow !== null && price <= sellBelow ? 'SELL' : 'WAIT';
}

/**
 * The terminal draws the engine's own plan, never a re-derived one. When there
 * is no plan the fields stay null and the UI says so in words.
 */
export function buildPlanContext(row: AssetRow | null | undefined, price: number | null): PlanContext {
  if (!row) return emptyPlan();
  const setup = row.setup;
  const plan = row.plan;

  if (!setup && !plan) {
    return {
      ...emptyPlan(row.base),
      symbol: row.base,
      grade: row.conviction?.grade ?? null,
      side: row.side,
      state: row.conviction
        ? `${row.conviction.grade.replaceAll('_', ' ')} · ${row.conviction.rule.replaceAll('_', ' ').toLowerCase()}`
        : 'NO SETUP',
      reason: 'No reviewed setup for this market — the lines come from the live book only.',
    };
  }

  const side: Side = plan?.side ?? setup?.side ?? row.side;
  const entry = finite(plan?.entryMid) ?? finite(setup?.z);
  const stop = finite(plan?.stop) ?? finite(setup?.invalidation);
  const buyAbove = side === 'bullish' ? entry : stop;
  const sellBelow = side === 'bearish' ? entry : stop;
  const targets = plan?.targets?.length
    ? plan.targets.map((t) => t.price).filter((p) => Number.isFinite(p) && p > 0)
    : (setup?.targets ?? []).map((t) => t.price).filter((p) => Number.isFinite(p) && p > 0);
  const rr = plan?.rr ?? setup?.rr ?? 0;
  const retest = setup ? setup.retest : 'no-zone';
  const invalid = Boolean(setup?.violated);
  const signal = invalid ? 'WAIT' : signalFor(side, price, buyAbove, sellBelow);
  const state = invalid ? 'INVALIDATED' : signal === 'WAIT' ? `WAIT · ${retest}` : `${signal} · ${retest}`;
  const targetText = targets.length ? ` · target ${targets[0].toFixed(2)}` : '';
  const reason = `${side === 'bullish' ? 'Long' : 'Short'} ${row.base} · ${retest}`
    + ` · entry ${entry?.toFixed(2) ?? '—'}`
    + ` · stop ${stop?.toFixed(2) ?? '—'}`
    + ` · R:R ${rr > 0 ? rr.toFixed(2) : '—'}`
    + targetText
    + (invalid ? ' · setup violated' : '');

  return {
    symbol: row.base,
    side,
    grade: row.conviction?.grade ?? null,
    entry,
    stop,
    buyAbove,
    sellBelow,
    targets,
    rr,
    signal,
    state,
    reason,
    hasSetup: true,
  };
}

function pushLine(out: LevelLine[], line: LevelLine, priceMin: number, priceMax: number): void {
  if (!Number.isFinite(line.price) || line.price <= 0) return;
  if (line.price < priceMin || line.price > priceMax) return;
  out.push(line);
}

export function planLines(plan: PlanContext, priceMin: number, priceMax: number): LevelLine[] {
  const out: LevelLine[] = [];
  if (!plan.hasSetup) return out;
  if (plan.buyAbove !== null) {
    pushLine(out, {
      kind: 'plan-buy',
      price: plan.buyAbove,
      label: `buy above ${plan.buyAbove.toFixed(2)}`,
      color: '#4ade80',
      dash: [2, 5],
      width: 1,
    }, priceMin, priceMax);
  }
  if (plan.sellBelow !== null) {
    pushLine(out, {
      kind: 'plan-sell',
      price: plan.sellBelow,
      label: `sell below ${plan.sellBelow.toFixed(2)}`,
      color: '#f87171',
      dash: [2, 5],
      width: 1,
    }, priceMin, priceMax);
  }
  for (const target of plan.targets.slice(0, 3)) {
    pushLine(out, {
      kind: 'plan-target',
      price: target,
      label: `target ${target.toFixed(2)}`,
      color: 'rgba(74,222,128,0.5)',
      dash: [1, 7],
      width: 1,
    }, priceMin, priceMax);
  }
  if (plan.stop !== null) {
    pushLine(out, {
      kind: 'plan-stop',
      price: plan.stop,
      label: `stop ${plan.stop.toFixed(2)}`,
      color: 'rgba(248,113,113,0.45)',
      dash: [1, 7],
      width: 1,
    }, priceMin, priceMax);
  }
  return out;
}

export function gammaLines(snapshot: GexSnapshot | null, priceMin: number, priceMax: number): LevelLine[] {
  const out: LevelLine[] = [];
  if (!snapshot) return out;
  pushLine(out, {
    kind: 'gamma-call',
    price: snapshot.callWall,
    label: `call wall ${snapshot.callWall.toLocaleString('en-US')}`,
    color: 'rgba(56,189,248,0.7)',
    dash: [5, 5],
    width: 1,
  }, priceMin, priceMax);
  pushLine(out, {
    kind: 'gamma-put',
    price: snapshot.putWall,
    label: `put wall ${snapshot.putWall.toLocaleString('en-US')}`,
    color: 'rgba(251,146,60,0.7)',
    dash: [5, 5],
    width: 1,
  }, priceMin, priceMax);
  pushLine(out, {
    kind: 'gamma-zero',
    price: snapshot.zeroGamma,
    label: `\u0393 flip ${snapshot.zeroGamma.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    color: 'rgba(167,139,250,0.6)',
    dash: [8, 4],
    width: 1,
  }, priceMin, priceMax);
  pushLine(out, {
    kind: 'gamma-pin',
    price: snapshot.maxPainStrike,
    label: `pin ${snapshot.maxPainStrike.toLocaleString('en-US')}`,
    color: 'rgba(229,231,235,0.45)',
    dash: [1, 3],
    width: 1,
  }, priceMin, priceMax);
  return out;
}

export interface LiqCluster {
  side: 'long' | 'short';
  price: number;
  usd: number;
  count: number;
}

/**
 * Group the sampled force-order prints into price clusters. This is a LOWER
 * BOUND: Binance sends at most one liquidation per symbol per second, so the
 * cluster total is the sum of what the stream delivered, not the market's.
 */
export function liqClusters(events: readonly LiqEvent[], mid: number | null, binPct = 0.0004): LiqCluster[] {
  if (!events.length) return [];
  const reference = mid && mid > 0 ? mid : events[0].price;
  if (!(reference > 0)) return [];
  const bin = Math.max(reference * binPct, 1e-12);
  const grouped = new Map<string, LiqCluster>();
  for (const e of events) {
    if (!(e.usd > 0) || !(e.price > 0)) continue;
    const key = `${e.side}:${Math.round(e.price / bin)}`;
    const cluster = grouped.get(key) ?? {
      side: e.side === 'SELL' ? 'long' : 'short',
      price: 0,
      usd: 0,
      count: 0,
    };
    cluster.price += e.price * e.usd;
    cluster.usd += e.usd;
    cluster.count += 1;
    grouped.set(key, cluster);
  }
  return [...grouped.values()]
    .map((c) => ({ ...c, price: c.price / Math.max(1e-12, c.usd) }))
    .sort((a, b) => b.usd - a.usd);
}

export function liqLines(clusters: readonly LiqCluster[], priceMin: number, priceMax: number, limit = 3): LevelLine[] {
  // Use a high percentile as a floor only when there is a real distribution;
  // a single print is labelled by its own size.
  const reference = clusters.length >= 3
    ? percentile(clusters.map((c) => c.usd), 0.6)
    : 0;
  const out: LevelLine[] = [];
  for (const c of clusters.slice(0, limit)) {
    if (c.usd < reference) continue;
    pushLine(out, {
      kind: c.side === 'long' ? 'liq-long' : 'liq-short',
      price: c.price,
      label: `${c.side === 'long' ? 'long' : 'short'} liq ${c.usd >= 1e6 ? `$${(c.usd / 1e6).toFixed(1)}M` : `$${(c.usd / 1e3).toFixed(0)}K`} (lower bound)`,
      color: c.side === 'long' ? 'rgba(251,191,36,0.6)' : 'rgba(251,146,60,0.6)',
      dash: [4, 4],
      width: 1,
    }, priceMin, priceMax);
  }
  return out;
}

export function userLines(levels: readonly number[], priceMin: number, priceMax: number): LevelLine[] {
  const out: LevelLine[] = [];
  for (const price of levels) {
    pushLine(out, {
      kind: 'user',
      price,
      label: '\u2605 my level',
      color: 'rgba(229,231,235,0.7)',
      dash: [4, 3],
      width: 1,
    }, priceMin, priceMax);
  }
  return out;
}

export const USER_LEVELS_KEY = 'orderflow.heatmap.levels.v1';

type LevelStore = Record<string, number[]>;

function readStore(storage: Storage | null): LevelStore {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(USER_LEVELS_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: LevelStore = {};
    for (const [symbol, levels] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(levels)) continue;
      const clean = levels
        .filter((p): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0)
        .slice(0, 40);
      if (clean.length) out[symbol] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadUserLevels(symbol: string, storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): number[] {
  return readStore(storage)[symbol.toUpperCase()] ?? [];
}

export function saveUserLevels(symbol: string, levels: readonly number[], storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  if (!storage) return;
  try {
    const store = readStore(storage);
    const key = symbol.toUpperCase();
    const clean = levels.filter((p) => Number.isFinite(p) && p > 0).slice(0, 40);
    if (clean.length) store[key] = clean;
    else delete store[key];
    storage.setItem(USER_LEVELS_KEY, JSON.stringify(store));
  } catch {
    // Storage is optional; a full quota must not break the chart.
  }
}

export function toggleUserLevel(symbol: string, price: number, current: readonly number[]): number[] {
  const quantum = price >= 1000 ? 0.01 : price >= 1 ? 0.0001 : 1e-6;
  const snapped = Math.round(price / quantum) * quantum;
  const exists = current.some((p) => Math.abs(p - snapped) < quantum / 2);
  const next = exists
    ? current.filter((p) => Math.abs(p - snapped) >= quantum / 2)
    : [...current, snapped].sort((a, b) => a - b);
  saveUserLevels(symbol, next);
  return next;
}
