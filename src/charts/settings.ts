import type { ChartSettings, ChartType, IndicatorConfig, IndicatorKind, ScaleType, SidebarTab } from './types';
import {
  CHART_INTERVALS,
  CHART_TYPES,
  INDICATOR_CATALOG,
  SCALE_TYPES,
  SIDEBAR_TABS,
} from './types';

export const CHART_SETTINGS_KEY = 'of-charts-settings-v1';

const INDICATOR_KINDS = INDICATOR_CATALOG.map((entry) => entry.kind);

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  symbol: 'BTCUSDT',
  interval: '15m',
  chartType: 'candles',
  scale: 'linear',
  indicators: [
    { id: 'ema', kind: 'EMA', params: [21, 50], visible: true },
    { id: 'rsi', kind: 'RSI', params: [14], visible: true },
  ],
  sessions: { london: true, newyork: true },
  sidebarOpen: true,
  sidebarTab: 'whales',
};

export function indicatorCatalog(kind: IndicatorKind) {
  return INDICATOR_CATALOG.find((entry) => entry.kind === kind) ?? INDICATOR_CATALOG[0];
}

export function makeIndicator(kind: IndicatorKind): IndicatorConfig {
  const entry = indicatorCatalog(kind);
  return {
    id: kind.toLowerCase(),
    kind,
    params: [...entry.defaults],
    visible: true,
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function params(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return [...fallback];
  const parsed = value
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((item) => Number.isFinite(item) && item > 0 && item <= 1_000)
    .map((item) => Math.round(item));
  return parsed.length ? parsed : [...fallback];
}

function sanitizeIndicator(raw: unknown): IndicatorConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const kind = oneOf(value.kind, INDICATOR_KINDS, 'EMA');
  const entry = indicatorCatalog(kind);
  return {
    id: kind.toLowerCase(),
    kind,
    params: params(value.params, entry.defaults),
    visible: bool(value.visible, true),
  };
}

export function sanitizeChartSettings(raw: unknown): ChartSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const indicators: IndicatorConfig[] = [];
  const seen = new Set<IndicatorKind>();
  if (Array.isArray(value.indicators)) {
    for (const item of value.indicators) {
      const indicator = sanitizeIndicator(item);
      if (!indicator || seen.has(indicator.kind)) continue;
      seen.add(indicator.kind);
      indicators.push(indicator);
    }
  }
  const sessions = value.sessions && typeof value.sessions === 'object'
    ? (value.sessions as Record<string, unknown>)
    : {};

  return {
    symbol: typeof value.symbol === 'string' && /^[A-Z0-9]{2,20}$/.test(value.symbol.toUpperCase())
      ? value.symbol.toUpperCase()
      : DEFAULT_CHART_SETTINGS.symbol,
    interval: oneOf(value.interval, CHART_INTERVALS, DEFAULT_CHART_SETTINGS.interval),
    chartType: oneOf(value.chartType, CHART_TYPES.map((entry) => entry.id), DEFAULT_CHART_SETTINGS.chartType as ChartType),
    scale: oneOf(value.scale, SCALE_TYPES.map((entry) => entry.id), DEFAULT_CHART_SETTINGS.scale as ScaleType),
    indicators: indicators.length ? indicators : DEFAULT_CHART_SETTINGS.indicators.map((entry) => ({ ...entry, params: [...entry.params] })),
    sessions: {
      london: bool(sessions.london, DEFAULT_CHART_SETTINGS.sessions.london),
      newyork: bool(sessions.newyork, DEFAULT_CHART_SETTINGS.sessions.newyork),
    },
    sidebarOpen: bool(value.sidebarOpen, DEFAULT_CHART_SETTINGS.sidebarOpen),
    sidebarTab: oneOf(value.sidebarTab, SIDEBAR_TABS.map((entry) => entry.id), DEFAULT_CHART_SETTINGS.sidebarTab as SidebarTab),
  };
}

interface StorageLike {
  getItem(key: string): string | null;
}

interface WritableStorageLike extends StorageLike {
  setItem(key: string, value: string): void;
}

export function loadChartSettings(storage?: StorageLike | null): ChartSettings {
  if (!storage) return sanitizeChartSettings(DEFAULT_CHART_SETTINGS);
  try {
    const raw = storage.getItem(CHART_SETTINGS_KEY);
    return raw ? sanitizeChartSettings(JSON.parse(raw)) : sanitizeChartSettings(DEFAULT_CHART_SETTINGS);
  } catch {
    return sanitizeChartSettings(DEFAULT_CHART_SETTINGS);
  }
}

export function saveChartSettings(settings: ChartSettings, storage?: WritableStorageLike | null): void {
  if (!storage) return;
  try {
    storage.setItem(CHART_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage can be unavailable */
  }
}
