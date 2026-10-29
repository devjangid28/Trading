import type { TerminalTrade } from '../../shared/types';
import type { BookFrame } from './math';
import { frameRowTotals, rowIndexForPrice, rowPriceRange, tapeThresholdUsd } from './heatmap';
import { localClock } from './heatmap';
import type { ColumnKey, SizeUnit, VolumeOver } from './settings';
import { COLUMN_LABEL } from './settings';

export function columnWidth(key: ColumnKey): number {
  if (key === 'superdom') return 130;
  if (key === 'tape') return 205;
  if (key === 'book') return 140;
  if (key === 'delta') return 88;
  if (key === 'cum' || key === 'cdelta') return 82;
  return 70;
}

export function columnWidths(columns: readonly ColumnKey[]): number[] {
  return columns.map(columnWidth);
}

export interface ColumnsInput {
  ctx: CanvasRenderingContext2D;
  x: number;
  width: number;
  headerH: number;
  bodyTop: number;
  bodyH: number;
  bottom: number;
  columns: ColumnKey[];
  colRows: number;
  priceMin: number;
  priceMax: number;
  frames: readonly BookFrame[];
  trades: readonly TerminalTrade[];
  latest: BookFrame | null;
  mid: number;
  start: number;
  end: number;
  spanLabel: string;
  sizeUnit: SizeUnit;
  volumeOver: VolumeOver;
  tapeMin: import('./settings').TapeMin;
  hoverPrice: number | null;
}

interface RowValues {
  bid: Float64Array;
  ask: Float64Array;
  buy: Float64Array;
  sell: Float64Array;
  delta: Float64Array;
  svp: Float64Array;
  cqc: Float64Array;
}

function emptyValues(rows: number): RowValues {
  return {
    bid: new Float64Array(rows),
    ask: new Float64Array(rows),
    buy: new Float64Array(rows),
    sell: new Float64Array(rows),
    delta: new Float64Array(rows),
    svp: new Float64Array(rows),
    cqc: new Float64Array(rows),
  };
}

function buildValues(input: ColumnsInput): RowValues {
  const rows = input.colRows;
  const values = emptyValues(rows);
  const { priceMin, priceMax } = input;
  if (input.latest) {
    const totals = frameRowTotals(input.latest, priceMin, priceMax, rows);
    values.bid.set(totals.bid);
    values.ask.set(totals.ask);
  }
  for (const trade of input.trades) {
    if (trade.t < input.start || trade.t > input.end) continue;
    if (trade.price < priceMin || trade.price > priceMax) continue;
    const row = rowIndexForPrice(trade.price, priceMin, priceMax, rows);
    if (trade.side === 'buy') {
      values.buy[row] += trade.usd;
      values.delta[row] += trade.usd;
    } else {
      values.sell[row] += trade.usd;
      values.delta[row] -= trade.usd;
    }
  }
  for (const trade of input.trades) {
    if (input.volumeOver === 'span' && (trade.t < input.start || trade.t > input.end)) continue;
    if (trade.price < priceMin || trade.price > priceMax) continue;
    values.svp[rowIndexForPrice(trade.price, priceMin, priceMax, rows)] += trade.usd;
  }

  const seen = new Map<string, number>();
  for (const frame of input.frames) {
    if (frame.source !== 'live' || !frame.bids.length) continue;
    for (const side of ['bid', 'ask'] as const) {
      for (const level of side === 'bid' ? frame.bids : frame.asks) {
        if (level.price < priceMin || level.price > priceMax) continue;
        const key = `${side}:${level.price}`;
        const before = seen.get(key);
        if (before !== undefined && Math.abs(before - level.usd) > 0) {
          values.cqc[rowIndexForPrice(level.price, priceMin, priceMax, rows)] += 1;
        }
        seen.set(key, level.usd);
      }
    }
  }
  return values;
}

function compact(v: number): string {
  if (!(v > 0)) return '\u2014';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

function signed(v: number): string {
  if (Math.abs(v) < 0.5) return '\u2014';
  const sign = v > 0 ? '+' : '\u2212';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function compactSize(v: number, unit: SizeUnit, mid: number): string {
  if (unit === 'coin') {
    const qty = mid > 0 ? v / mid : 0;
    if (!(qty > 0)) return '\u2014';
    if (qty >= 1e6) return `${(qty / 1e6).toFixed(2)}M`;
    if (qty >= 1e3) return `${(qty / 1e3).toFixed(1)}K`;
    if (qty >= 10) return qty.toFixed(1);
    if (qty >= 1) return qty.toFixed(2);
    return qty.toFixed(qty >= 0.01 ? 3 : 5);
  }
  return compact(v);
}

function rowText(row: number, rows: number, priceMin: number, priceMax: number, decimals: number): string {
  const { low, high } = rowPriceRange(row, priceMin, priceMax, rows);
  return ((low + high) / 2).toFixed(decimals);
}

function drawHeader(
  ctx: CanvasRenderingContext2D,
  key: ColumnKey | 'bid' | 'ask',
  x: number,
  width: number,
  headerH: number,
  input: ColumnsInput,
  latestBid: number,
  latestAsk: number,
  delta: number,
  tapeBuy: number,
  tapeSell: number,
): void {
  const label = key === 'bid' || key === 'ask' ? key : COLUMN_LABEL[key];
  ctx.fillStyle = '#070a11';
  ctx.fillRect(x, 0, width, headerH);
  ctx.strokeStyle = 'rgba(148,163,184,0.14)';
  ctx.beginPath();
  ctx.moveTo(x + 0.5, 0);
  ctx.lineTo(x + 0.5, input.bottom);
  ctx.stroke();
  ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#aeb6c4';

  if (key === 'delta') {
    ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(`\u0394 ${input.spanLabel}`, x + 5, 10);
    ctx.textAlign = 'right';
    ctx.fillStyle = delta >= 0 ? '#4ade80' : '#f87171';
    ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(signed(delta), x + width - 5, 10);
  } else if (key === 'bid') {
    ctx.fillStyle = '#4ade80';
    ctx.fillText('bid $', x + 5, 10);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#4ade80';
    ctx.fillText(compact(latestBid), x + width - 5, 10);
  } else if (key === 'ask') {
    ctx.fillStyle = '#f87171';
    ctx.fillText('ask $', x + 5, 10);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f87171';
    ctx.fillText(compact(latestAsk), x + width - 5, 10);
  } else if (key === 'tape') {
    const threshold = tapeThresholdUsd(input.tapeMin, input.trades);
    const thresholdText = threshold >= 100_000
      ? `$${Math.round(threshold / 1e3)}K`
      : threshold >= 1e3 ? `$${(threshold / 1e3).toFixed(1)}K` : `$${threshold.toFixed(0)}`;
    ctx.font = '700 7.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(`tape \u2265 ${thresholdText}`, x + 5, 9);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#5e6a7a';
    ctx.font = '7px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('last 1 min', x + width - 5, 9);
    const barW = Math.max(1, width - 10);
    const total = tapeBuy + tapeSell;
    ctx.fillStyle = 'rgba(248,113,113,0.55)';
    ctx.fillRect(x + 5, 17, barW, 3);
    if (total > 0) {
      ctx.fillStyle = 'rgba(74,222,128,0.85)';
      ctx.fillRect(x + 5, 17, barW * (tapeBuy / total), 3);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#86efac';
    ctx.font = '700 8px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(`B $${compact(tapeBuy)}`, x + 5, 28);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fca5a5';
    ctx.fillText(`S $${compact(tapeSell)}`, x + width - 5, 28);
  } else if (key === 'cdelta') {
    ctx.fillText('CUM \u0394', x + 5, 10);
    ctx.textAlign = 'right';
    ctx.fillStyle = delta >= 0 ? '#4ade80' : '#f87171';
    ctx.fillText(signed(delta), x + width - 5, 10);
  } else if (key === 'superdom') {
    ctx.fillText('SUPERDOM', x + 5, 10);
    ctx.fillStyle = '#8b93a1';
    ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('sold  bid  price  ask  bought', x + 5, 24);
  } else if (key === 'svp') {
    ctx.fillText(label, x + 5, 10);
    ctx.fillStyle = '#8b93a1';
    ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(input.volumeOver === 'span' ? 'this span' : 'session*', x + 5, 24);
  } else if (key === 'cqc') {
    ctx.fillText(label, x + 5, 10);
    ctx.fillStyle = '#8b93a1';
    ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('requotes', x + 5, 24);
  } else {
    ctx.fillText(label, x + 5, 10);
    ctx.fillStyle = '#8b93a1';
    ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(key === 'cob' ? 'current' : key === 'size' ? 'resting' : '', x + 5, 24);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawAlignedColumn(
  ctx: CanvasRenderingContext2D,
  key: ColumnKey | 'bid' | 'ask',
  x: number,
  width: number,
  input: ColumnsInput,
  values: RowValues,
  decimals: number,
): void {
  const rows = input.colRows;
  const rowH = input.bodyH / rows;
  const midRow = rowIndexForPrice(input.mid || (input.priceMin + input.priceMax) / 2, input.priceMin, input.priceMax, rows);
  const cumBid = new Float64Array(rows);
  const cumAsk = new Float64Array(rows);
  let run = 0;
  for (let row = midRow; row >= 0; row--) { run += values.bid[row]; cumBid[row] = run; }
  run = 0;
  for (let row = midRow; row < rows; row++) { run += values.ask[row]; cumAsk[row] = run; }
  const cumDelta = new Float64Array(rows);
  run = 0;
  for (let row = midRow; row >= 0; row--) { run += values.delta[row]; cumDelta[row] = run; }
  run = 0;
  for (let row = midRow; row < rows; row++) { run += values.delta[row]; cumDelta[row] = run; }

  let max = 1;
  for (let row = 0; row < rows; row++) {
    const v = key === 'cum' ? Math.max(cumBid[row], cumAsk[row])
      : key === 'cdelta' ? Math.abs(cumDelta[row])
        : key === 'volume' ? values.buy[row] + values.sell[row]
          : key === 'size' ? values.bid[row] + values.ask[row]
            : key === 'bid' ? values.bid[row]
              : key === 'ask' ? values.ask[row]
                : Math.max(values.bid[row], values.ask[row]);
    if (v > max) max = v;
  }

  const hoverRow = input.hoverPrice === null ? -1 : rowIndexForPrice(input.hoverPrice, input.priceMin, input.priceMax, rows);
  const priceDecimals = decimals;

  for (let row = 0; row < rows; row++) {
    const y = input.bodyTop + row * rowH;
    if (row === hoverRow) {
      ctx.fillStyle = 'rgba(229,231,235,0.06)';
      ctx.fillRect(x, y, width, rowH);
    } else if (row % 2 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.012)';
      ctx.fillRect(x, y, width, rowH);
    }
    ctx.strokeStyle = 'rgba(148,163,184,0.05)';
    ctx.beginPath();
    ctx.moveTo(x, y + rowH);
    ctx.lineTo(x + width, y + rowH);
    ctx.stroke();

    const textY = y + rowH / 2;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const innerW = Math.max(4, width - 10);

    if (key === 'bid' || key === 'ask') {
      const v = key === 'bid' ? values.bid[row] : values.ask[row];
      const w = (v / max) * innerW;
      const color = key === 'bid' ? 'rgba(47,158,68,0.34)' : 'rgba(178,58,58,0.34)';
      if (v > 0) {
        ctx.fillStyle = color;
        ctx.fillRect(x + width - 5 - w, y + 1, w, Math.max(1, rowH - 2));
      }
      ctx.textAlign = 'right';
      ctx.fillStyle = v > 0 ? (key === 'bid' ? '#b7f7c4' : '#ffc1c1') : '#4b5563';
      ctx.fillText(v > 0 ? compactSize(v, input.sizeUnit, input.mid) : '\u2014', x + width - 5, textY);
    } else if (key === 'delta') {
      const delta = values.delta[row];
      const w = (Math.abs(delta) / max) * innerW;
      if (delta >= 0) {
        ctx.fillStyle = 'rgba(47,158,68,0.34)';
        ctx.fillRect(x + width - 5 - w, y + 1, w, Math.max(1, rowH - 2));
      } else {
        ctx.fillStyle = 'rgba(178,58,58,0.34)';
        ctx.fillRect(x + width - 5 - w, y + 1, w, Math.max(1, rowH - 2));
      }
      ctx.textAlign = 'right';
      ctx.fillStyle = delta > 0 ? '#bbf7d0' : delta < 0 ? '#fecaca' : '#6b7280';
      ctx.fillText(delta === 0 ? '\u2014' : signed(delta), x + width - 5, textY);
    } else if (key === 'volume') {
      const buy = values.buy[row];
      const sell = values.sell[row];
      const total = buy + sell;
      const w = (total / max) * innerW;
      ctx.fillStyle = 'rgba(47,158,68,0.34)';
      ctx.fillRect(x + 5, y + rowH * 0.22, total > 0 ? (buy / total) * w : 0, rowH * 0.56);
      ctx.fillStyle = 'rgba(178,58,58,0.34)';
      ctx.fillRect(x + 5 + (total > 0 ? (buy / total) * w : 0), y + rowH * 0.22, total > 0 ? (sell / total) * w : 0, rowH * 0.56);
      ctx.textAlign = 'right';
      ctx.fillStyle = total > 0 ? '#d1d5db' : '#4b5563';
      ctx.fillText(total > 0 ? compactSize(total, input.sizeUnit, input.mid) : '\u2014', x + width - 5, textY);
    } else if (key === 'cum') {
      const v = Math.max(cumBid[row], cumAsk[row]);
      const w = (v / max) * innerW;
      ctx.fillStyle = 'rgba(56,189,248,0.22)';
      ctx.fillRect(x + width - 5 - w, y + 1, w, Math.max(1, rowH - 2));
      ctx.textAlign = 'right';
      ctx.fillStyle = '#bae6fd';
      ctx.fillText(v > 0 ? compactSize(v, input.sizeUnit, input.mid) : '\u2014', x + width - 5, textY);
    } else if (key === 'cdelta') {
      const v = cumDelta[row];
      ctx.textAlign = 'center';
      ctx.fillStyle = v > 0 ? '#86efac' : v < 0 ? '#fca5a5' : '#6b7280';
      ctx.fillText(v === 0 ? '\u2014' : signed(v), x + width / 2, textY);
    } else if (key === 'size') {
      const v = values.bid[row] + values.ask[row];
      const w = (v / max) * innerW;
      ctx.fillStyle = 'rgba(250,204,21,0.20)';
      ctx.fillRect(x + width - 5 - w, y + 1, w, Math.max(1, rowH - 2));
      ctx.textAlign = 'right';
      ctx.fillStyle = '#fde68a';
      ctx.fillText(v > 0 ? compactSize(v, input.sizeUnit, input.mid) : '\u2014', x + width - 5, textY);
    } else if (key === 'svp') {
      const v = values.svp[row];
      const w = (v / max) * innerW;
      ctx.fillStyle = 'rgba(167,139,250,0.24)';
      ctx.fillRect(x + width - 5 - w, y + 1, w, Math.max(1, rowH - 2));
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ddd6fe';
      ctx.fillText(v > 0 ? compactSize(v, input.sizeUnit, input.mid) : '\u2014', x + width - 5, textY);
    } else if (key === 'cqc') {
      const v = values.cqc[row];
      ctx.textAlign = 'right';
      ctx.fillStyle = v >= 8 ? '#fcd34d' : v > 0 ? '#cbd5e1' : '#4b5563';
      ctx.fillText(v > 0 ? String(Math.round(v)) : '\u2014', x + width - 5, textY);
    } else if (key === 'cob') {
      const bid = values.bid[row];
      const ask = values.ask[row];
      const total = bid + ask;
      const w = (total / max) * innerW;
      ctx.fillStyle = bid >= ask ? 'rgba(47,158,68,0.30)' : 'rgba(178,58,58,0.30)';
      ctx.fillRect(x + width - 5 - w, y + 1, w, Math.max(1, rowH - 2));
      ctx.textAlign = 'right';
      ctx.fillStyle = total > 0 ? '#d1d5db' : '#4b5563';
      ctx.fillText(total > 0 ? compactSize(total, input.sizeUnit, input.mid) : '\u2014', x + width - 5, textY);
    } else if (key === 'superdom') {
      const sub = width / 5;
      const cells: Array<{ text: string; color: string }> = [
        { text: values.sell[row] > 0 ? compactSize(values.sell[row], input.sizeUnit, input.mid) : '', color: '#f87171' },
        { text: values.bid[row] > 0 ? compactSize(values.bid[row], input.sizeUnit, input.mid) : '', color: '#4ade80' },
        { text: rowText(row, rows, input.priceMin, input.priceMax, priceDecimals), color: '#d1d5db' },
        { text: values.ask[row] > 0 ? compactSize(values.ask[row], input.sizeUnit, input.mid) : '', color: '#f87171' },
        { text: values.buy[row] > 0 ? compactSize(values.buy[row], input.sizeUnit, input.mid) : '', color: '#4ade80' },
      ];
      ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      for (let i = 0; i < cells.length; i++) {
        ctx.fillStyle = cells[i].color;
        ctx.fillText(cells[i].text, x + sub * (i + 0.5), textY, sub - 1);
      }
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    }
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

interface TapeRow {
  trade: TerminalTrade;
  strong: boolean;
}

function drawTape(ctx: CanvasRenderingContext2D, x: number, width: number, input: ColumnsInput): void {
  const threshold = tapeThresholdUsd(input.tapeMin, input.trades);
  const rows: TapeRow[] = input.trades
    .filter((t) => t.t >= input.start && t.t <= input.end && t.usd >= threshold)
    .sort((a, b) => b.t - a.t)
    .slice(0, Math.max(1, Math.floor((input.bottom - input.bodyTop - 4) / 19)))
    .map((trade) => ({ trade, strong: trade.usd >= Math.max(threshold * 5, 100_000) }));
  const rowH = 19;
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < rows.length; i++) {
    const { trade, strong } = rows[i];
    const y = input.bodyTop + i * rowH;
    const buy = trade.side === 'buy';
    ctx.fillStyle = buy
      ? `rgba(47,158,68,${strong ? 0.30 : 0.14})`
      : `rgba(178,58,58,${strong ? 0.30 : 0.14})`;
    ctx.fillRect(x, y, width, rowH);
    ctx.strokeStyle = 'rgba(148,163,184,0.05)';
    ctx.beginPath();
    ctx.moveTo(x, y + rowH);
    ctx.lineTo(x + width, y + rowH);
    ctx.stroke();
    ctx.fillStyle = buy ? '#b7f7c4' : '#ffc1c1';
    ctx.textAlign = 'left';
    ctx.fillText(localClock(trade.t, false), x + 4, y + rowH / 2);
    ctx.fillStyle = '#e5e7eb';
    ctx.fillText(trade.price.toFixed(2), x + 39, y + rowH / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = buy ? '#86efac' : '#fca5a5';
    ctx.fillText(`$${compact(trade.usd)}`, x + width - 4, y + rowH / 2);
  }
  if (!rows.length) {
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'left';
    ctx.fillText('no prints in view', x + 5, input.bodyTop + 14);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

export function drawColumns(input: ColumnsInput): void {
  const { ctx, columns, bodyTop, bodyH, headerH } = input;
  if (!columns.length || input.width <= 0) return;
  const values = buildValues(input);
  const decimals = input.priceMin >= 1000 ? 2 : input.priceMin >= 1 ? 4 : 6;
  let x = input.x;
  let totalDelta = 0;
  for (let i = 0; i < values.delta.length; i++) totalDelta += values.delta[i];

  let tapeBuy = 0;
  let tapeSell = 0;
  const tapeFrom = input.end - 60_000;
  for (const trade of input.trades) {
    if (trade.t < tapeFrom || trade.t > input.end) continue;
    if (trade.side === 'buy') tapeBuy += trade.usd;
    else tapeSell += trade.usd;
  }

  ctx.save();
  ctx.fillStyle = '#070a11';
  ctx.fillRect(input.x, 0, input.width, input.bottom);
  ctx.beginPath();
  ctx.rect(input.x, 0, input.width, input.bottom);
  ctx.clip();
  for (const key of columns) {
    const width = columnWidth(key);
    if (key === 'tape') {
      drawTape(ctx, x, width, input);
    } else if (key === 'book') {
      const half = width / 2;
      drawAlignedColumn(ctx, 'bid', x, half, input, values, decimals);
      drawAlignedColumn(ctx, 'ask', x + half, half, input, values, decimals);
      ctx.fillStyle = '#070a11';
      if (bodyTop + bodyH < input.bottom) ctx.fillRect(x, bodyTop + bodyH, width, input.bottom - bodyTop - bodyH);
    } else {
      drawAlignedColumn(ctx, key, x, width, input, values, decimals);
      ctx.fillStyle = '#070a11';
      if (bodyTop + bodyH < input.bottom) ctx.fillRect(x, bodyTop + bodyH, width, input.bottom - bodyTop - bodyH);
    }
    x += width;
  }

  // Headers are painted last so the first aligned row cannot erase the totals.
  x = input.x;
  for (const key of columns) {
    const width = columnWidth(key);
    if (key === 'book') {
      const half = width / 2;
      drawHeader(ctx, 'bid', x, half, headerH, input, input.latest?.bidUsd ?? 0, input.latest?.askUsd ?? 0, totalDelta, tapeBuy, tapeSell);
      drawHeader(ctx, 'ask', x + half, half, headerH, input, input.latest?.bidUsd ?? 0, input.latest?.askUsd ?? 0, totalDelta, tapeBuy, tapeSell);
    } else {
      drawHeader(
        ctx, key, x, width, headerH, input,
        input.latest?.bidUsd ?? 0,
        input.latest?.askUsd ?? 0,
        totalDelta,
        tapeBuy,
        tapeSell,
      );
    }
    x += width;
  }
  ctx.restore();
}
