import type { Candle } from '../../shared/types';

/** Which profile family is being computed. */
export type ProfilesMode = 'timeframe' | 'session' | 'custom';

/** Row rendering mode. */
export type VolumeMode = 'volume' | 'bidask';

/** Delta rendering mode. */
export type DeltaMode = 'off' | 'beside' | 'colour';

/** At-scale normalization mode. */
export type AtScaleMode = 'current' | 'each' | 'all';

/** Footnote source label for the loaded candles. */
export type DataStatus = 'loading' | 'cache' | 'live';

export interface VolSettings {
  profiles: ProfilesMode;
  mode: VolumeMode;
  delta: DeltaMode;
  atScale: AtScaleMode;
  /** 'auto' = ~0.05% of price, min tick; a number = manual bin size in USD. */
  binSize: 'auto' | number;
  /** Value area percentage around POC. */
  valueAreaPct: number;
  /** Row opacity (0..1). */
  barOpacity: number;
  showVwapBands: boolean;
  showPoc: boolean;
  showVahVal: boolean;
  colorRow: string;
  colorAsk: string;
  colorBid: string;
  colorPoc: string;
}

/** A user-defined time range (custom profiles). */
export interface VolRange {
  id: string;
  t0: number;
  t1: number;
}

export interface ProfileRow {
  index: number;
  lo: number;
  hi: number;
  price: number;
  /** Quote volume ($). */
  vol: number;
  /** Base volume (BTC). */
  base: number;
  /** Taker-buy quote volume ($). */
  buy: number;
  /** Taker-sell quote volume ($). */
  sell: number;
  delta: number;
}

export interface Profile {
  id: string;
  kind: ProfilesMode;
  label: string;
  t0: number;
  t1: number;
  /** Where the histogram anchor sits: left edge (timeframe) or right edge. */
  anchor: 'left' | 'right';
  rows: ProfileRow[];
  totalUsd: number;
  totalBase: number;
  totalDelta: number;
  pocPrice: number;
  vah: number;
  val: number;
  maxUsd: number;
  maxAbsDelta: number;
  /** Last candle time already folded in. */
  builtThroughT: number;
}

export interface SessionPoint {
  t: number;
  vwap: number;
  p1: number;
  m1: number;
  p2: number;
  m2: number;
}

export interface SessionSeries {
  t0: number;
  t1: number;
  points: SessionPoint[];
}

/** One horizontal overlay line. `inView` is decided by the caller. */
export type LevelKind = 'user' | 'ref' | 'liq-short' | 'liq-long' | 'last';

export interface LevelSpec {
  id: string;
  kind: LevelKind;
  price: number;
  label: string;
}

export interface ViewState {
  start: number;
  end: number;
  priceMin: number;
  priceMax: number;
}

export interface VpLayout {
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  /** Price axis band inside the canvas, right of the plot. */
  axisLeft: number;
  axisRight: number;
  timeTop: number;
  timeH: number;
  paneW: number;
  dockW: number;
  axisW: number;
}

export interface HoverState {
  x: number;
  y: number;
  price: number;
  time: number;
}

/** A profile row hit by the crosshair, for the tooltip + level highlight. */
export interface ProfileHit {
  profile: Profile;
  row: ProfileRow;
}

export interface MockCandle extends Candle {}
