import type { TerminalSpan } from '../../shared/types';
import { TERMINAL_SPANS } from '../../shared/types';

/**
 * Columns to the right of the chart. Order in this list is the order the
 * checklist renders; the user's saved array is the order they are drawn.
 * "Book" is one column that draws the two sub-columns bid $ and ask $.
 */
export const COLUMN_KEYS = [
  'delta', 'book', 'tape', 'cob', 'superdom', 'size', 'cum', 'volume', 'svp', 'cdelta', 'cqc',
] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

export const COLUMN_LABEL: Record<ColumnKey, string> = {
  delta: '\u0394',
  book: 'Book',
  tape: 'Tape',
  cob: 'COB',
  superdom: 'SuperDOM',
  size: 'Size $',
  cum: 'Cumulative $',
  volume: 'Volume',
  svp: 'SVP',
  cdelta: 'Cumulative \u0394',
  cqc: 'CQC',
};

export const COLUMN_NAME: Record<ColumnKey, string> = {
  delta: 'Delta',
  book: 'Book',
  tape: 'Tape',
  cob: 'COB',
  superdom: 'SuperDOM',
  size: 'Size $',
  cum: 'Cumulative $',
  volume: 'Volume',
  svp: 'SVP',
  cdelta: 'Cumulative \u0394',
  cqc: 'CQC',
};

export const COLUMN_DESCRIPTION: Record<ColumnKey, string> = {
  delta: 'Bought \u2212 sold at each price: which side was aggressive',
  book: 'Live resting bid and ask sizes as coloured bars and numbers',
  tape: 'Time & sales: the newest orders on top, buyers green, sellers red',
  cob: 'Current order book: resting size at each price as bars',
  superdom: 'A trading-terminal ladder: sold | bid | price | ask | bought',
  size: 'Resting size at each price, in dollars',
  cum: 'Resting size added up from the spread outward',
  volume: 'Traded at each price: bought green, sold red',
  svp: 'Session volume profile: traded at each price since the session started',
  cdelta: 'Delta added up from the current price outward',
  cqc: 'Quotes counter: how many times the resting size at a price has been refreshed',
};

export const DEFAULT_COLUMNS: ColumnKey[] = ['delta', 'book', 'tape'];

export interface ColumnPreset {
  name: string;
  columns: ColumnKey[];
}

export const COLUMN_PRESETS: ColumnPreset[] = [
  { name: 'Book + tape', columns: ['book', 'tape'] },
  { name: 'SuperDOM + tape', columns: ['superdom', 'tape'] },
  { name: 'Depth ladder', columns: ['cob', 'cum', 'size'] },
  { name: 'Delta + tape', columns: ['delta', 'tape'] },
  { name: 'Order flow', columns: ['delta', 'volume', 'tape'] },
  { name: 'COB + SVP + CQC', columns: ['cob', 'svp', 'cqc'] },
  { name: 'Everything', columns: [...COLUMN_KEYS] },
];

export type RangeKey = 'auto' | '0.1' | '0.25' | '0.5' | '1';
export const RANGE_PCT: Record<Exclude<RangeKey, 'auto'>, number> = {
  '0.1': 0.001,
  '0.25': 0.0025,
  '0.5': 0.005,
  '1': 0.01,
};
export const RANGE_KEYS: RangeKey[] = ['auto', '0.1', '0.25', '0.5', '1'];

export type Contrast = 'low' | 'med' | 'high';
export const CONTRAST_GAIN: Record<Contrast, number> = { low: 0.55, med: 1, high: 1.55 };
export const CONTRAST_KEYS: Contrast[] = ['low', 'med', 'high'];

export type BubbleMode = 'auto' | 'trades' | 'steps' | 'off';
export const BUBBLE_KEYS: BubbleMode[] = ['auto', 'trades', 'steps', 'off'];

export type BubbleSize = 's' | 'm' | 'l';
export const BUBBLE_SIZE_KEYS: BubbleSize[] = ['s', 'm', 'l'];
export const BUBBLE_SCALE: Record<BubbleSize, number> = { s: 0.75, m: 1, l: 1.3 };
export const BUBBLE_SIZE_LABEL: Record<BubbleSize, string> = { s: 'S', m: 'M', l: 'L' };

export type BubbleFloor = 'all' | 'top50' | 'top20' | '10k' | '100k';
export const BUBBLE_FLOOR_KEYS: BubbleFloor[] = ['all', 'top50', 'top20', '10k', '100k'];
export const BUBBLE_FLOOR_LABEL: Record<BubbleFloor, string> = {
  all: 'All',
  top50: 'Top 50%',
  top20: 'Top 20%',
  '10k': '$10K+',
  '100k': '$100K+',
};
export const BUBBLE_FLOOR_PCT: Partial<Record<BubbleFloor, number>> = { top50: 0.5, top20: 0.8 };
export const BUBBLE_FLOOR_USD: Partial<Record<BubbleFloor, number>> = { '10k': 10_000, '100k': 100_000 };

export type StepMode = 'auto' | '1s' | '5s' | '15s' | '1m';
export const STEP_KEYS: StepMode[] = ['auto', '1s', '5s', '15s', '1m'];

export type TapeMin = 'auto' | 'all' | '1k' | '10k' | '100k';
export const TAPE_MIN_KEYS: TapeMin[] = ['auto', 'all', '1k', '10k', '100k'];
export const TAPE_MIN_LABEL: Record<TapeMin, string> = {
  auto: 'Auto',
  all: 'All',
  '1k': '$1K+',
  '10k': '$10K+',
  '100k': '$100K+',
};
export function tapeMinUsd(mode: TapeMin): number {
  if (mode === 'all') return 0;
  if (mode === '1k') return 1_000;
  if (mode === '10k') return 10_000;
  if (mode === '100k') return 100_000;
  return -1;
}

export type VolumeOver = 'span' | 'session';
export const VOLUME_OVER_KEYS: VolumeOver[] = ['span', 'session'];
export type SizeUnit = 'usd' | 'coin';
export const SIZE_UNIT_KEYS: SizeUnit[] = ['usd', 'coin'];

/** [TUNED] A resting level must clear this before it may be called a wall. */
export const MIN_WALL_USD = 50_000;
/** [TUNED] The reading line and wall labels search this far around mid (0.1%). */
export const WALL_NEAR_PCT = 0.001;
/** [TUNED] A pull only counts as "nearby" inside this trailing window. */
export const PULL_WINDOW_MS = 5 * 60_000;
/** [TUNED] Default resolution of a rendered heatmap cell in CSS pixels. */
export const DEFAULT_ROW_PX = 6;
/** [TUNED] Ladder rows in the right-hand columns. */
export const LADDER_ROW_PX = 19;

export interface HeatmapSettings {
  span: TerminalSpan;
  range: RangeKey;
  contrast: Contrast;
  bubbles: BubbleMode;
  bubbleSize: BubbleSize;
  bubbleFloor: BubbleFloor;
  columns: ColumnKey[];
  rowPx: number;
  minLiquidityUsd: number;
  showVolume: boolean;
  stepMode: StepMode;
  cvdStrip: boolean;
  volumeOver: VolumeOver;
  sizeUnit: SizeUnit;
  tapeMin: TapeMin;
  showCandles: boolean;
  /** Legacy controls kept for the older LiquidityHeatmap page. */
  opacity: number;
  bubbleScale: number;
  minTradeUsd: number;
}

export const DEFAULT_SETTINGS: HeatmapSettings = {
  span: '15m',
  range: 'auto',
  contrast: 'med',
  bubbles: 'auto',
  bubbleSize: 'm',
  bubbleFloor: 'top20',
  columns: DEFAULT_COLUMNS,
  rowPx: DEFAULT_ROW_PX,
  minLiquidityUsd: 0,
  showVolume: true,
  stepMode: 'auto',
  cvdStrip: false,
  volumeOver: 'span',
  sizeUnit: 'usd',
  tapeMin: 'auto',
  showCandles: false,
  opacity: 0.96,
  bubbleScale: 1,
  minTradeUsd: 0,
};

export const SETTINGS_KEY = 'orderflow.heatmap.v2';

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : fallback;
}

function num(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function stepOf(value: unknown): StepMode {
  if (value === '2s') return '1s';
  if (value === '10s') return '15s';
  if (value === '30s') return '1m';
  return oneOf(value, STEP_KEYS, DEFAULT_SETTINGS.stepMode);
}

function columnsOf(value: unknown): ColumnKey[] {
  if (!Array.isArray(value)) return DEFAULT_COLUMNS;
  const out: ColumnKey[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const key = raw === 'bid' || raw === 'ask' ? 'book' : raw;
    if (!(COLUMN_KEYS as readonly string[]).includes(key)) continue;
    if (!out.includes(key as ColumnKey)) out.push(key as ColumnKey);
  }
  return out;
}

/** Sanitize anything read from storage; old or hand-edited values must not break the chart. */
export function sanitizeSettings(raw: unknown): HeatmapSettings {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const bubbleSize = oneOf(value.bubbleSize, BUBBLE_SIZE_KEYS, DEFAULT_SETTINGS.bubbleSize);
  return {
    span: oneOf(value.span, TERMINAL_SPANS, DEFAULT_SETTINGS.span),
    range: oneOf(value.range, RANGE_KEYS, DEFAULT_SETTINGS.range),
    contrast: oneOf(value.contrast, CONTRAST_KEYS, DEFAULT_SETTINGS.contrast),
    bubbles: oneOf(value.bubbles, BUBBLE_KEYS, DEFAULT_SETTINGS.bubbles),
    bubbleSize: value.bubbleScale === 0.75 ? 's' : value.bubbleScale === 1.3 ? 'l' : bubbleSize,
    bubbleFloor: oneOf(value.bubbleFloor, BUBBLE_FLOOR_KEYS, DEFAULT_SETTINGS.bubbleFloor),
    columns: columnsOf(value.columns),
    rowPx: Math.round(num(value.rowPx, 1, 6, DEFAULT_SETTINGS.rowPx)),
    minLiquidityUsd: num(value.minLiquidityUsd, 0, 1e12, DEFAULT_SETTINGS.minLiquidityUsd),
    showVolume: value.showVolume === false ? false : DEFAULT_SETTINGS.showVolume,
    stepMode: stepOf(value.stepMode),
    cvdStrip: value.cvdStrip === true,
    volumeOver: oneOf(value.volumeOver, VOLUME_OVER_KEYS, DEFAULT_SETTINGS.volumeOver),
    sizeUnit: oneOf(value.sizeUnit, SIZE_UNIT_KEYS, DEFAULT_SETTINGS.sizeUnit),
    tapeMin: oneOf(value.tapeMin, TAPE_MIN_KEYS, DEFAULT_SETTINGS.tapeMin),
    showCandles: value.showCandles === true,
    opacity: num(value.opacity, 0.1, 1, DEFAULT_SETTINGS.opacity),
    bubbleScale: num(value.bubbleScale, 0.5, 3, DEFAULT_SETTINGS.bubbleScale),
    minTradeUsd: num(value.minTradeUsd, 0, 250_000, DEFAULT_SETTINGS.minTradeUsd),
  };
}

interface StorageLike {
  getItem(key: string): string | null;
}

interface WritableStorageLike extends StorageLike {
  setItem(key: string, value: string): void;
}

export function loadSettings(storage?: StorageLike | null): HeatmapSettings {
  if (!storage) return DEFAULT_SETTINGS;
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: HeatmapSettings, storage?: WritableStorageLike | null): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in private mode or when the quota is full.
  }
}
