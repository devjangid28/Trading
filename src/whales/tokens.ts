export const WHALES_TOKENS = {
  /* Reference palette (shipped Tradfye bundle): Kb = '#0b1118' page background,
     Tailwind-scale accents: green-400 #4ade80, red-400 #f87171, amber-300
     #fcd34d, sky-300 #7dd3fc, muted-foreground ~ #8794a7. */
  bg: '#0b1118',
  panel: '#0e1520',
  panelAlt: '#101826',
  sep: '#171f2c',
  text: '#e2e8f0',
  muted: '#8794a7',
  gold: '#e0b400',
  magenta: '#d65bd6',
  whaleGreen: '#3ddc84',
  whaleGreenSoft: 'rgba(61,220,132,0.12)',
  cyan: '#3cc8e6',
  up: '#26a65b',
  down: '#d9453d',
  maFast: '#e6b422',
  maSlow: '#9b8cff',
  crosshair: '#5b6470',
  t0: '#6b6a2a',
  lastPrice: '#fff2ec',
  tooltipYellow: '#e8c500',
} as const;

export const WHALE_THRESHOLD_DEFAULT = 50_000;
export const WHALE_CLUSTER_WINDOW_DEFAULT = 1;

/** Auto whale-size floor cap: `keepUsd = min(p99, WHALE_AUTO_SIZE_CAP)`. */
export const WHALE_AUTO_SIZE_CAP = 5_000;

/** Bubble radius = clamp(24 * sqrt(notional / 1e6), min, max). */
export const WHALE_BUBBLE_MIN_R = 4;
export const WHALE_BUBBLE_MAX_R = 38;
export const WHALE_BUBBLE_R_SCALE = 24 / 1_000;

/** |buy - sell| / total above this draws the "whale action" tag. */
export const WHALE_TAG_RATIO = 0.35;
/** Bubbles with at least this radius get a notional label. */
export const WHALE_LABEL_MIN_R = 10;

export const WHALE_AVG_LEVERAGE_DEFAULT = 5;
export const USER_LEVELS_KEY = 'orderflow.whales.levels.v1';
export const WHALES_SETTINGS_KEY = 'orderflow.whales.settings.v1';

/** Default view: ~145 candles at 15m, with ~100px of right padding. */
export const DEFAULT_CANDLES = 145;
export const RIGHT_PAD_PX = 100;

/** Time axis label every 10 candles at the default 15m view (2h30m). */
export const TIME_LABEL_CANDLES = 10;
