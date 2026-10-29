import type { SeverityClass, Side } from '../../shared/types';

export function fmtPrice(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 10_000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (a >= 100) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  if (a >= 0.01) return v.toFixed(4);
  if (a >= 0.0001) return v.toFixed(6);
  return v.toPrecision(4);
}

export function fmtPct(v: number, digits = 2): string {
  const s = v >= 0 ? '+' : '';
  return `${s}${v.toFixed(digits)}%`;
}

export function fmtUsd(v: number): string {
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function fmtCompact(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

export function sideColor(side: Side): string {
  return side === 'bullish' ? 'var(--color-up)' : 'var(--color-down)';
}

export function fmtAge(mins: number): string {
  if (mins < 1) return 'now';
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export const SEVERITY_STYLE: Record<SeverityClass, { bg: string; fg: string; border: string; label: string }> = {
  CRITICAL: { bg: 'rgba(220,38,38,0.14)', fg: '#ef4444', border: 'rgba(220,38,38,0.4)', label: 'Critical' },
  HIGH: { bg: 'rgba(217,119,6,0.14)', fg: '#d97706', border: 'rgba(217,119,6,0.4)', label: 'High' },
  MEDIUM: { bg: 'rgba(59,130,246,0.14)', fg: '#3b82f6', border: 'rgba(59,130,246,0.4)', label: 'Medium' },
  LOW: { bg: 'rgba(107,114,128,0.14)', fg: '#6b7280', border: 'rgba(107,114,128,0.35)', label: 'Low' },
  NOISE: { bg: 'rgba(107,114,128,0.08)', fg: '#9ca3af', border: 'rgba(107,114,128,0.2)', label: 'Noise' },
};

/** Source tier -> colour. T0/1 primary and wire sources read as trustworthy. */
export function tierColor(tier: number): string {
  if (tier <= 6) return '#9ca3af';
  if (tier <= 10) return '#3b82f6';
  if (tier <= 12) return '#8b5cf6';
  return '#16a34a';
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const IST_OFFSET_MIN = 330;

/** Wall-clock time in IST (UTC+05:30, no DST) as HH:MM:SS. */
export function istStamp(ts: number): string {
  const d = new Date(ts + IST_OFFSET_MIN * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** IST wall clock with seconds, for the live header clock. */
export function istClock(ts: number): string {
  const d = new Date(ts + IST_OFFSET_MIN * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** IST date key shaped like NSE's DD-Mon-YYYY. */
export function istDate(ts: number): string {
  const d = new Date(ts + IST_OFFSET_MIN * 60_000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const rawStep = span / Math.max(1, count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

export function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1_000) return 'under 1s';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1_000);
  if (secs === 0 || secs === 60) return `${mins} min`;
  return `${mins}m ${secs}s`;
}
export const fmtDuration = humanizeDuration;
