export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function fmtSignedUsd(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const s = fmtUsd(Math.abs(v));
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : '$0';
}

export function fmtPrice(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(decimals);
}

export function fmtPriceNoComma(v: number): string {
  return fmtPrice(v);
}

export function fmtBtc(v: number, price: number): string {
  if (!Number.isFinite(v) || price <= 0) return '—';
  return `${v >= 0 ? '+' : '-'}${Math.abs(v / price).toFixed(2)} BTC`;
}

export function fmtPct(v: number, digits = 2): string {
  return `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(digits)}%`;
}

export function clampNumber(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function prettyTime(t: number, seconds = false): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return seconds ? `${base}:${p(d.getSeconds())}` : base;
}

export function dateTimeLabel(t: number): string {
  const d = new Date(t);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${months[d.getMonth()]} ${p(d.getDate())}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}
