import type { Candle } from '../../shared/types';
import { DRAWN_PROFILE_CAP, VP_TOKENS, PROFILE_MAX_BAR_PX } from './tokens';
import type {
  HoverState, LevelSpec, Profile, ProfileHit, ProfileRow, SessionSeries, VpLayout, ViewState,
  VolRange, VolSettings,
} from './types';
import { priceForY, tForX, xForT, yForPrice } from './layout';
import { istDayShort, niceAxisStep, priceAxisLabel, timeAxisLabels } from './format';
import { drawCandles } from './renderCandles';
import { drawOverlays } from './overlays';

const FONT_11 = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const FONT_11_BOLD = 'bold 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixColor(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round(A[0] + (B[0] - A[0]) * k);
  const g = Math.round(A[1] + (B[1] - A[1]) * k);
  const bl = Math.round(A[2] + (B[2] - A[2]) * k);
  return `rgb(${r},${g},${bl})`;
}

function clampRect(ctx: CanvasRenderingContext2D, l: VpLayout): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(l.plotLeft, l.plotTop, l.plotRight - l.plotLeft, l.plotBottom - l.plotTop);
  ctx.clip();
}

/**
 * Bound the per-frame draw work. When more profiles intersect the view than
 * the cap (a zoomed-out 5m timeframe spans ~2,400 bars), keep an evenly spaced
 * subset in the ORIGINAL order, so the selection is stable across frames and
 * pans — the drawn set never jumps around as the view moves.
 */
export function thinForDraw(profiles: readonly Profile[]): Profile[] {
  if (profiles.length <= DRAWN_PROFILE_CAP) return profiles as Profile[];
  const out: Profile[] = [];
  const n = profiles.length;
  for (let i = 0; i < DRAWN_PROFILE_CAP; i++) {
    const idx = Math.round((i * (n - 1)) / (DRAWN_PROFILE_CAP - 1));
    out.push(profiles[idx]);
  }
  return out;
}

/**
 * At-scale normalization: returns each profile's row-length denominator.
 *  - each:      every profile normalized to its own max
 *  - all:       one shared max across every drawn profile
 *  - current:   the selected profile, or the profile whose span contains the
 *               rightmost visible time (fallback: newest profile)
 */
export function scaleForProfiles(
  profiles: readonly Profile[],
  settings: VolSettings,
  view: ViewState,
  selectedId: string | null,
): Map<string, number> {
  const map = new Map<string, number>();
  if (!profiles.length) return map;
  if (settings.atScale === 'each') {
    for (const p of profiles) map.set(p.id, Math.max(1e-9, p.maxUsd));
    return map;
  }
  let shared: number;
  if (settings.atScale === 'all') {
    shared = Math.max(1e-9, ...profiles.map((p) => p.maxUsd));
  } else {
    let ref: Profile | null = selectedId ? (profiles.find((p) => p.id === selectedId) ?? null) : null;
    if (!ref) {
      for (const p of profiles) {
        if (view.end >= p.t0 && view.end <= p.t1) {
          ref = p;
          break;
        }
      }
    }
    if (!ref) {
      let newest: Profile | null = null;
      for (const p of profiles) if (!newest || p.t1 > newest.t1) newest = p;
      ref = newest;
    }
    shared = ref ? Math.max(1e-9, ref.maxUsd) : 1;
  }
  for (const p of profiles) map.set(p.id, shared);
  return map;
}

/** Same bar-length formula the renderer uses, so hit-testing never drifts. */
export function rowBarWidth(row: ProfileRow, normMax: number, capPx = PROFILE_MAX_BAR_PX): number {
  return (row.vol / Math.max(1e-9, normMax)) * capPx;
}

/** Largest possible bar width across all rows of a profile (outer reject bound). */
function profileOuterWidth(p: Profile, normMax: number, capPx: number): number {
  return (p.maxUsd / Math.max(1e-9, normMax)) * capPx;
}

/**
 * Bar-length cap per profile. Custom/session profiles get the full cap; a
 * timeframe profile's cap tracks the on-screen spacing between its bars so the
 * histograms stay visually distinct instead of merging into one strip.
 */
export function barCapForProfile(p: Profile, view: ViewState, l: VpLayout): number {
  if (p.kind !== 'timeframe') return PROFILE_MAX_BAR_PX;
  const pw = Math.max(1, l.plotRight - l.plotLeft);
  const spacing = Math.max(0.001, ((p.t1 - p.t0) / Math.max(1e-9, view.end - view.start)) * pw);
  return Math.max(26, Math.min(260, spacing * 5));
}

/**
 * Hit-test a pointer against the drawn profile bars. Profiles are checked in
 * reverse draw order so the topmost bar wins. Two fast rejects — x outside the
 * profile's outer bar span, then y outside a row's band — before the row width
 * check, so a 160-profile timeframe hover costs ~160 cheap comparisons plus a
 * couple of binary searches instead of a full row scan.
 */
export function profileRowAt(
  l: VpLayout,
  view: ViewState,
  profiles: readonly Profile[],
  scales: Map<string, number>,
  caps: Map<string, number> | null,
  x: number,
  y: number,
): ProfileHit | null {
  const price = priceForY(y, view, l);
  for (let i = profiles.length - 1; i >= 0; i--) {
    const p = profiles[i];
    const anchorX = p.anchor === 'right'
      ? xForT(p.t1, view, l)
      : xForT(p.t0, view, l);
    const dir = p.anchor === 'right' ? -1 : 1;
    const normMax = scales.get(p.id) ?? p.maxUsd;
    const capPx = caps?.get(p.id) ?? barCapForProfile(p, view, l);
    const outerW = profileOuterWidth(p, normMax, capPx);
    if (outerW < 0.4) continue;
    const outerInner = anchorX + dir * outerW;
    if (dir < 0) {
      if (x < outerInner || x > anchorX) continue;
    } else {
      if (x < anchorX || x > outerInner) continue;
    }

    // Rows are sorted by price descending; binary search for the band holding y.
    let lo = 0;
    let hi = p.rows.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const row = p.rows[mid];
      if (price > row.hi) {
        hi = mid - 1;
      } else if (price < row.lo) {
        lo = mid + 1;
      } else {
        found = mid;
        break;
      }
    }
    if (found < 0) continue;
    const row = p.rows[found];
    const width = rowBarWidth(row, normMax, capPx);
    if (width < 0.4) continue;
    const innerX = anchorX + dir * width;
    if (dir < 0) {
      if (x >= innerX && x <= anchorX) return { profile: p, row };
    } else {
      if (x >= anchorX && x <= innerX) return { profile: p, row };
    }
  }
  return null;
}

function drawProfileBars(
  ctx: CanvasRenderingContext2D,
  l: VpLayout,
  view: ViewState,
  profile: Profile,
  settings: VolSettings,
  normMax: number,
  deltaNorm: number,
  capPx: number,
): void {
  const anchorX = profile.anchor === 'right'
    ? xForT(profile.t1, view, l)
    : xForT(profile.t0, view, l);
  const dir = profile.anchor === 'right' ? -1 : 1;
  const maxBar = capPx;

  for (const row of profile.rows) {
    const yTop = Math.round(yForPrice(row.hi, view, l));
    const yBot = Math.round(yForPrice(row.lo, view, l));
    const h = Math.max(1, yBot - yTop);
    const width = rowBarWidth(row, normMax, capPx);
    if (width < 0.4) continue;

    ctx.globalAlpha = settings.barOpacity;
    let mainColor = settings.colorRow;
    if (settings.delta === 'colour' && deltaNorm > 0) {
      const lambda = Math.max(-1, Math.min(1, row.delta / deltaNorm));
      mainColor = mixColor(
        settings.colorRow,
        lambda < 0 ? settings.colorBid : settings.colorAsk,
        Math.abs(lambda),
      );
    }

    if (settings.mode === 'volume') {
      ctx.fillStyle = mainColor;
      const rx = Math.round(dir < 0 ? anchorX - width : anchorX);
      ctx.fillRect(rx, yTop, Math.max(1, Math.round(width)), h);
    } else {
      const total = row.buy + row.sell;
      const buyFrac = total > 0 ? row.buy / total : 0.5;
      const wBuy = Math.round(width * buyFrac);
      const wSell = Math.round(width - wBuy);
      const rx = Math.round(dir < 0 ? anchorX - width : anchorX);
      ctx.fillStyle = settings.colorAsk;
      ctx.fillRect(dir < 0 ? rx + wSell : rx, yTop, wBuy, h);
      ctx.fillStyle = settings.colorBid;
      ctx.fillRect(dir < 0 ? rx : rx + wBuy, yTop, wSell, h);
    }

    // POC row tint — the busiest price reads brighter.
    if (settings.showPoc && row.price === profile.pocPrice) {
      const rx = Math.round(dir < 0 ? anchorX - width : anchorX);
      ctx.fillStyle = settings.colorPoc;
      ctx.globalAlpha = Math.min(1, settings.barOpacity + 0.25);
      ctx.fillRect(rx, yTop, Math.max(1, Math.round(width)), h);
      ctx.globalAlpha = settings.barOpacity;
    }

    if (settings.delta === 'beside' && deltaNorm > 0) {
      const barEndX = dir < 0 ? anchorX - width : anchorX + width;
      const dLen = Math.min(maxBar * 0.55, (Math.abs(row.delta) / deltaNorm) * maxBar * 0.55);
      if (dLen > 0.4) {
        ctx.fillStyle = row.delta >= 0 ? settings.colorAsk : settings.colorBid;
        const gap = 1;
        const start = barEndX + dir * gap;
        ctx.fillRect(dir < 0 ? start - dLen : start, yTop, Math.max(1, Math.round(dLen)), h);
      }
    }
    ctx.globalAlpha = 1;
  }
}

function drawProfileDecor(
  ctx: CanvasRenderingContext2D,
  l: VpLayout,
  view: ViewState,
  profile: Profile,
  settings: VolSettings,
): void {
  const x0 = xForT(profile.t0, view, l);
  const x1 = xForT(profile.t1, view, l);
  const dir = profile.anchor === 'right' ? -1 : 1;

  if (settings.showVahVal && profile.vah > 0 && profile.val > 0) {
    const yA = yForPrice(profile.vah, view, l);
    const yV = yForPrice(profile.val, view, l);
    const top = Math.min(yA, yV);
    const h = Math.abs(yA - yV);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(Math.min(x0, x1), top, Math.abs(x1 - x0), Math.max(1, h));
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x0, yA);
    ctx.lineTo(x1, yA);
    ctx.moveTo(x0, yV);
    ctx.lineTo(x1, yV);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = FONT_11;
    ctx.fillStyle = VP_TOKENS.muted;
    ctx.textBaseline = 'middle';
    const lx = anchorXFor(profile, view, l) - dir * 4;
    ctx.textAlign = profile.anchor === 'right' ? 'right' : 'left';
    ctx.fillText('VAH', lx, yA);
    ctx.fillText('VAL', lx, yV);
  }

  if (settings.showPoc && profile.pocPrice > 0) {
    const y = yForPrice(profile.pocPrice, view, l);
    ctx.strokeStyle = settings.colorPoc;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }
}

function anchorXFor(profile: Profile, view: ViewState, l: VpLayout): number {
  return profile.anchor === 'right'
    ? xForT(profile.t1, view, l)
    : xForT(profile.t0, view, l);
}

export function drawProfiles(
  ctx: CanvasRenderingContext2D,
  l: VpLayout,
  view: ViewState,
  profiles: readonly Profile[],
  settings: VolSettings,
  scales: Map<string, number>,
  caps: Map<string, number> | null,
): void {
  let deltaNorm = 0;
  for (const p of profiles) deltaNorm = Math.max(deltaNorm, p.maxAbsDelta);
  if (deltaNorm <= 0) deltaNorm = 1;
  clampRect(ctx, l);
  for (const p of profiles) {
    const normMax = scales.get(p.id) ?? p.maxUsd;
    const capPx = caps?.get(p.id) ?? barCapForProfile(p, view, l);
    drawProfileBars(ctx, l, view, p, settings, Math.max(1e-9, normMax), deltaNorm, capPx);
  }
  for (const p of profiles) drawProfileDecor(ctx, l, view, p, settings);
  ctx.restore();
}

/**
 * White session VWAP segments that break at UTC midnight, with dashed ±1σ and
 * dotted ±2σ bands, plus right-end labels for the latest session only.
 */
export function drawSessions(
  ctx: CanvasRenderingContext2D,
  l: VpLayout,
  view: ViewState,
  sessions: readonly SessionSeries[],
  settings: VolSettings,
): void {
  clampRect(ctx, l);
  const yFor = (p: number): number => yForPrice(p, view, l);
  const xFor = (t: number): number => xForT(t, view, l);

  const strokeSeries = (key: 'p1' | 'm1' | 'p2' | 'm2', color: string, alpha: number, dash: number[]) => {
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1;
    ctx.setLineDash(dash);
    for (const s of sessions) {
      if (s.t1 < view.start || s.t0 > view.end) continue;
      ctx.beginPath();
      let started = false;
      for (const p of s.points) {
        const px = xFor(p.t);
        if (px < l.plotLeft - 2 || px > l.plotRight + 2) continue;
        const py = yFor(p[key]);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  };

  if (settings.showVwapBands) {
    strokeSeries('p2', 'rgba(200,210,225,1)', 0.3, [1, 4]);
    strokeSeries('m2', 'rgba(200,210,225,1)', 0.3, [1, 4]);
    strokeSeries('p1', 'rgba(200,210,225,1)', 0.4, [4, 4]);
    strokeSeries('m1', 'rgba(200,210,225,1)', 0.4, [4, 4]);
  }

  // VWAP segments: white, 2px, one polyline per session (breaks between).
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  for (const s of sessions) {
    if (s.t1 < view.start || s.t0 > view.end) continue;
    ctx.beginPath();
    let started = false;
    for (const p of s.points) {
      const px = xFor(p.t);
      const py = yFor(p.vwap);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  // Latest-session end labels, just right of the last candle.
  const latest = sessions.length ? sessions[sessions.length - 1] : null;
  if (latest && latest.points.length) {
    const p = latest.points[latest.points.length - 1];
    const x = Math.min(l.axisLeft - 8, xFor(p.t) + 6);
    const yVwap = yFor(p.vwap);
    const label = (text: string, y: number, bold: boolean, color: string) => {
      ctx.font = bold ? FONT_11_BOLD : FONT_11;
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y);
    };
    label(`+2σ ${priceAxisLabel(p.p2)}`, yFor(p.p2), false, VP_TOKENS.muted);
    label(`VWAP ${priceAxisLabel(p.vwap)}`, yVwap, true, '#ffffff');
    label(`-2σ ${priceAxisLabel(p.m2)}`, yFor(p.m2), false, VP_TOKENS.muted);
  }
  ctx.restore();
}

export function drawBand(
  ctx: CanvasRenderingContext2D,
  l: VpLayout,
  view: ViewState,
  t0: number,
  t1: number,
  fill: string,
  border: string,
): void {
  const a = Math.min(t0, t1);
  const b = Math.max(t0, t1);
  const x0 = xForT(a, view, l);
  const x1 = xForT(b, view, l);
  ctx.fillStyle = fill;
  ctx.fillRect(x0, l.plotTop, x1 - x0, l.plotBottom - l.plotTop);
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, l.plotTop, x1 - x0, l.plotBottom - l.plotTop);
}

export function drawRangeHandles(
  ctx: CanvasRenderingContext2D,
  l: VpLayout,
  view: ViewState,
  ranges: readonly VolRange[],
): void {
  for (const r of ranges) {
    const x0 = xForT(r.t0, view, l);
    const x1 = xForT(r.t1, view, l);
    if (x1 < l.plotLeft || x0 > l.plotRight) continue;
    const top = l.plotTop;
    const bottom = l.plotBottom;
    const mid = (x0 + x1) / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, top);
    ctx.lineTo(x0, bottom);
    ctx.moveTo(x1, top);
    ctx.lineTo(x1, bottom);
    ctx.stroke();
    // grab tabs at the edges
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x0 - 3, (top + bottom) / 2 - 10, 6, 20);
    ctx.fillRect(x1 - 3, (top + bottom) / 2 - 10, 6, 20);
    // delete button at the top center
    ctx.fillStyle = 'rgba(13,18,32,0.95)';
    ctx.beginPath();
    ctx.arc(mid, top + 12, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('×', mid, top + 12.5);
  }
}

export function drawAxes(
  ctx: CanvasRenderingContext2D,
  l: VpLayout,
  view: ViewState,
  candleCount: number,
  source: string,
): void {
  // Plot / axis separator.
  ctx.strokeStyle = VP_TOKENS.sep;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(l.plotRight + 0.5, l.plotTop);
  ctx.lineTo(l.plotRight + 0.5, l.plotBottom);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(l.plotLeft, l.plotBottom + 0.5);
  ctx.lineTo(l.axisRight, l.plotBottom + 0.5);
  ctx.stroke();

  // Price axis labels + tiny ticks.
  const span = view.priceMax - view.priceMin;
  const step = niceAxisStep(span, 56, l.plotBottom - l.plotTop);
  ctx.font = FONT_11;
  ctx.fillStyle = VP_TOKENS.muted;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = Math.ceil(view.priceMin / step) * step; v <= view.priceMax + step * 0.001; v += step) {
    if (v < view.priceMin - step || v > view.priceMax + step) continue;
    const y = yForPrice(v, view, l);
    ctx.strokeStyle = VP_TOKENS.muted;
    ctx.beginPath();
    ctx.moveTo(l.plotRight + 1, y);
    ctx.lineTo(l.plotRight + 5, y);
    ctx.stroke();
    ctx.fillText(priceAxisLabel(v), l.axisRight - 6, y);
  }

  // Time axis: every 6 UTC hours, labelled in IST.
  const labels = timeAxisLabels(view.start, view.end);
  for (const lb of labels) {
    const x = xForT(lb.t, view, l);
    if (x < l.plotLeft || x > l.plotRight) continue;
    ctx.strokeStyle = VP_TOKENS.muted;
    ctx.beginPath();
    ctx.moveTo(x, l.plotBottom + 1);
    ctx.lineTo(x, l.plotBottom + 4);
    ctx.stroke();
    ctx.fillStyle = VP_TOKENS.muted;
    ctx.textAlign = 'center';
    ctx.fillText(lb.label, x, l.plotBottom + l.timeH * 0.62);
  }

  // Footnote: centered at the bottom of the plot, directly above the time axis.
  const foot = `${candleCount.toLocaleString('en-US')} 1m candles (${source})`;
  ctx.font = FONT_11;
  const fw = ctx.measureText(foot).width;
  const fx = (l.plotLeft + l.plotRight) / 2;
  const fy = l.plotBottom - 7;
  ctx.fillStyle = 'rgba(10,14,23,0.9)';
  ctx.fillRect(fx - fw / 2 - 8, fy - 8, fw + 16, 16);
  ctx.fillStyle = VP_TOKENS.muted;
  ctx.textAlign = 'center';
  ctx.fillText(foot, fx, fy);
}

export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  l: VpLayout,
  hover: HoverState,
): void {
  ctx.strokeStyle = VP_TOKENS.crosshair;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(hover.x, l.plotTop);
  ctx.lineTo(hover.x, l.plotBottom);
  ctx.moveTo(l.plotLeft, hover.y);
  ctx.lineTo(l.plotRight, hover.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Price tag on the axis.
  const priceText = priceAxisLabel(hover.price);
  ctx.font = FONT_11;
  const pw = ctx.measureText(priceText).width;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(l.axisRight - pw - 12, hover.y - 8, pw + 12, 16);
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(priceText, l.axisRight - 6, hover.y);

  // Time tag on the time axis.
  const timeText = istDayShort(hover.time);
  const tw = ctx.measureText(timeText).width;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(hover.x - tw / 2 - 5, l.plotBottom + 2, tw + 10, 13);
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.fillText(timeText, hover.x, l.plotBottom + 8.5);
}

export function drawProfileHitLine(
  ctx: CanvasRenderingContext2D,
  l: VpLayout,
  hover: HoverState,
): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(l.plotLeft, hover.y);
  ctx.lineTo(l.plotRight, hover.y);
  ctx.stroke();
}

export interface DrawState {
  candles: Candle[];
  view: ViewState;
  profiles: Profile[];
  sessions: SessionSeries[];
  levels: LevelSpec[];
  settings: VolSettings;
  scales: Map<string, number>;
  caps: Map<string, number> | null;
  hover: HoverState | null;
  profileHit: HoverState | null;
  hoveredRange: VolRange | null;
  selRange: { t0: number; t1: number } | null;
  customRanges: VolRange[];
  candleCount: number;
  source: string;
}

/**
 * Static scene: candles, sessions, profiles, level lines and axes. This is
 * the expensive part; the view renders it to an offscreen canvas and only
 * rebuilds it when the data/view/settings fingerprint changes.
 */
export function drawVolScene(ctx: CanvasRenderingContext2D, l: VpLayout, s: DrawState): void {
  ctx.clearRect(0, 0, l.axisRight, l.plotBottom + l.timeH);
  ctx.fillStyle = VP_TOKENS.bg;
  ctx.fillRect(0, 0, l.axisRight, l.plotBottom + l.timeH);

  drawCandles(ctx, l, s.candles, s.view);
  drawSessions(ctx, l, s.view, s.sessions, s.settings);
  drawProfiles(ctx, l, s.view, s.profiles, s.settings, s.scales, s.caps);
  drawOverlays(ctx, l, s.view, s.levels);
  drawAxes(ctx, l, s.view, s.candleCount, s.source);
}

/**
 * Cheap interactive overlay: selection bands, range handles, crosshair and the
 * profile-row highlight. Repainted on every pointer move without touching the
 * scene layer.
 */
export function drawVolOverlay(ctx: CanvasRenderingContext2D, l: VpLayout, s: DrawState): void {
  if (s.selRange) {
    drawBand(ctx, l, s.view, s.selRange.t0, s.selRange.t1, 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0.5)');
  }
  if (s.hoveredRange) {
    drawBand(ctx, l, s.view, s.hoveredRange.t0, s.hoveredRange.t1, 'rgba(255,255,255,0.04)', 'rgba(255,255,255,0.35)');
  }
  if (s.settings.profiles === 'custom') {
    drawRangeHandles(ctx, l, s.view, s.customRanges);
  }
  if (s.profileHit) {
    drawProfileHitLine(ctx, l, s.profileHit);
  }
  if (s.hover) {
    drawCrosshair(ctx, l, s.hover);
  }
}

export function drawVolProfile(ctx: CanvasRenderingContext2D, l: VpLayout, s: DrawState): void {
  drawVolScene(ctx, l, s);
  drawVolOverlay(ctx, l, s);
}

export { tForX, xForT, yForPrice };
