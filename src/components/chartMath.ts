/**
 * Chart-side numeric helpers.
 *
 * Kept separate from the React component so they can be unit tested without a
 * DOM, and so two charts cannot drift into formatting the same number
 * differently.
 */

const MINOR = '−'; // U+2212, not a hyphen. A hyphen reads as a dash at small sizes.

/**
 * A signed percentage for a chart axis.
 *
 * Uses the proper minus sign and a thin space, because the axis is read at
 * 10px where an ASCII hyphen is genuinely hard to distinguish from a tick mark.
 *
 * The digits are formatted from the magnitude, not from the signed value.
 * `toFixed` on a negative number emits its own ASCII hyphen, so formatting the
 * signed value and prefixing U+2212 renders "−-3.2%" — a double minus that
 * shipped here and was caught by `server/test/chartMath.test.ts`.
 */
export function axisPct(pct: number, suffix = '%'): string {
  if (!Number.isFinite(pct)) return '—';
  const abs = Math.abs(pct);
  const v = abs >= 100 ? abs.toFixed(0) : abs.toFixed(abs >= 10 ? 0 : 1);
  const sign = pct > 0 ? '+' : pct < 0 ? MINOR : '';
  return `${sign}${v}${suffix}`;
}

/** Round a value to a "nice" tick for a gridline. */
export function niceTick(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const mag = 10 ** Math.floor(Math.log10(Math.abs(value)));
  const norm = value / mag;
  const step = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return step * mag;
}

/**
 * Evenly spaced nice ticks covering [min, max].
 *
 * Returns fewer than `count` ticks when the range is narrow, rather than
 * repeating values, so an axis never shows "0.0, 0.0, 0.1, 0.1".
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const raw = (max - min) / Math.max(1, count - 1);
  const step = niceTick(raw);
  if (!Number.isFinite(step) || step <= 0) return [];
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Math.round(v / step) * step);
  }
  return out;
}

/** Map a value into 0..1 across [min,max], clamped. */
export function norm(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  const t = (value - min) / (max - min);
  return Math.min(1, Math.max(0, t));
}