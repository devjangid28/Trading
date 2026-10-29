import type { TerminalInterval } from '../../../shared/types';
import { INTERVAL_MS } from '../math';
import { buildCandleFromRows } from './aggregate';
import { DEFAULT_FOOTPRINT_SETTINGS } from './settings';
import type {
  FootprintAnnotation, FootprintCandle, FootprintDataset, FootprintLevel, FootprintLiqEvent,
  FootprintNotable, PreparedFootprintRow,
} from './types';

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const K = 1_000;
const M = 1_000_000;
const ROW_SIZE = 25;
export const MOCK_ROW_SIZE = ROW_SIZE;

interface CandleSpec {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  rows: number;
  hidden?: boolean;
  quietOverride?: boolean;
  exactRows?: Array<[number, number]>;
  hot?: Array<{ index: number; side: 'bid' | 'ask'; usd: number }>;
  notable?: Array<{ index: number; side: 'bid' | 'ask'; usd: number; label: string }>;
  buyImbalances?: number;
  sellImbalances?: number;
  pocPrice?: number;
}

/**
 * The reference composition. The row values for 14:30 are literal; the other
 * candles are deterministic but distributed so their summary figures land on
 * the numbers the view is specified against.
 */
const SPECS: CandleSpec[] = [
  {
    open: 80_110, high: 80_140, low: 80_090, close: 80_125,
    volume: 5.0 * M, delta: 1.394 * M, rows: 6, hidden: true,
  },
  {
    open: 80_290, high: 80_375, low: 80_050, close: 80_245,
    volume: 13.244 * M, delta: 4.87 * M, rows: 13,
    pocPrice: 80_237.5,
    exactRows: [
      [89 * K, 202 * K],
      [302 * K, 1_300 * K],
      [577 * K, 1_520 * K],
      [439 * K, 865 * K],
      [181 * K, 373 * K],
      [895 * K, 1_830 * K],
      [54 * K, 326 * K],
      [23 * K, 310 * K],
      [397 * K, 545 * K],
      [549 * K, 779 * K],
      [260 * K, 630 * K],
      [346 * K, 284 * K],
      [73 * K, 95 * K],
    ],
  },
  {
    open: 80_245, high: 80_270, low: 80_130, close: 80_230,
    volume: 7.53 * M, delta: 2.086 * M, rows: 6,
  },
  {
    open: 80_230, high: 80_250, low: 80_110, close: 80_170,
    volume: 5.76 * M, delta: 589 * K, rows: 6,
  },
  {
    open: 80_170, high: 80_180, low: 80_010, close: 80_055,
    volume: 7.60 * M, delta: -1.334 * M, rows: 8,
  },
  {
    open: 80_055, high: 80_120, low: 80_020, close: 80_100,
    volume: 8.96 * M, delta: 132 * K, rows: 6,
  },
  {
    open: 80_100, high: 80_200, low: 80_085, close: 80_180,
    volume: 5.66 * M, delta: 1.36 * M, rows: 6,
  },
  {
    open: 80_180, high: 80_320, low: 80_160, close: 80_290,
    volume: 14.3 * M, delta: 3.47 * M, rows: 7,
    hot: [
      { index: 2, side: 'bid', usd: 2.09 * M },
      { index: 3, side: 'bid', usd: 1.28 * M },
      { index: 3, side: 'ask', usd: 2.52 * M },
      { index: 4, side: 'ask', usd: 2.33 * M },
    ],
  },
  {
    open: 80_290, high: 80_360, low: 80_230, close: 80_340,
    volume: 8.15 * M, delta: 3.48 * M, rows: 6,
  },
  {
    open: 80_340, high: 80_390, low: 80_220, close: 80_370,
    volume: 9.07 * M, delta: 4.55 * M, rows: 8,
  },
  {
    open: 80_370, high: 80_380, low: 80_250, close: 80_300,
    volume: 7.33 * M, delta: -463 * K, rows: 6,
  },
  {
    open: 80_300, high: 80_305, low: 79_990, close: 80_142.42,
    volume: 3.76 * M, delta: -300 * K, rows: 13,
    quietOverride: true,
    buyImbalances: 3,
    sellImbalances: 4,
    pocPrice: 80_142.5,
    exactRows: [
      [45 * K, 55 * K],
      [70 * K, 80 * K],
      [105 * K, 100 * K],
      [140 * K, 135 * K],
      [180 * K, 160 * K],
      [229_792, 200_208],
      [460 * K, 430 * K],
      [240 * K, 130 * K],
      [205 * K, 165 * K],
      [170 * K, 110 * K],
      [95 * K, 95 * K],
      [55 * K, 45 * K],
      [35 * K, 25 * K],
    ],
    notable: [
      { index: 6, side: 'ask', usd: 430 * K, label: 'large buy print' },
    ],
  },
];

function spreadToTotals(
  weights: number[],
  total: number,
  fixed: Map<number, number> = new Map(),
): number[] {
  const out = new Array(weights.length).fill(0);
  let remaining = Math.max(0, Math.round(total));
  for (const [index, value] of fixed) {
    if (index < 0 || index >= out.length) continue;
    out[index] = Math.max(0, Math.round(value));
    remaining -= out[index];
  }
  const free = out.map((_, index) => index).filter((index) => !fixed.has(index));
  if (remaining <= 0 || free.length === 0) return out;
  const sum = free.reduce((value, index) => value + Math.max(0, weights[index]), 0) || free.length;
  let left = remaining;
  for (let i = 0; i < free.length; i++) {
    const index = free[i];
    if (i === free.length - 1) {
      out[index] = Math.max(0, left);
      break;
    }
    const share = Math.round((remaining * Math.max(0, weights[index])) / sum);
    const value = Math.min(left, Math.max(0, share));
    out[index] = value;
    left -= value;
  }
  return out;
}

function makeRows(spec: CandleSpec, random: () => number): Array<{ price: number; bid: number; ask: number }> {
  const top = spec.high - ROW_SIZE / 2;
  const count = Math.max(3, spec.rows);
  const askTotal = Math.max(1, (spec.volume + spec.delta) / 2);
  const bidTotal = Math.max(1, (spec.volume - spec.delta) / 2);
  const askWeights: number[] = [];
  const bidWeights: number[] = [];
  for (let i = 0; i < count; i++) {
    const centre = (count - 1) / 2;
    const bell = 1.1 - Math.abs(i - centre) / Math.max(1, count);
    askWeights.push(Math.max(0.08, bell * (0.45 + random() * 1.3)));
    bidWeights.push(Math.max(0.08, bell * (0.45 + random() * 1.3)));
  }
  const fixedAsk = new Map<number, number>();
  const fixedBid = new Map<number, number>();
  for (const hot of spec.hot ?? []) {
    if (hot.index >= count) continue;
    if (hot.side === 'ask') fixedAsk.set(hot.index, hot.usd);
    else fixedBid.set(hot.index, hot.usd);
  }
  const asks = spreadToTotals(askWeights, askTotal, fixedAsk);
  const bids = spreadToTotals(bidWeights, bidTotal, fixedBid);
  return Array.from({ length: count }, (_, i) => ({
    price: top - i * ROW_SIZE,
    bid: bids[i],
    ask: asks[i],
  }));
}

function exactRows(spec: CandleSpec): Array<{ price: number; bid: number; ask: number }> {
  const top = spec.high - ROW_SIZE / 2;
  return (spec.exactRows ?? []).map(([bid, ask], i) => ({
    price: top - i * ROW_SIZE,
    bid,
    ask,
  }));
}

function toPrepared(rows: Array<{ price: number; bid: number; ask: number }>): PreparedFootprintRow[] {
  return rows.map((row) => ({ price: row.price, bidUsd: row.bid, askUsd: row.ask }));
}

function buildOptions() {
  return {
    intervalMs: INTERVAL_MS['15m'],
    rowSize: ROW_SIZE,
    baseTick: 0.5,
    imbalanceRatio: DEFAULT_FOOTPRINT_SETTINGS.imbalanceRatio,
    minVolumeUsd: DEFAULT_FOOTPRINT_SETTINGS.minVolumeUsd,
    imbalanceMode: DEFAULT_FOOTPRINT_SETTINGS.imbalanceMode,
    valueAreaPct: DEFAULT_FOOTPRINT_SETTINGS.valueAreaPct,
  };
}

function buildMainCandles(symbol: string, interval: TerminalInterval, lastOpen: number): FootprintCandle[] {
  const step = INTERVAL_MS[interval];
  const random = rng(hash(`${symbol}:footprint:${lastOpen}`));
  const candles: FootprintCandle[] = [];
  for (let i = 0; i < SPECS.length; i++) {
    const spec = SPECS[i];
    const t = lastOpen - (SPECS.length - 1 - i) * step;
    const rows = spec.exactRows ? exactRows(spec) : makeRows(spec, random);
    const notable: FootprintNotable[] | undefined = spec.notable?.map((marker) => ({
      id: `${t}:${rows[marker.index]?.price ?? 0}:${marker.side}`,
      price: rows[marker.index]?.price ?? spec.close,
      side: marker.side,
      usd: marker.usd,
      label: marker.label,
    }));
    const candle = buildCandleFromRows({
      t,
      o: spec.open,
      h: spec.high,
      l: spec.low,
      c: spec.close,
      closed: i < SPECS.length - 1,
      rows: toPrepared(rows),
      quietOverride: spec.quietOverride,
      pocPrice: spec.pocPrice,
      buyImbalanceRows: spec.buyImbalances,
      sellImbalanceRows: spec.sellImbalances,
      notable,
    }, { ...buildOptions(), intervalMs: step, rowSize: ROW_SIZE });
    candle.hidden = spec.hidden === true;
    candles.push(candle);
  }
  return candles;
}

function buildOlderCandles(
  symbol: string,
  interval: TerminalInterval,
  firstOpen: number,
  count: number,
): FootprintCandle[] {
  if (count <= 0) return [];
  const step = INTERVAL_MS[interval];
  const random = rng(hash(`${symbol}:older:${firstOpen}:${count}`));
  const out: FootprintCandle[] = [];
  let close = 80_110;
  for (let i = count; i >= 1; i--) {
    const t = firstOpen - i * step;
    const drift = (random() - 0.48) * 90;
    const open = close;
    close = Math.max(79_700, Math.min(80_500, open + drift));
    const high = Math.max(open, close) + 20 + random() * 45;
    const low = Math.min(open, close) - 20 - random() * 45;
    const volume = (4.5 + random() * 8.5) * M;
    const delta = (random() - 0.47) * volume * 0.7;
    const spec: CandleSpec = {
      open, high, low, close, volume, delta,
      rows: 5 + Math.floor(random() * 7),
    };
    const rows = makeRows(spec, random);
    out.push(buildCandleFromRows({
      t,
      o: open,
      h: high,
      l: low,
      c: close,
      closed: true,
      rows: toPrepared(rows),
    }, { ...buildOptions(), intervalMs: step, rowSize: ROW_SIZE }));
  }
  return out;
}

function mockLevels(): FootprintLevel[] {
  return [
    {
      id: 'user-1', price: 80_683.23, label: '\u2605 my level 80683.23', kind: 'user',
      color: 'rgba(229,231,235,0.75)', textColor: '#e5e7eb', dash: [12, 6], width: 1.5,
      axisTag: true, removable: true,
    },
    {
      id: 'prev-val', price: 80_780.00, label: 'prev day VAL (est.) 80780.00', kind: 'prev-val',
      color: 'rgba(45,212,191,0.65)', textColor: '#2dd4bf', dash: [6, 4], width: 1, axisTag: true,
    },
    {
      id: 'prev-vah', price: 80_920.00, label: 'prev day VAH (est.) 80920.00', kind: 'prev-vah',
      color: 'rgba(45,212,191,0.65)', textColor: '#2dd4bf', dash: [6, 4], width: 1, axisTag: false,
    },
    {
      id: 'prev-high', price: 81_240.00, label: 'prev day high 81240.00', kind: 'prev-high',
      color: 'rgba(45,212,191,0.65)', textColor: '#2dd4bf', dash: [6, 4], width: 1, axisTag: false,
    },
    {
      id: 'gamma-call', price: 81_050.00, label: '\u0393 call 81050.00', kind: 'gamma',
      color: 'rgba(148,163,184,0.4)', textColor: '#94a3b8', dash: [4, 5], width: 1, axisTag: false,
    },
    {
      id: 'gamma-put', price: 81_150.00, label: '\u0393 put 81150.00', kind: 'gamma',
      color: 'rgba(148,163,184,0.4)', textColor: '#94a3b8', dash: [4, 5], width: 1, axisTag: false,
    },
    {
      id: 'gamma-pin', price: 80_850.00, label: '\u0393 pin 80850.00', kind: 'gamma',
      color: 'rgba(148,163,184,0.4)', textColor: '#94a3b8', dash: [4, 5], width: 1, axisTag: false,
    },
    {
      id: 'prev-low', price: 80_397.14, label: 'prev day low 80397.14', kind: 'prev-low',
      color: 'rgba(45,212,191,0.7)', textColor: '#2dd4bf', dash: [6, 4], width: 1, axisTag: true,
    },
    {
      id: 'plan-buy', price: 80_210.00, label: 'buy above 80210.00', kind: 'plan-buy',
      color: 'rgba(74,222,128,0.55)', textColor: '#4ade80', dash: [2, 3], width: 1, axisTag: true,
    },
    {
      id: 'plan-sell', price: 80_065.00, label: 'sell below 80065.00', kind: 'plan-sell',
      color: 'rgba(248,113,113,0.55)', textColor: '#f87171', dash: [2, 3], width: 1, axisTag: true,
    },
    {
      id: 'liq-long', price: 73_371.67, label: '\u26a1 longs liquidate 73371.67', kind: 'liq-long',
      color: 'rgba(192,132,252,0.6)', textColor: '#c084fc', dash: [4, 4], width: 1, axisTag: true,
    },
  ];
}

function mockAnnotations(candles: readonly FootprintCandle[]): FootprintAnnotation[] {
  const at = (index: number): number => candles[Math.max(0, candles.length - 12 + index)]?.t ?? candles[0]?.t ?? 0;
  return [
    {
      id: 'ua-high-1', kind: 'ua-high', price: 80_374.42, label: 'UA high 80374.42',
      fromT: at(9), color: '#c9b458',
    },
    {
      id: 'ua-high-2', kind: 'ua-high', price: 80_312.92, label: 'UA high 80312.92',
      fromT: at(7), color: '#c9b458',
    },
    {
      id: 'npoc-1', kind: 'npoc', price: 80_337.50, label: 'nPOC 80337.50',
      fromT: at(8), color: '#facc15',
    },
    {
      id: 'ua-high-3', kind: 'ua-high', price: 80_260.71, label: 'UA high 80260.71',
      fromT: at(2), color: '#c9b458',
    },
    {
      id: 'ua-low-1', kind: 'ua-low', price: 80_116.18, label: 'UA low 80116.18',
      fromT: at(3), color: '#c9b458',
    },
    {
      id: 'ua-low-2', kind: 'ua-low', price: 80_047.61, label: 'UA low 80047.61',
      fromT: at(4), color: '#c9b458',
    },
  ];
}

function mockLiquidations(candles: readonly FootprintCandle[]): { events: FootprintLiqEvent[]; recordStart: number } {
  const last = candles[candles.length - 1]?.t ?? 0;
  const step = INTERVAL_MS['15m'];
  const openAt = (offset: number): number => last - offset * step;
  return {
    recordStart: openAt(8) + 8 * 60_000,
    events: [
      { id: 'rekt-1', t: openAt(7) + 5 * 60_000, price: 80_332.10, usd: 14 * K, side: 'short' },
      { id: 'rekt-2', t: openAt(4) + 5 * 60_000, price: 80_344.20, usd: 11 * K, side: 'short' },
      { id: 'rekt-3', t: openAt(2) + 10 * 60_000, price: 80_368.20, usd: 241, side: 'short' },
    ],
  };
}

export interface MockFootprint extends FootprintDataset {
  hiddenVolumeIndex: number;
}

/**
 * Deterministic reference data. It is explicitly marked as mock and is never
 * merged into a live tape.
 */
export function buildMockFootprint(
  symbol: string,
  interval: TerminalInterval = '15m',
  olderCount = 0,
  now = Date.now(),
): MockFootprint {
  const date = new Date(now);
  const baseOpen = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    8,
    45,
  );
  const step = INTERVAL_MS[interval];
  const lastOpen = baseOpen + 11 * INTERVAL_MS['15m'];
  const main = buildMainCandles(symbol, interval, lastOpen);
  const firstOpen = main[0]?.t ?? baseOpen;
  const older = buildOlderCandles(symbol, interval, firstOpen, olderCount);
  const candles = [...older, ...main];
  let cumulative = 0;
  let cumulativeQty = 0;
  for (const candle of candles) {
    cumulative += candle.deltaUsd;
    cumulativeQty += candle.deltaQty;
    candle.cumDeltaUsd = cumulative;
    candle.cumDeltaQty = cumulativeQty;
  }
  const { events, recordStart } = mockLiquidations(main);
  const lastPrice = 80_142.42;
  return {
    symbol,
    interval,
    rowSize: ROW_SIZE,
    baseTick: 0.5,
    candles,
    from: candles[0]?.t ?? null,
    to: candles.length ? candles[candles.length - 1].t + step : null,
    lastPrice,
    levels: mockLevels(),
    annotations: mockAnnotations(main),
    liqEvents: events,
    recordStart,
    source: 'mock',
    mock: true,
    hiddenVolumeIndex: older.length ? -1 : 0,
  };
}

export const MOCK_INTERVAL_FALLBACK: TerminalInterval = '15m';
