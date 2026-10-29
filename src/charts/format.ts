import { fmtPct, fmtUsd } from '../lib/format';

export { fmtPct, fmtUsd };

export function fmtChartPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1) {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (abs >= 0.01) return value.toFixed(4);
  return value.toFixed(6);
}

export function fmtQty(value: number | null | undefined, suffix = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  let text: string;
  if (abs >= 1e9) text = `${(value / 1e9).toFixed(2)}B`;
  else if (abs >= 1e6) text = `${(value / 1e6).toFixed(2)}M`;
  else if (abs >= 1e3) text = `${(value / 1e3).toFixed(2)}K`;
  else if (abs >= 1) text = value.toFixed(2);
  else text = value.toFixed(4);
  return `${text}${suffix}`;
}

export function fmtSignedUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value > 0) return `+${fmtUsd(value)}`;
  if (value < 0) return `-${fmtUsd(Math.abs(value))}`;
  return fmtUsd(0);
}

export function fmtSpread(bid: number | null, ask: number | null, price: number | null): string {
  if (bid === null || ask === null || price === null || !Number.isFinite(bid) || !Number.isFinite(ask) || price <= 0) {
    return 'spread —';
  }
  const spread = Math.max(0, ask - bid);
  const bp = (spread / price) * 10_000;
  return `spread ${spread.toFixed(spread < 1 ? 4 : 2)} · ${bp.toFixed(3)} bp`;
}

export function fmtChange(open: number, close: number): string {
  if (!Number.isFinite(open) || open === 0) return '—';
  return fmtPct(((close - open) / open) * 100);
}

export function fmtUtc(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) return '—';
  return `${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
