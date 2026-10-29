import type { TerminalInterval } from '../../../shared/types';

export type FootprintShow = 'bid-ask' | 'delta' | 'volume' | 'profile' | 'delta-volume';
export type FootprintRows = 'auto' | '1' | '2' | '5' | '10';
export type FootprintUnits = 'usd' | 'btc';
export type FootprintImbalanceMode = 'diagonal' | 'same';
export type FootprintColorScale = 'linear' | 'sqrt' | 'log';

export interface FootprintSettings {
  show: FootprintShow;
  rows: FootprintRows;
  units: FootprintUnits;
  imbalanceRatio: number;
  minVolumeUsd: number;
  imbalanceMode: FootprintImbalanceMode;
  valueAreaPct: number;
  showBuySellPct: boolean;
  showSummary: boolean;
  showPocTicks: boolean;
  showUaLines: boolean;
  showNpoc: boolean;
  showPrevDay: boolean;
  showRekt: boolean;
  showCellBars: boolean;
  colorScale: FootprintColorScale;
}

export interface FootprintRow {
  /** Centre of the row, so the canvas can map it straight onto the price axis. */
  price: number;
  index: number;
  bidUsd: number;
  askUsd: number;
  bidQty: number;
  askQty: number;
  buyImbalance: boolean;
  sellImbalance: boolean;
}

export interface FootprintNotable {
  id: string;
  price: number;
  side: 'bid' | 'ask';
  usd: number;
  label: string;
}

export interface FootprintCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  volumeUsd: number;
  volumeQty: number;
  buyUsd: number;
  sellUsd: number;
  buyQty: number;
  sellQty: number;
  deltaUsd: number;
  deltaQty: number;
  cumDeltaUsd: number;
  cumDeltaQty: number;
  /** Descending price order. Each `price` is the row centre. */
  rows: FootprintRow[];
  pocPrice: number;
  pocRowPrice: number;
  uaHigh: number | null;
  uaLow: number | null;
  valueAreaHigh: number;
  valueAreaLow: number;
  buyPct: number;
  sellPct: number;
  imbalanceBuy: number;
  imbalanceSell: number;
  notable: FootprintNotable[];
  forming: boolean;
  hidden: boolean;
  readingOverride?: string;
  forceQuiet?: boolean;
}

export type FootprintLevelKind =
  | 'user' | 'prev-day' | 'prev-val' | 'prev-vah' | 'prev-high' | 'prev-low'
  | 'ua' | 'npoc' | 'liq' | 'liq-long' | 'liq-short' | 'plan' | 'plan-buy'
  | 'plan-sell' | 'gamma' | 'session';

export interface FootprintLevel {
  id: string;
  kind: FootprintLevelKind;
  price: number;
  label: string;
  color: string;
  textColor: string;
  dash: number[];
  width: number;
  axisTag: boolean;
  removable?: boolean;
}

export interface FootprintAnnotation {
  id: string;
  kind: 'ua-high' | 'ua-low' | 'npoc';
  price: number;
  label: string;
  fromT: number;
  color: string;
  stale?: boolean;
}

export interface FootprintLiqEvent {
  id: string;
  t: number;
  price: number;
  side: 'long' | 'short';
  usd: number;
}

export interface FootprintDataset {
  symbol: string;
  interval: TerminalInterval;
  rowSize: number;
  baseTick: number;
  candles: FootprintCandle[];
  from: number | null;
  to: number | null;
  lastPrice: number;
  levels: FootprintLevel[];
  annotations: FootprintAnnotation[];
  liqEvents: FootprintLiqEvent[];
  recordStart: number | null;
  source: 'live' | 'mock';
  mock: boolean;
}

export interface FootprintCandleMeta {
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  uaHigh?: number | null;
  uaLow?: number | null;
  valueAreaHigh?: number;
  valueAreaLow?: number;
  cumDeltaUsd?: number;
  cumDeltaQty?: number;
  forming?: boolean;
  hidden?: boolean;
  pocPrice?: number;
  notable?: FootprintNotable[];
  readingOverride?: string;
  forceQuiet?: boolean;
}

export interface FootprintAggregateOptions {
  symbol: string;
  interval: TerminalInterval;
  rowSize: number;
  baseTick: number;
  imbalanceRatio: number;
  minVolumeUsd: number;
  imbalanceMode: FootprintImbalanceMode;
  valueAreaPct: number;
  meta?: Map<number, FootprintCandleMeta>;
  now?: number;
  source?: 'live' | 'mock';
}

export interface PreparedFootprintRow {
  price: number;
  bidUsd: number;
  askUsd: number;
  bidQty?: number;
  askQty?: number;
}

export interface PreparedFootprintCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  closed: boolean;
  rows: PreparedFootprintRow[];
  quietOverride?: boolean;
  pocPrice?: number;
  buyImbalanceRows?: number;
  sellImbalanceRows?: number;
  notable?: FootprintNotable[];
}
