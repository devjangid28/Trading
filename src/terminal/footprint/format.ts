import type { FootprintColorScale, FootprintUnits } from './types';

function trimFixed(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

/** Three significant digits, matching the terminal's summary strip. */
function threeSig(abs: number): string {
  if (abs >= 100) return abs.toFixed(0);
  if (abs >= 10) return abs.toFixed(1);
  return abs.toFixed(2);
}

export function fpCompactUsd(value: number, signed = false): string {
  const sign = signed ? (value > 0 ? '+' : value < 0 ? '-' : '') : value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}${trimFixed(abs / 1_000_000_000, 3)}B`;
  if (abs >= 1_000_000) return `${sign}${threeSig(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${threeSig(abs / 1_000)}K`;
  if (abs > 0) return `${sign}${abs >= 10 ? abs.toFixed(0) : abs.toFixed(2)}`;
  return '0';
}

export function fpSignedUsd(value: number): string {
  return fpCompactUsd(value, true);
}

export function fpCompactQty(value: number, signed = false): string {
  const sign = signed ? (value > 0 ? '+' : value < 0 ? '-' : '') : value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}${threeSig(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${threeSig(abs / 1_000)}K`;
  if (abs >= 1) return `${sign}${abs.toFixed(Math.abs(value) >= 10 ? 2 : 3)}`;
  if (abs > 0) return `${sign}${abs.toFixed(4)}`;
  return '0';
}

export function fpPrice(value: number): string {
  if (!Number.isFinite(value)) return '\u2014';
  const abs = Math.abs(value);
  if (abs >= 1_000) return value.toFixed(2);
  if (abs >= 1) return value.toFixed(3);
  if (abs >= 0.01) return value.toFixed(4);
  if (abs > 0) return value.toFixed(6);
  return '0.00';
}

export function fpPct(value: number, signed = false): string {
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(0)}%`;
}

export function fpSignedPercent(value: number): string {
  if (!Number.isFinite(value)) return '\u2014';
  const sign = value > 0 ? '+' : value < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(value).toFixed(0)}%`;
}

export function fpRatio(value: number): string {
  if (!Number.isFinite(value)) return '\u221e\u00d7';
  if (value >= 100) return `${Math.round(value)}\u00d7`;
  return `${value.toFixed(1)}\u00d7`;
}

export function fpRowSizeText(rowSize: number): string {
  if (rowSize >= 1) return Number.isInteger(rowSize) ? String(rowSize) : rowSize.toFixed(1);
  if (rowSize >= 0.01) return rowSize.toFixed(2).replace(/0$/, '');
  return rowSize.toFixed(4).replace(/0+$/, '');
}

export function fpTimeLocal(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fpClockLocal(t: number): string {
  return fpTimeLocal(t);
}

export function fpUtcStamp(t: number | null): string {
  if (t === null || !Number.isFinite(t)) return 'From \u2014';
  const date = new Date(t).toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `From ${date} UTC`;
}

export function scaleSize(value: number, maximum: number, scale: FootprintColorScale): number {
  if (!(value > 0) || !(maximum > 0)) return 0;
  const raw = Math.max(0, Math.min(1, value / maximum));
  if (scale === 'linear') return raw;
  if (scale === 'sqrt') return Math.sqrt(raw);
  return Math.log10(1 + raw * 9);
}

export function fpUnitsLabel(units: FootprintUnits): string {
  return units === 'usd' ? '$' : 'BTC';
}

export function fpQtyFromUsd(usd: number, price: number): number {
  return price > 0 ? usd / price : 0;
}

export function compact(value: number, units: FootprintUnits, signed = false): string {
  return units === 'btc' ? fpCompactQty(value, signed) : fpCompactUsd(value, signed);
}
