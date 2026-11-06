/**
 * Display helpers for the volume-profile view. All wall-clock strings are IST
 * (UTC+05:30, no DST) to match the app's screenshots; the session grid itself
 * stays UTC (00:00 UTC resets appear at 05:30 IST).
 */

const IST_OFFSET_MIN = 330;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "29 17:30" — day of month + IST time. */
export function istDayShort(ts: number): string {
  const d = new Date(ts + IST_OFFSET_MIN * 60_000);
  return `${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "30 05:30 - 30 17:30" for range/session cards. */
export function istSpanShort(t0: number, t1: number): string {
  return `${istDayShort(t0)} - ${istDayShort(t1)}`;
}

/** Price axis label: "82000.00". */
export function priceAxisLabel(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Pick a "nice" axis step so labels stay ~targetPx apart. */
export function niceAxisStep(span: number, targetPx: number, plotH: number): number {
  const targetCount = Math.max(1, Math.round(plotH / Math.max(20, targetPx)));
  const raw = span / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  return step;
}

const SIX_HOURS = 6 * 3_600_000;

export interface TimeLabel {
  t: number;
  label: string;
}

/** Every 6 UTC hours inside [start, end], labelled in IST. */
export function timeAxisLabels(start: number, end: number, max = 40): TimeLabel[] {
  const out: TimeLabel[] = [];
  const first = Math.ceil(start / SIX_HOURS) * SIX_HOURS;
  for (let t = first; t <= end && out.length < max; t += SIX_HOURS) {
    out.push({ t, label: istDayShort(t) });
  }
  return out;
}

/** Signed base-currency volume for cards ("+12.34"). */
export function fmtDeltaBtc(delta: number): string {
  const sign = delta >= 0 ? '+' : '−';
  const a = Math.abs(delta);
  const digits = a >= 10 ? 2 : a >= 0.1 ? 3 : 4;
  return `${sign}${a.toFixed(digits)}`;
}
