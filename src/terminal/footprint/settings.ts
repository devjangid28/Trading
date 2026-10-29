import type {
  FootprintColorScale, FootprintImbalanceMode, FootprintRows, FootprintSettings, FootprintShow,
  FootprintUnits,
} from './types';

export const FOOTPRINT_SETTINGS_KEY = 'orderflow.footprint.settings.v1';
export const FOOTPRINT_LINK_KEY = 'orderflow.footprint.link.v1';

/**
 * Canvas geometry. Kept in one place because the renderer, hit-testing and the
 * reading line all quote the same numbers.
 */
export const FOOTPRINT = {
  BASE_TICK: 0.5,
  INFO_H: 20,
  HEADER_H: 30,
  SUMMARY_H: 83,
  SUMMARY_ROW_H: 16.5,
  COL_PITCH: 137,
  COL_GAP: 7,
  COL_MIN: 78,
  COL_MAX: 260,
  LANE_W: 14,
  BODY_W: 10,
  ROW_H_NOMINAL: 22,
  AXIS_W: 90,
  GUTTER_W: 125,
  LABEL_MARGIN: 150,
  AXIS_TARGET_PX: 44,
  WHITE_TEXT_AT: 0.55,
  LABEL_STACK_PX: 20,
  OFFSCREEN_COLLAPSE_AT: 2,
  MIN_REKT_USD: 0,
} as const;

export const SHOW_KEYS: FootprintShow[] = ['bid-ask', 'delta', 'volume', 'profile', 'delta-volume'];
export const SHOW_LABEL: Record<FootprintShow, string> = {
  'bid-ask': 'Bid × Ask',
  delta: 'Delta',
  volume: 'Volume',
  profile: 'Profile',
  'delta-volume': 'Δ + Vol',
};

export const ROW_KEYS: FootprintRows[] = ['auto', '1', '2', '5', '10'];
export const ROW_LABEL: Record<FootprintRows, string> = {
  auto: 'Auto',
  '1': '1×',
  '2': '2×',
  '5': '5×',
  '10': '10×',
};

export const UNIT_KEYS: FootprintUnits[] = ['usd', 'btc'];
export const IMBALANCE_MODE_KEYS: FootprintImbalanceMode[] = ['diagonal', 'same'];
export const COLOR_SCALE_KEYS: FootprintColorScale[] = ['linear', 'sqrt', 'log'];
export const IMBALANCE_RATIO_KEYS = [2, 3, 4, 5] as const;
export const MIN_VOLUME_KEYS = [1_000, 5_000, 10_000, 25_000, 50_000] as const;
export const VALUE_AREA_KEYS = [50, 70, 90] as const;

export const DEFAULT_FOOTPRINT_SETTINGS: FootprintSettings = {
  show: 'bid-ask',
  rows: 'auto',
  units: 'usd',
  imbalanceRatio: 3,
  minVolumeUsd: 5_000,
  imbalanceMode: 'diagonal',
  valueAreaPct: 70,
  showBuySellPct: true,
  showSummary: true,
  showPocTicks: true,
  showUaLines: true,
  showNpoc: true,
  showPrevDay: true,
  showRekt: true,
  showCellBars: true,
  colorScale: 'sqrt',
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : fallback;
}

function oneOfNumber(value: unknown, allowed: readonly number[], fallback: number): number {
  return typeof value === 'number' && allowed.includes(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function sanitizeFootprintSettings(raw: unknown): FootprintSettings {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    show: oneOf(value.show, SHOW_KEYS, DEFAULT_FOOTPRINT_SETTINGS.show),
    rows: oneOf(value.rows, ROW_KEYS, DEFAULT_FOOTPRINT_SETTINGS.rows),
    units: oneOf(value.units, UNIT_KEYS, DEFAULT_FOOTPRINT_SETTINGS.units),
    imbalanceRatio: oneOfNumber(value.imbalanceRatio, IMBALANCE_RATIO_KEYS, DEFAULT_FOOTPRINT_SETTINGS.imbalanceRatio),
    minVolumeUsd: oneOfNumber(value.minVolumeUsd, MIN_VOLUME_KEYS, DEFAULT_FOOTPRINT_SETTINGS.minVolumeUsd),
    imbalanceMode: oneOf(value.imbalanceMode, IMBALANCE_MODE_KEYS, DEFAULT_FOOTPRINT_SETTINGS.imbalanceMode),
    valueAreaPct: oneOfNumber(value.valueAreaPct, VALUE_AREA_KEYS, DEFAULT_FOOTPRINT_SETTINGS.valueAreaPct),
    showBuySellPct: bool(value.showBuySellPct, DEFAULT_FOOTPRINT_SETTINGS.showBuySellPct),
    showSummary: bool(value.showSummary, DEFAULT_FOOTPRINT_SETTINGS.showSummary),
    showPocTicks: bool(value.showPocTicks, DEFAULT_FOOTPRINT_SETTINGS.showPocTicks),
    showUaLines: bool(value.showUaLines, DEFAULT_FOOTPRINT_SETTINGS.showUaLines),
    showNpoc: bool(value.showNpoc, DEFAULT_FOOTPRINT_SETTINGS.showNpoc),
    showPrevDay: bool(value.showPrevDay, DEFAULT_FOOTPRINT_SETTINGS.showPrevDay),
    showRekt: bool(value.showRekt, DEFAULT_FOOTPRINT_SETTINGS.showRekt),
    showCellBars: bool(value.showCellBars, DEFAULT_FOOTPRINT_SETTINGS.showCellBars),
    colorScale: oneOf(value.colorScale, COLOR_SCALE_KEYS, DEFAULT_FOOTPRINT_SETTINGS.colorScale),
  };
}

interface StorageLike {
  getItem(key: string): string | null;
}

interface WritableStorageLike extends StorageLike {
  setItem(key: string, value: string): void;
}

export function loadFootprintSettings(storage?: StorageLike | null): FootprintSettings {
  if (!storage) return DEFAULT_FOOTPRINT_SETTINGS;
  try {
    const raw = storage.getItem(FOOTPRINT_SETTINGS_KEY);
    return raw ? sanitizeFootprintSettings(JSON.parse(raw)) : DEFAULT_FOOTPRINT_SETTINGS;
  } catch {
    return DEFAULT_FOOTPRINT_SETTINGS;
  }
}

export function saveFootprintSettings(settings: FootprintSettings, storage?: WritableStorageLike | null): void {
  if (!storage) return;
  try {
    storage.setItem(FOOTPRINT_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in private mode or when the quota is full.
  }
}

export function loadFootprintLink(storage?: StorageLike | null): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(FOOTPRINT_LINK_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveFootprintLink(linked: boolean, storage?: WritableStorageLike | null): void {
  if (!storage) return;
  try {
    storage.setItem(FOOTPRINT_LINK_KEY, linked ? '1' : '0');
  } catch {
    // Optional preference only.
  }
}

export const STORAGE_KEYS = {
  settings: FOOTPRINT_SETTINGS_KEY,
  link: FOOTPRINT_LINK_KEY,
} as const;
