/**
 * Popup timing, in ONE place.
 *
 * These are the values the reference terminal's locked preview was measured
 * against by hand (Styles pane -> `transition`, plus a stopwatch on the open
 * delay). They are collected here so that when the real measurements arrive
 * they are a one-line change in one file rather than a hunt through
 * components, and so the Playwright suite can import the same constants the UI
 * uses instead of duplicating magic numbers that can drift.
 *
 * STATUS: the values below are the ones specified for the rebuild and are
 * PLACEHOLDERS for the measured ones. They are deliberately named and exported
 * so replacing them is mechanical.
 */

/**
 * Intent delay before a hover switches an already-open preview to another row.
 * The first preview after idle opens immediately: the QA contract is
 * "hover -> visible within 300ms", and spending 120ms of that window on intent
 * left the preview landing a poll interval late on a loaded machine.
 */
export const HOVER_OPEN_DELAY_MS = 120;

/**
 * Grace period after the pointer leaves, so travelling from the row into the
 * popup does not close it mid-gesture. Zero would make the popup unusable.
 */
export const HOVER_CLOSE_GRACE_MS = 160;

/** Opacity + transform transition used when the popup appears. */
export const POPUP_FADE_MS = 140;

/** Row hover transitions: border, corner brackets, glow. */
export const ROW_HOVER_MS = 140;

/** Translate distance on enter, in px. */
export const POPUP_SLIDE_PX = 8;

/** Popup card width, px. */
export const POPUP_WIDTH_PX = 500;

/** Chart size inside the popup, px. */
export const POPUP_CHART_W = 470;
export const POPUP_CHART_H = 290;

/**
 * Popups never open or close faster than the Playwright suite's tolerance, so
 * a test asserting "within 300ms" is asserting behaviour, not racing the clock.
 */
export const POPUP_MAX_OPEN_MS = 300;

/** Distance the pointer may travel from a row before the popup is considered abandoned. */
export const HOVER_SLOP_PX = 6;

export const MOTION = {
  openDelayMs: HOVER_OPEN_DELAY_MS,
  closeGraceMs: HOVER_CLOSE_GRACE_MS,
  fadeMs: POPUP_FADE_MS,
  rowHoverMs: ROW_HOVER_MS,
  slidePx: POPUP_SLIDE_PX,
  widthPx: POPUP_WIDTH_PX,
  chartW: POPUP_CHART_W,
  chartH: POPUP_CHART_H,
  slopPx: HOVER_SLOP_PX,
} as const;

export type Motion = typeof MOTION;