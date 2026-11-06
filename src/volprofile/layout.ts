import { AXIS_W, DOCK_W, RIGHT_PANE_W, TIME_H } from './tokens';
import type { VpLayout } from './types';

/**
 * The view's canvas is everything left of the right pane and dock strip; the
 * price axis is the rightmost slice of that canvas and the time axis is the
 * bottom strip. The pane/dock are DOM siblings, so they are not in the canvas
 * layout at all — only their widths matter.
 */
export function computeLayout(w: number, h: number): VpLayout {
  const canvasW = Math.max(1, w - RIGHT_PANE_W - DOCK_W);
  const plotRight = Math.max(1, canvasW - AXIS_W);
  const plotBottom = Math.max(1, h - TIME_H);
  return {
    plotLeft: 0,
    plotRight,
    plotTop: 0,
    plotBottom,
    axisLeft: plotRight + 1,
    axisRight: canvasW,
    timeTop: plotBottom,
    timeH: TIME_H,
    paneW: RIGHT_PANE_W,
    dockW: DOCK_W,
    axisW: AXIS_W,
  };
}

export function xForT(t: number, view: { start: number; end: number }, l: VpLayout): number {
  const pw = l.plotRight - l.plotLeft;
  return l.plotLeft + ((t - view.start) / Math.max(1e-9, view.end - view.start)) * pw;
}

export function tForX(x: number, view: { start: number; end: number }, l: VpLayout): number {
  const pw = l.plotRight - l.plotLeft;
  return view.start + ((x - l.plotLeft) / Math.max(1e-9, pw)) * (view.end - view.start);
}

export function yForPrice(price: number, view: { priceMin: number; priceMax: number }, l: VpLayout): number {
  const ph = l.plotBottom - l.plotTop;
  return l.plotBottom - ((price - view.priceMin) / Math.max(1e-9, view.priceMax - view.priceMin)) * ph;
}

export function priceForY(y: number, view: { priceMin: number; priceMax: number }, l: VpLayout): number {
  const ph = l.plotBottom - l.plotTop;
  return view.priceMin + ((l.plotBottom - y) / Math.max(1e-9, ph)) * (view.priceMax - view.priceMin);
}
