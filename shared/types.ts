import type { Grade, OiQuadrant, Regime, RetestState, SizeAdvice } from '../server/src/config';

export type { Grade, OiQuadrant, Regime, RetestState, SizeAdvice };

export type Side = 'bullish' | 'bearish';

/**
 * Rule 2: every number carries its source and age.
 *
 * `Meta` wraps anything time-sensitive so the UI can render LIVE / DELAYED /
 * STALE from `asOf` alone, and can explain *why* a panel is empty.
 */
export interface Meta {
  /** Epoch ms the value was produced upstream. */
  asOf: number;
  /** Provider id, e.g. 'binance-futures'. */
  source: string;
  /** True when the value is older than the panel's stale threshold. */
  stale: boolean;
  /** Set when the source failed; the UI shows this instead of a number. */
  error?: string;
  /** ms since the last successful fetch, for the "last good" age display. */
  ageMs?: number;
}

export interface Sourced<T> {
  value: T;
  meta: Meta;
}

export interface Unavailable {
  available: false;
  reason: string;
  lastGoodAt: number | null;
}

export function isUnavailable(x: unknown): x is Unavailable {
  return typeof x === 'object' && x !== null && (x as Unavailable).available === false;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Candles and structure
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  closed: boolean;
  /**
   * Binance klines carry taker-buy base volume at index 9. This is what CVD
   * is computed from, so it is free â€” no extra request.
   */
  takerBuyBase?: number;
  /** Taker-buy volume in QUOTE units (Binance kline index 10). CVD is computed from this. */
  takerBuyQuote?: number;
  /** Quote volume (index 7), kept for the tradability score. */
  qv?: number;
  trades?: number;
}

export type Tf = '5m' | '15m' | '1h' | '4h';

export interface Level {
  price: number;
  label: string;
  kind: 'invalidation' | 'liquidity' | 'context' | 'opposing' | 'session' | 'prev-day';
  time: number;
}

export interface PreviousSetup {
  obTime: number;
  obHigh: number;
  obLow: number;
  side: Side;
}

export interface Setup {
  side: Side;
  /** Closed-candle time of the order block. */
  obTime: number;
  obHigh: number;
  obLow: number;
  /** Zone level â€” the anchor price of the whole setup. */
  z: number;
  /** S1 for bullish, R1 for bearish. */
  invalidation: number;
  targets: Level[];
  context: Level[];
  /** 0 when there is no liquidity target. Never an invented multiple. */
  rr: number;
  displacement: number;
  fvg: boolean;
  violated: boolean;
  ageMinutes: number;
  previous: PreviousSetup[];
  /** Phase 3 state machine. */
  retest: RetestState;
  /** Distance from price to Z in ATR. Negative = price already through it. */
  distanceAtr: number;
  /** Phase 3 higher-timeframe context. */
  htf: HtfContext;
}

export interface HtfSetup {
  tf: Tf;
  side: Side | null;
  z: number | null;
  obLow: number | null;
  obHigh: number | null;
  present: boolean;
}

export interface HtfContext {
  /** True when the 5m zone sits inside or touches a same-side 1h/4h zone. */
  aligned: boolean;
  /** True when a fresh opposite-side higher frame is active. */
  conflict: boolean;
  /** Trend from pivot structure on 1h and 4h. */
  trend1h: 'up' | 'down' | 'range';
  trend4h: 'up' | 'down' | 'range';
  setups: HtfSetup[];
  /** Bonus/penalty applied to the conviction score. */
  scoreAdj: number;
}

export interface VolatilityContext {
  atrPct: number;
  atrPercentile: number;
  realisedVolPct: number;
  realisedVolPercentile: number;
  bollingerWidth: number;
  squeeze: boolean;
  /** Historical time-of-day volume profile, UTC hour 0-23. */
  hourlyVolumeProfile: number[];
  /** Which of the usual sessions this hour falls in. */
  session: 'asia' | 'europe' | 'us' | 'off';
}

export interface RelativeStrength {
  vsBtc1h: number;
  vsBtc4h: number;
  vsBtc24h: number;
  vsEth4h: number;
  /** Share of the top 50 beating BTC over 30d. 1.0 = BTC only. */
  btcDominance: number;
  altseasonIndex: number;
}

export type PickRule =
  | 'PICK'
  | 'NOT_PICKED_SECTOR_CAP'
  | 'NOT_PICKED_OUTSIDE_TOP_3'
  | 'NOT_PICKED_EVENT_RISK'
  | 'NOT_PICKED_VETO'
  | 'NOT_PICKED_NO_TRADE'
  | 'NOT_PICKED_LOW_GRADE'
  | 'NOT_PICKED_BLACKOUT'
  | 'NOT_PICKED_UNLOCK'
  | 'NOT_PICKED_NO_LIQUIDITY';

export interface ChecklistTick {
  key: string;
  label: string;
  ok: boolean;
  reason: string;
}

/**
 * Per-component conviction values.
 *
 * `null` means MISSING — the input this component needs was not available.
 *
 * This distinction is the whole point. Before it existed, a missing derivatives
 * feed scored orderFlow and positioning as 0, which is indistinguishable from
 * "the derivatives genuinely say this is bad". The board looked healthy while
 * two of seven components were silently not voting, and grades came out
 * misleadingly low for the wrong reason.
 *
 * A coin with any missing component cannot reach grade A or B. See
 * CONVICTION.GRADES in server/src/config.ts.
 */
export type ConvictionComponents = Record<
  'structure' | 'orderFlow' | 'momentum' | 'positioning' | 'newsEvents' | 'macroRegime' | 'tradability',
  number | null
>;

export interface Conviction {
  score: number;
  grade: Grade;
  side: Side | null;
  components: ConvictionComponents;
  /** Component keys that had no input and are NOT scoring. */
  missing: string[];
  /** True when score is lower than it would be purely because components were missing. */
  scoreIncomplete: boolean;
  /** Active hard vetoes. Non-empty => grade is NO TRADE. */
  vetoes: string[];
  checklist: ChecklistTick[];
  checklistScore: number;
  /** Why this is or is not a pick, shown as the RULE chip. */
  rule: PickRule;
  isPick: boolean;
}

export interface TradePlan {
  symbol: string;
  side: Side;
  entryLow: number;
  entryHigh: number;
  entryMid: number;
  stop: number;
  /** At least one real target, or empty â€” never invented. */
  targets: { label: string; price: number; rr: number }[];
  rr: number;
  /** Set when there is no liquidity target. */
  noRoom: boolean;
  riskPerUnit: number;
  /** null until the user sets account size and risk %. */
  qty: number | null;
  riskAmount: number | null;
  rewardAmount: number | null;
  costs: TradeCosts;
  netR: number | null;
}

export interface TradeCosts {
  feeBps: number;
  feeAmount: number | null;
  /** Expected funding paid (long) or received (short) over the hold window. */
  fundingBps: number;
  fundingAmount: number | null;
  slippageBps: number;
  slippageAmount: number | null;
  /** Sum as basis points of notional. */
  totalBps: number;
}

export interface LeverageCheck {
  impliedLeverage: number | null;
  liqPrice: number | null;
  /** liqPrice distance / stop distance. */
  liqToStopMultiple: number | null;
  ok: boolean;
  note: string;
}

export interface IndiaTax {
  grossProfit: number;
  fees: number;
  tds: number;
  tax: number;
  netAfterTax: number;
  /** Minimum move needed just to break even, in %. */
  breakEvenMovePct: number;
  currency: 'INR' | 'USD';
  /** Flagged [?] in the UI â€” rates need confirmation. */
  unverifiedRates: boolean;
  note: string;
}

export interface AssetRow {
  id: string;
  symbol: string;
  base: string;
  quote: string;
  pair: string;
  name: string;
  sector: string;
  exchange: string;
  price: number;
  changePct: number;
  change1hPct: number;
  change4hPct: number;
  volumeUsd: number;
  marketCapUsd?: number;
  strength: number;
  percentile: number;
  choppiness: number;
  side: Side;
  rank: number;
  prevRank: number | null;
  eventRisk: boolean;
  spark: number[];
  setup: Setup | null;
  vwap: number | null;
  conviction: Conviction | null;
  /** Denormalised from conviction for list rendering convenience. */
  isPick: boolean;
  plan: TradePlan | null;
  leverage: LeverageCheck | null;
  tax: IndiaTax | null;
  derivatives: DerivRow | null;
  /** Max asset-level NIS in 6h, with direction. Drives the row's news dot. */
  newsDot: { nis: number; direction: -1 | 0 | 1; count: number } | null;
  /** Present when a material unlock is inside the look-ahead window. */
  unlock: { date: string; pct: number; cliff: boolean } | null;
  updatedAt: number;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Derivatives â€” Phase 2
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface OiPoint {
  t: number;
  oi: number;
  /** Change vs the previous point, %. */
  changePct: number;
}

export interface LsPoint {
  t: number;
  ratio: number;
}

export interface LiqEvent {
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  usd: number;
  t: number;
}

export interface LiqBuckets {
  m5: number;
  h1: number;
  d1: number;
  longM5: number;
  shortM5: number;
  longH1: number;
  shortH1: number;
  /** True when m5 liquidation USD >= 3 sigma of the trailing 20 windows. */
  cascade: boolean;
  /** forceOrder@arr samples at most 1/symbol/1000ms â€” a lower bound. */
  isSample: boolean;
}

export interface DerivRow {
  symbol: string;
  /** fundingRate normalised to an 8h basis, whatever the symbol's interval. */
  funding8h: number;
  /** z-score of funding8h against its own 30d history. */
  fundingZ: number;
  fundingIntervalH: number;
  fundingLabel: 'NEUTRAL' | 'CROWDED_LONG' | 'CROWDED_SHORT' | 'EXTREME_LONG' | 'EXTREME_SHORT' | 'SQUEEZE_FUEL';
  openInterest: number;
  oiUsd: number;
  oiChange: { m5: number; h1: number; h4: number; d1: number };
  quadrant: OiQuadrant;
  quadrantLabel: string;
  markPrice: number;
  indexPrice: number;
  /** Mark-to-index basis as a percentage. Null when the index looks unreliable. */
  basisPct: number | null;
  longShortAccountRatio: number | null;
  topTraderPositionRatio: number | null;
  /** Positive when retail and top traders disagree. */
  lsDivergence: number | null;
  /** Cumulative volume delta over the recent window. */
  cvd: number;
  cvdSlope: number;
  takerRatio: number | null;
  /** True when price made a high without CVD confirmation. */
  cvdDivergence: boolean;
  liq: LiqBuckets;
  depth: DepthSnapshot | null;
  crossVenue: CrossVenue | null;
  meta: Meta;
}

export interface DepthSnapshot {
  bidUsd: number;
  askUsd: number;
  /** (bid - ask) / (bid + ask), -1..1. */
  imbalance: number;
  spreadBps: number;
  walls: { price: number; usd: number; side: 'bid' | 'ask' }[];
  distanceToPriceBps: number;
  asOf: number;
}

export interface CrossVenue {
  venues: {
    name: string;
    funding8h: number;
    oiUsd: number;
    available: boolean;
  }[];
  fundingSpread: number | null;
  oiConcentration: number | null;
  /** True when one venue is crowded and the others are not. */
  divergence: boolean;
}

export interface OptionsSnapshot {
  symbol: 'BTC' | 'ETH';
  dvol: number | null;
  dvolPercentile: number | null;
  regime: 'COMPRESSED' | 'NORMAL' | 'STRESSED' | null;
  putCallOiRatio: number | null;
  maxPain: { expiry: string; price: number; distancePct: number } | null;
  expiries: { name: string; expiryUtc: number; isNearest: boolean }[];
  meta: Meta;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Scanner output
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface SectorFlow {
  sector: string;
  avgChange: number;
  avgStrength: number;
  members: { symbol: string; changePct: number }[];
  leading: boolean;
  lagging: boolean;
}

export interface MarketPicture {
  bullishCount: number;
  bearishCount: number;
  total: number;
  choppyCount: number;
  dots: {
    symbol: string;
    changePct: number;
    strength: number;
    pick: boolean;
    eventRisk: boolean;
    choppy: boolean;
  }[];
  leadingSector: string | null;
  laggingSector: string | null;
}

export interface ButterflyBucket {
  /** Inclusive lower edge of the bucket, in percent. */
  from: number;
  /** Exclusive upper edge, in percent. Symmetric around 0 for |buckets|. */
  to: number;
  bullish: number;
  bearish: number;
  /** Assets exactly on the spine, kept separate so totals reconcile exactly. */
  flat: number;
  total: number;
  max: number;
}

export interface Butterfly {
  buckets: ButterflyBucket[];
  n: number;
  bullish: number;
  bearish: number;
  flat: number;
  top: number;
  bottom: number;
  /** Where the mass sits, in [-1, 1]. Null when nothing has moved. */
  skew: number | null;
  half: number;
  concentrated: boolean;
}

export interface ScanResult {
  updatedAt: number;
  nextRefreshIn: number;
  stale: boolean;
  reason: string;
  bullish: AssetRow[];
  bearish: AssetRow[];
  sectors: SectorFlow[];
  market: MarketPicture;
  breadthBias: Side | 'two-way';
  totalScanned: number;
  regime: Regime;
  sizeAdvice: SizeAdvice;
  regimeReason: string;
  blackedOut: boolean;
  blackoutReason: string | null;
  /**
   * Butterfly distribution of % moves across the whole universe. Mirrors the
   * engine's own shape so the client never re-derives counts from rows — one
   * definition of "how many coins are up" means the chart and the caption can
   * never disagree.
   */
  butterfly: Butterfly;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// News â€” Phase 6
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type NewsCategory =
  | 'ETF' | 'HACK' | 'STABLE' | 'REG' | 'TECH' | 'LIST' | 'WHALE'
  | 'ADOPT' | 'DISTRESS' | 'LIQ' | 'MACRO' | 'GENERAL';

export type SeverityClass = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NOISE';

export interface NewsReaction {
  horizonMin: number;
  abnormalReturnPct: number | null;
  measuredAt: number | null;
}

export interface NewsItem {
  id: string;
  headline: string;
  url: string;
  source: string;
  tier: number;
  publishedAt: number;
  ageMinutes: number;
  assets: string[];
  sectorHint: string | null;
  macroEntity: string | null;
  jurisdiction: 'US' | 'IN' | 'EU' | 'GLOBAL';
  categories: NewsCategory[];
  tags: string[];
  nis: number;
  severity: number;
  relevance: number;
  sentiment: number;
  direction: -1 | 0 | 1;
  severityClass: SeverityClass;
  expectedBps: number;
  reversalRisk: number;
  corroboration: number;
  sources: number;
  novelty: number;
  noveltyLabel: 'NEW' | 'RECENT' | 'SEEN' | 'STALE';
  isMacro: boolean;
  routine: boolean;
  /** Measured reaction of the asset after this story, once enough time has passed. */
  reactions: NewsReaction[];
  /** Cluster id â€” several feeds carrying the same story. */
  clusterId: string | null;
  surpriseBp: number | null;
  summary: string;
}

export interface NewsFeed {
  updatedAt: number;
  items: NewsItem[];
  counts: Record<SeverityClass, number>;
  byCategory: { category: NewsCategory; count: number }[];
  clusters: { id: string; size: number; headline: string; maxNis: number }[];
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Attribution
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AttributionEntry {
  newsId: string;
  headline: string;
  nis: number;
  direction: -1 | 0 | 1;
  share: number;
  directionScore: number;
}

export interface Attribution {
  symbol: string;
  name: string;
  price: number;
  priceChangePct: number;
  rawReturnPct: number;
  expectedReturnPct: number;
  abnormalReturnPct: number;
  moveZ: number;
  volZ: number;
  significant: boolean;
  coverage: number;
  rawCoverage: number;
  band: 'DRIVEN_BY_NEWS' | 'PARTIALLY_ATTRIBUTED' | 'NO_CLEAR_DRIVER';
  reversalRisk: number;
  entries: AttributionEntry[];
  windowMinutes: number;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Macro, events, flows â€” Phases 5 and 7
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface MacroState {
  fearGreed: { value: number; label: string; change7d: number | null; updatedAt: number } | null;
  stablecoins: StablecoinState | null;
  globalMarket: {
    totalMarketCapUsd: number;
    totalVolumeUsd: number;
    marketCapChange24h: number;
    btcDominance: number;
    ethDominance: number;
    activeCoins: number;
  } | null;
  btc: { price: number; changePct: number } | null;
  /** [V] Persistently positive = US demand proxy; negative = US selling. */
  coinbasePremiumPct: number | null;
  /** [TUNED] float / total market cap â€” "dry powder". */
  dryPowderRatio: number | null;
  etfFlows: EtfFlows | Unavailable;
  options: OptionsSnapshot[];
  india: IndiaGauges;
}

export interface StablecoinState {
  totalUsd: number;
  change7dPct: number | null;
  change30dPct: number | null;
  usdtShare: number | null;
  usdcShare: number | null;
  /** Below 0.995 is a depeg. [V] */
  pegged: { symbol: string; price: number; depegged: boolean }[];
  updatedAt: number;
}

export interface EtfFlows {
  /** Most recent first. */
  days: { date: string; totalUsd: number }[];
  streakDays: number;
  /** [TUNED] Publish only above $250M or 3x the 20-day mean. */
  isUnusual: boolean;
  /** T+1 and structural â€” never an intraday trigger. */
  note: string;
  source: string;
  asOf: number;
}

export interface IndiaGauges {
  vix: number | null;
  usdInr: number | null;
  btcInr: number | null;
  sensex: number | null;
  nifty: number | null;
  niftyChangePct: number | null;
  sensexChangePct: number | null;
  /** Indian exchange price vs global price x USD/INR. Computed, never assumed. */
  inrPremiumPct: number | null;
  premiumSource: string | null;
}

export type EventKind =
  | 'FOMC' | 'CPI' | 'PCE' | 'NFP' | 'PPI' | 'FED_SPEECH'
  | 'FED_MINUTES' | 'JACKSON_HOLE' | 'RBI_MPC' | 'UNLOCK'
  | 'DERIBIT_EXPIRY' | 'CME_EXPIRY' | 'ETF_FLOW_PUBLISH' | 'FUNDING';

export interface MarketEvent {
  id: string;
  kind: EventKind;
  title: string;
  /** Epoch ms, always UTC internally. Rendered in IST. */
  t: number;
  importance: 1 | 2 | 3;
  /**
   * Provenance of the event. These are deliberately distinct rather than a
   * single "verified" flag, because they carry different confidence:
   *   - hardcoded-verified: confirmed against an official source
   *   - scraped: fetched live from an official source we can re-run
   *   - user-provided: transcribed by a human from a page we cannot scrape,
   *     so we trust the entry but cannot independently re-check it
   *   - user-editable: supplied by a local file, same caveat
   */
  source: 'hardcoded-verified' | 'scraped' | 'user-provided' | 'user-editable' | 'bea-scraped';
  detail: string;
  blackout: boolean;
}

export interface EventCalendar {
  updatedAt: number;
  events: MarketEvent[];
  sources: { name: string; ok: boolean; reason: string; asOf: number }[];
}

export interface Unlock {
  token: string;
  date: string;
  /** % of circulating supply. */
  pct: number;
  cliff: boolean;
  category: string;
  /** true when the user has not confirmed it. */
  unverified: boolean;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Indian market â€” Phase 8
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface IndianIndex {
  name: string;
  last: number;
  change: number;
  percentChange: number;
  yearHigh: number | null;
  yearLow: number | null;
}

export interface IndianFnoRow {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  changePct: number;
  strength: number;
  side: Side;
  spark: number[];
}

export interface IndianMarket {
  updatedAt: number;
  session: { state: string; tradeDate: string; message: string };
  open: boolean;
  holidayToday: string | null;
  nextHoliday: { date: string; description: string } | null;
  indices: IndianIndex[];
  fno: IndianFnoRow[];
  /** Set when the Yahoo path failed, so the UI can explain the gap. */
  unavailable: Unavailable | null;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ledger â€” Phase 9
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type Outcome = 'TP1' | 'TP2' | 'TP3' | 'STOP' | 'EXPIRED' | 'OPEN';

export interface SignalSnapshot {
  score: number;
  grade: Grade;
  side: Side;
  components: ConvictionComponents;
  checklist: ChecklistTick[];
  regime: Regime;
  setup: Setup | null;
  plan: TradePlan | null;
  deriv: DerivRow | null;
  sector: string;
  breadth: Side | 'two-way';
  vwap: number | null;
  newsNis: number;
  newsDirection: -1 | 0 | 1;
  /** Frozen at creation so a later veto change cannot rewrite history. */
  vetoes: string[];
}

export interface LedgerStats {
  total: number;
  resolved: number;
  winRate: number | null;
  avgR: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  byGrade: Record<string, { n: number; winRate: number | null; avgR: number | null }>;
  bySide: Record<string, { n: number; winRate: number | null; avgR: number | null }>;
  byRegime: Record<string, { n: number; winRate: number | null; avgR: number | null }>;
  /** Broken down by the veto that blocked the trade. This is how the 14%
   *  event-risk threshold gets judged rather than argued about. */
  byVeto: Record<string, { n: number; winRate: number | null; avgR: number | null }>;
  /** Shadow versus real, head to head. */
  shadowVsReal: Record<string, { n: number; winRate: number | null; avgR: number | null }>;
  byHour: { hour: number; n: number; avgR: number | null }[];
  byComponent: { component: string; correlation: number | null; n: number }[];
  /** Win rate by score bucket — the calibration check. */
  calibration: { bucket: string; lo: number; hi: number; n: number; winRate: number | null }[];
  /** Set when the score does not actually predict. [V] RavenPack-style check. */
  isPredictive: boolean | null;
  message: string;
  /** The floor below which every rate is suppressed. */
  sampleFloor: number;
}

export interface LedgerSignal {
  id: string;
  symbol: string;
  side: Side;
  grade: Grade;
  score: number;
  createdAt: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  stop: number;
  targets: number[];
  snapshot: SignalSnapshot;
  outcome: Outcome;
  resolvedAt: number | null;
  /** Maximum favourable / adverse excursion, expressed in R. */
  mfeR: number | null;
  maeR: number | null;
  priceAtResolve: number | null;
  /** True for grade C and vetoed coins — recorded, but not traded. */
  shadow: boolean;
  vetoReason: string | null;
  rule: string;
}

export interface LedgerStats {
  total: number;
  resolved: number;
  winRate: number | null;
  avgR: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  byGrade: Record<string, { n: number; winRate: number | null; avgR: number | null }>;
  bySide: Record<string, { n: number; winRate: number | null; avgR: number | null }>;
  byRegime: Record<string, { n: number; winRate: number | null; avgR: number | null }>;
  byHour: { hour: number; n: number; avgR: number | null }[];
  byComponent: { component: string; correlation: number | null; n: number }[];
  /** Win rate by score bucket â€” the calibration check. */
  calibration: { bucket: string; lo: number; hi: number; n: number; winRate: number | null }[];
  /** Set when the score does not actually predict. [V] RavenPack-style check. */
  isPredictive: boolean | null;
  message: string;
}

export interface Ledger {
  updatedAt: number;
  signals: LedgerSignal[];
  stats: LedgerStats;
  open: number;
  counts: { total: number; resolved: number; shadow: number };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Journal and alerts â€” Phases 9 and 11
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface JournalTrade {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  entry: number;
  exit: number | null;
  from: string;
  to: string;
  setupTag: string;
  note: string;
  openedAt: number;
  closedAt: number | null;
  pnl: number | null;
  /** Links a journal entry back to the signal that produced it. */
  signalId: string | null;
  netAfterTax: number | null;
}

export interface AlertItem {
  id: string;
  key: string;
  type: string;
  title: string;
  body: string;
  symbol: string | null;
  severity: SeverityClass;
  createdAt: number;
  read: boolean;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Live stream â€” Phase 1
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type StreamMsg =
  | { type: 'snapshot'; scan: ScanResult; derivatives: DerivRow[]; regime: Regime; blackedOut: boolean; ts: number }
  | { type: 'tick'; symbol: string; price: number; changePct: number; ts: number }
  | { type: 'scan'; scan: ScanResult; ts: number }
  | { type: 'derivatives'; rows: DerivRow[]; ts: number }
  | { type: 'liq'; event: LiqEvent; ts: number }
  | { type: 'news'; feed: NewsFeed; ts: number }
  | { type: 'alert'; alert: AlertItem; ts: number }
  | { type: 'status'; connection: Record<string, ConnectionStatus>; ts: number }
  | { type: 'heartbeat'; ts: number };

export interface ConnectionStatus {
  name: string;
  state: 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed';
  since: number;
  lastMessageAt: number | null;
  messages: number;
  reconnects: number;
  /** Gap backfilled by REST after a reconnect, in candles. */
  backfilledCandles: number;
  lastError: string | null;
}

export type PanelState = 'LIVE' | 'DELAYED' | 'STALE' | 'UNAVAILABLE';
