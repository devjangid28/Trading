import type { VolSettings } from './types';

/**
 * Single source of theme + tunable numbers for the volume-profile view.
 * Follows the whales-view convention: client-side constants live next to the
 * view with provenance tags, never buried in component code.
 */
export const VP_TOKENS = {
  bg: '#0a0e17',
  panel: '#070a10',
  sep: '#1a2030',
  pill: '#111722',
  pillActive: '#1d2533',
  muted: '#6b7686',
  text: '#c9d1d9',
  magenta: '#d65bd6',
  up: '#26a65b',
  down: '#d9453d',
  teal: '#2f8f9d',
  poc: '#f0b90b',
  white: '#ffffff',
  row: '#7c8aa5',
  hintFill: '#0d1320',
  lastLine: 'rgba(255,255,255,0.65)',
  refLine: '#6b7686',
  crosshair: 'rgba(155,170,195,0.55)',
} as const;

export const VP_STORAGE_KEY = 'orderflow.volprofile.settings.v1';
export const VP_RANGES_KEY = 'orderflow.volprofile.ranges.v1';

/** Max 1m candles (~8.3 days). Mirrors server VOLPROFILE_MAX_CANDLES. */
export const MAX_CANDLES = 12_000;
export const CANDLE_STEP_MS = 60_000;
export const DAY_MS = 86_400_000;

/** Pane/axis/dock fixed widths in px (canvas is the rest). */
export const RIGHT_PANE_W = 186;
export const DOCK_W = 36;
export const AXIS_W = 90;
export const TIME_H = 16;

/** [TUNED] Auto bin width ~0.05% of the reference price. */
export const BIN_AUTO_PCT = 0.0005;
/** [TUNED] Value area default percent. */
export const VALUE_AREA_DEFAULT = 70;
/** [TUNED] Row opacity so candles stay visible behind the profile. */
export const BAR_OPACITY_DEFAULT = 0.55;
/** [TUNED] Max histogram bar length in px. */
export const PROFILE_MAX_BAR_PX = 260;
/** [TUNED] Max profiles drawn per frame; beyond this they are thinned evenly
    across the visible window so a 8.3-day / 5m timeframe view stays at 60fps. */
export const DRAWN_PROFILE_CAP = 160;
/** [TUNED] Delta beside-bar width in px. */
export const DELTA_BAR_PX = 3;
/** [TUNED] Cursor grab radii for range handles / edges. */
export const RANGE_EDGE_GRAB_PX = 6;
export const RANGE_TOP_BTN_R = 9;

/** [TUNED] Live tick counts as "live" while fresher than this. */
export const LIVE_FRESH_MS = 15_000;
/** [TUNED] Minimum gap between data-driven full repaints. Interactive gestures
    (hover/pan/zoom) bypass this and stay instant. Prevents live-tick strobe on
    slower GPUs where a full canvas redraw takes >16ms. */
export const DATA_RENDER_INTERVAL_MS = 200;
/** [TUNED] REST tail refresh cadence for closed-candle corrections. */
export const REFRESH_MS = 60_000;
/** [TUNED] IndexedDB cache considered fresh for this long. */
export const CACHE_TTL_MS = 60_000;

export function minTick(price: number): number {
  if (price >= 1_000) return 0.01;
  if (price >= 10) return 0.001;
  return 0.0001;
}

export const DEFAULT_SETTINGS: VolSettings = {
  profiles: 'custom',
  mode: 'volume',
  delta: 'beside',
  atScale: 'current',
  binSize: 'auto',
  valueAreaPct: VALUE_AREA_DEFAULT,
  barOpacity: BAR_OPACITY_DEFAULT,
  showVwapBands: true,
  showPoc: true,
  showVahVal: true,
  colorRow: VP_TOKENS.row,
  colorAsk: VP_TOKENS.up,
  colorBid: VP_TOKENS.down,
  colorPoc: VP_TOKENS.poc,
};
