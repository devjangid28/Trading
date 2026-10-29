import type {
  Grade, OiQuadrant, Regime, RetestState, SizeAdvice, MindRegime,
} from '../server/src/config';

export type { Grade, OiQuadrant, Regime, RetestState, SizeAdvice, MindRegime };

export type Side = 'bullish' | 'bearish';

// ─── The data-integrity gate (spec `data_health`) ───────────────────────────
// Declared here, not in the engine, because the server writes it and the client
// reads it: two definitions of "stale" would drift, and the client already had
// one (`Freshness`) that the server never used.
export type StreamState = 'live' | 'delayed' | 'stale' | 'unavailable' | 'mock';

export interface HealthBlock {
  /** Which stream failed. Matches the `data_health` key it disables. */
  stream: 'price_stream' | 'derivatives' | 'news' | 'macro_blackout' | 'mock';
  /**
   * `block` withholds a trade outright. `degrade` leaves the affected evidence
   * UNMEASURED and caps the grade at C while the setup stays visible.
   */
  severity: 'block' | 'degrade';
  /** The reason in words. Never a bare enum — a silent block is unreadable. */
  reason: string;
}

export interface DataHealth {
  price_stream: StreamState;
  derivatives: StreamState;
  news: StreamState;
  macro_blackout: StreamState;
  /** Streams withholding a trade. Non-empty means `tradable` is false. */
  blocking: HealthBlock[];
  /** Streams whose evidence is unmeasured. Non-blocking by design. */
  degraded: HealthBlock[];
  /** The one boolean the grader reads. */
  tradable: boolean;
  /** The `NO TRADE` sentence. `null` only when tradable and nothing degraded. */
  reason: string | null;
}

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
  /**
   * How this value was derived, when it is not a direct observation.
   *
   * Added because CVD was labelled `source: 'binance-futures'` while actually
   * being computed from SPOT kline taker-buy notional. The number was right and
   * the label was wrong; a proxy that does not announce itself as a proxy is
   * indistinguishable from a measurement.
   */
  derivation?: string;
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

/**
 * Terminal chart intervals. Deliberately wider than `Tf`: the engine reads four
 * closed-candle frames, while the terminal chart is an exploratory view and
 * also offers the 1m/30m/1d bars the reference terminal shows.
 */
export const TERMINAL_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export type TerminalInterval = (typeof TERMINAL_INTERVALS)[number];

/** Heatmap time spans, in the order the terminal renders them. */
export const TERMINAL_SPANS = ['1m', '2m', '5m', '12m', '15m', '30m', '1h', '4h', '1d'] as const;
export type TerminalSpan = (typeof TERMINAL_SPANS)[number];

export interface TerminalBookLevel {
  price: number;
  /** Resting notional at this level. */
  usd: number;
  /**
   * Resting base quantity as returned by the exchange. Optional because older
   * cached payloads and tests carry notional only; the UI derives qty = usd /
   * price when it is absent and never pretends the derived value is exact.
   */
  qty?: number;
}

export interface TerminalTrade {
  /** Binance aggregate-trade id; used to merge REST polls without duplicates. */
  id: number;
  t: number;
  price: number;
  qty: number;
  usd: number;
  /** Aggressor side. `buy` means the taker lifted the ask. */
  side: 'buy' | 'sell';
  /** Number of exchange trades when this point is a server-side time bucket. */
  count?: number;
  /** Bucket width when the server aggregated the tape for a wide span. */
  bucketMs?: number;
}

/**
 * A full spot order book plus the recent tape for one symbol.
 *
 * This is intentionally separate from `DepthSnapshot`: that is a summary for
 * the derivatives panel (20 levels, 60s cache) while the heatmap needs the
 * actual price levels and a fresh timestamp. Reusing the summary would have
 * forced the heatmap to invent the liquidity between its walls.
 */
export interface TerminalBook {
  symbol: string;
  asOf: number;
  lastUpdateId: number;
  bestBid: number;
  bestAsk: number;
  mid: number;
  spreadBps: number;
  bidUsd: number;
  askUsd: number;
  imbalance: number;
  /** Descending price order. */
  bids: TerminalBookLevel[];
  /** Ascending price order. */
  asks: TerminalBookLevel[];
  /** Oldest first. */
  trades: TerminalTrade[];
  /** False when the tape request failed; the book itself may still be live. */
  tradesAvailable: boolean;
  tradeError?: string;
  /** Poll cadence the server's cache was sized for, in ms. */
  pollMs: number;
  /** The server's wall rule, so the client does not invent its own threshold. */
  wallMultiple: number;
  wallPeerLevels: number;
  wallNearPct: number;
}

export interface TerminalCandles {
  symbol: string;
  interval: TerminalInterval;
  asOf: number;
  candles: Candle[];
}

/**
 * One recorded order-book snapshot, compressed onto a symmetric price lattice.
 *
 * The exchange does not expose historical spot depth, so these are genuine
 * samples captured by this server. `bids[0]` is the bin immediately below the
 * mid and `asks[0]` is the bin immediately above it; each following index is
 * one `binBps` further away. Values are resting notional in USD.
 */
export interface TerminalHistoryFrame {
  asOf: number;
  lastUpdateId: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  bidUsd: number;
  askUsd: number;
  binBps: number;
  rangePct: number;
  bids: number[];
  asks: number[];
}

export interface TerminalHistory {
  symbol: string;
  from: number;
  to: number;
  firstAt: number | null;
  lastAt: number | null;
  frameCount: number;
  truncated: boolean;
  binBps: number;
  rangePct: number;
  tradeBucketMs: number;
  frames: TerminalHistoryFrame[];
  /** Oldest first. A `bucketMs` value marks a server-side time bucket. */
  trades: TerminalTrade[];
}

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
  targets: { label: string; price: number; rr: number; netR: number }[];
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
  /** Full base asset ticker, e.g. STRK. NEVER truncated for display. */
  base: string;
  /**
   * Ticker as displayed. Differs from `base` for multiplier-prefixed perps
   * (`1000PEPE` displays as `PEPE`) while `base` keeps the trading symbol.
   */
  displayTicker: string;
  /** Full human name, e.g. "Starknet". Null only when genuinely unknown. */
  displayName: string | null;
  /** Locally-served logo path under /static/logos, or null for the monogram. */
  logoUrl: string | null;
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
  /**
   * The Mind layer's verdict for this row, when the layer is enabled.
   *
   * Optional so historical payloads and any consumer that has not run a Mind
   * pass still typecheck. A row without it is **not** neutral — the UI shows
   * nothing at all rather than fabricating a 50%.
   */
  mind?: MindSignal | null;
  /**
   * The frozen feature vector this row's `mind` verdict came from.
   *
   * Carried on the row so the ledger freeze can store it without recomputing.
   * Kept separate from `mind` because a verdict is a conclusion and a vector is
   * the evidence — they have different lifetimes and are stored differently.
   */
  mindFeatures?: FeatureVector | null;
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

/**
 * Why a value is unavailable.
 *
 * A zero is a claim. `liq: 0` says "no liquidations occurred", which is a
 * different statement from "this feed is not attached". `DATA_SOURCES.md` states
 * the rule directly: a zero reads as "no flow" and that is a lie, so the honest
 * answer is an object carrying the reason.
 */
export interface DerivRow {
  symbol: string;
  /** fundingRate normalised to an 8h basis, whatever the symbol's interval. */
  funding8h: number;
  /**
   * z-score of funding8h against its own 30d history.
   *
   * Null when no funding history has been collected. It was previously a
   * hardcoded `0`, which the UI rendered as "z=0.00" - a placeholder presented
   * under a label that implies a computation. `null` renders as a dash.
   */
  fundingZ: number | null;
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
  /**
   * Cumulative volume delta over the recent window.
   *
   * This is DERIVED from kline taker-buy notional, not from a trade tape. It is
   * a price-action proxy, and `meta.derivation` says so on the row.
   */
  cvd: number;
  cvdSlope: number;
  takerRatio: number | null;
  /** True when price made a high without CVD confirmation. */
  cvdDivergence: boolean;
  /** Liquidations, or the reason there are none. Never a fabricated zero. */
  liq: LiqBuckets | Unavailable;
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
   * The spec's `data_health` block. Present after `enrichContext` has run;
   * `null` for a hand-built scan, which is NOT the same as "healthy" — a missing
   * verdict means "not assessed".
   */
  dataHealth?: DataHealth | null;
  /**
   * Butterfly distribution of % moves across the whole universe. Mirrors the
   * engine's own shape so the client never re-derives counts from rows — one
   * definition of "how many coins are up" means the chart and the caption can
   * never disagree.
   */
  butterfly: Butterfly;
  /**
   * Every scanned coin (not just the board rows), so the depth curve builds its
   * adaptive buckets from the same universe the breadth chips and the boards
   * report. Charting the board rows instead capped the curve at 40 coins
   * against a 95-coin universe and printed two boxes labelled "of 40".
   */
  universeRows: { ticker: string; changePct: number; strength: number }[];
  /**
   * The Mind layer's board-level verdict, when the pass ran.
   *
   * Stored on the result so the `/api/mind/*` routes **read** it rather than
   * recomputing it. Recomputing per request would mean two answers to "what is
   * the regime" on one screen, and it would need the candles again — which a
   * route does not have and would have to re-fetch from upstream.
   */
  mind?: {
    regime: MindRegime;
    /** Every input the classifier consulted, so the verdict can be argued with. */
    regimeEvidence: Array<{ input: string; value: number | string | null; reading: string }>;
    /** The anchor every probability on this board was scored against. */
    base: { rate: number; samples: number; source: 'ledger' | 'prior' };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Order-block fan — the 24h thread series for the Order Block tab
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One tracked asset's 24h path for the fan.
 *
 * `series` is the cumulative % change against the FIRST close of the window, so
 * every thread leaves the same origin (0) and spreads to its end value. It is
 * the shape of the move, not the row's headline number.
 *
 * `changePct` is the venue's rolling-24h ticker change. The two can differ by
 * the few minutes the ticker window leads the closed-candle window, so the UI
 * reads the label from `changePct` and the curve from `series` and never blends
 * them into one figure.
 */
export interface FanAsset {
  base: string;
  pair: string;
  displayTicker: string;
  name: string;
  sector: string;
  price: number;
  changePct: number;
  /** 24h quote volume in USD — the weight for the sector aggregate. */
  volumeUsd: number;
  /** Cumulative % change vs the window's first close; length <= `points`. */
  series: number[];
}

export interface FanPayload {
  updatedAt: number;
  interval: '15m';
  /** Points requested; a `series` shorter than this ends later than the window start. */
  points: number;
  /** Epoch ms of the first and last candle in the common window. */
  from: number;
  to: number;
  /** Assets with a usable series, sorted by 24h change, best first. */
  assets: FanAsset[];
  /** Assets requested but with no series (no fixture in mock mode / fetch failed). */
  missing: number;
  /** True when the payload was served by the fixture replay (mock mode). */
  mock: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live aggregate — the 1-second server-computed market snapshot
// ─────────────────────────────────────────────────────────────────────────────

export interface LiveSector {
  sector: string;
  avgChange: number;
  n: number;
}

export interface LiveMover {
  base: string;
  pair: string;
  price: number;
  changePct: number;
  volumeUsd: number;
}

/**
 * One live source of truth for the numbers that change every second.
 *
 * The server owns this because it is the only place that sees every symbol's
 * tick. The client renders it verbatim rather than deriving counts from the
 * rows it happens to be showing, which is what previously made the breadth
 * chips (universe), the depth curve (board rows) and the board counts three
 * different denominators.
 */
export interface LiveAggregate {
  asOf: number;
  /** Universe size — the ONE denominator for every breadth figure. */
  n: number;
  up: number;
  down: number;
  flat: number;
  /** Coverage: how many universe symbols have produced a tick yet. */
  seen: number;
  sectors: LiveSector[];
  movers: LiveMover[];
  btc: { price: number; changePct: number } | null;
  eth: { price: number; changePct: number } | null;
  /** Venue label for the header reference prices. */
  venue: string;
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
  /**
   * When this attribution was computed, and what it was computed from.
   *
   * Added because the result previously carried `windowMinutes` and nothing
   * else: no timestamp, no source. A panel full of z-scores with no age on them
   * reads as current no matter how old it is.
   */
  asOf: number;
  meta: Meta;
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
/**
   * The frozen feature vector and probability, when the Mind layer is enabled.
   *
   * Optional because 505 signals already exist in the ledger without one. Adding
   * a required field here would make every historical row unreadable, and the
   * alternative - back-filling them - would mean computing features from data
   * that was not available when those signals were taken.
   */
  mind?: MindSnapshot;
  /**
   * The complete, versioned feature record for this decision. Phase XVI step 1.
   *
   * Separate from `mind.features` because the two answer different questions:
   * the vector is what the scorer read, this is the auditable record of what the
   * engine knew — versions, missing-field reasons, data-health state, and the
   * setup/plan/asset identity needed to group performance later.
   *
   * Optional for the same reason as `mind`: historical rows predate it, and
   * back-filling would mean inventing what we did not know.
   */
  featureRecord?: FeatureRecord;
}

/**
 * What the Mind layer concluded for a signal, frozen with it.
 *
 * Kept separate from `FeatureVector` because the two have different lifetimes:
 * the vector describes the market at `asOf`, the verdict describes what we
 * concluded about the signal made at that moment.
 */
export interface MindSnapshot {
  probability: number;
  netExpectedR: number;
  regime: MindRegime;
  confidenceBand: 'high' | 'medium' | 'low';
  drivers: Driver[];
  vetoCodes: string[];
  rank: number;
  /** The vector these numbers came from. Stored, never recomputed on read. */
  features: FeatureVector;
}

// ─── The frozen feature record (Phase XVI step 1) ────────────────────────────
// Defined in `shared/types.ts` so the server writes it and the client reads one
// definition. The BUILDER lives in `server/src/engine/featureStore.ts`; these
// are the wire shapes. Every unmeasured field is `null` plus a reason — see
// `MissingReason`.
export type MissingReason =
  | 'no-derivatives-feed'
  | 'no-liquidation-feed'
  | 'no-open-interest'
  | 'no-news-feed'
  | 'no-calendar'
  | 'no-macro-panel'
  | 'no-fear-greed-history'
  | 'no-dominance-history'
  | 'no-liquidation-tape'
  | 'insufficient-candles'
  | 'field-not-measured'
  | 'not-applicable-side'
  | 'below-sample-floor';

export type Reasoned<T> =
  | { readonly value: T; readonly reason: null }
  | { readonly value: null; readonly reason: MissingReason };

export type Provenance = 'PROBED' | 'TUNED' | 'FITTED' | 'RESEARCHED' | 'EXPERIMENTAL';

export interface ProvenanceEntry {
  id: string;
  value: number | string | boolean | null;
  provenance: Provenance;
  source: string;
}

export interface HtfAlignment {
  m5: Reasoned<Side | 'none'>;
  m15: Reasoned<Side | 'none'>;
  h1: Reasoned<Side | 'none'>;
  h4: Reasoned<Side | 'none'>;
  contradicts: boolean;
}

export interface NewsContext {
  nis: Reasoned<number>;
  direction: Reasoned<-1 | 0 | 1>;
  novelty: Reasoned<'novel' | 'routine' | 'stale'>;
  relevance: Reasoned<number>;
  severity: Reasoned<number>;
  sourceTier: Reasoned<number>;
  corroboration: Reasoned<number>;
  macroMultiplier: Reasoned<number>;
  newsIds: readonly string[];
  abnormalReturnPct: Reasoned<number>;
  btcBeta: Reasoned<number>;
  attributionCoveragePct: Reasoned<number>;
}

export interface DataHealthSnapshot {
  price_stream: string;
  derivatives: string;
  news: string;
  macro_blackout: string;
  tradable: boolean;
  degradedStreams: readonly string[];
}

export interface FeatureRecord {
  readonly engineVersion: string;
  readonly featureSchemaVersion: string;
  readonly calibrationVersion: string;
  readonly configVersion: string;
  readonly modelId: string;
  readonly asOf: number;

  readonly symbol: string;
  readonly base: string;
  readonly assetClass: 'crypto-perp' | 'crypto-spot' | 'indian-equity';
  readonly sector: string;
  readonly betaGroup: string;
  readonly session: Reasoned<string>;

  readonly setupType: string;
  readonly side: Side;
  readonly direction: 'long' | 'short';
  readonly entryZone: readonly [number, number] | null;
  readonly invalidation: Reasoned<number>;
  readonly targets: readonly { label: string; price: number; rr: number }[];
  readonly rr: Reasoned<number>;
  readonly grade: Grade;

  readonly regime: string;
  readonly trend1h: Reasoned<number>;
  readonly trend4h: Reasoned<number>;
  readonly volatilityPercentile: Reasoned<number>;
  readonly atrPct: Reasoned<number>;
  readonly choppiness: Reasoned<number>;
  readonly efficiency: Reasoned<number>;
  readonly vwapDistancePct: Reasoned<number>;
  readonly vwapSide: Reasoned<'above' | 'below' | 'at'>;
  readonly breadth: Reasoned<string>;
  readonly sectorAvgChangePct: Reasoned<number>;
  readonly rankPercentile: Reasoned<number>;
  readonly htf: HtfAlignment;

  readonly cvdUsd: Reasoned<number>;
  readonly delta: Reasoned<number>;
  readonly aggressiveImbalance: Reasoned<number>;
  readonly absorption: Reasoned<number>;
  readonly funding8h: Reasoned<number>;
  readonly oiChange1h: Reasoned<number>;
  readonly basisPct: Reasoned<number>;
  readonly longShortRatio: Reasoned<number>;
  readonly liquidationProximityFrac: Reasoned<number>;

  readonly news: NewsContext;
  readonly dataHealth: DataHealthSnapshot;
  readonly provenance: readonly ProvenanceEntry[];
  readonly missing: readonly { field: string; reason: MissingReason }[];
  readonly vector: FeatureVector;
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
  /**
   * The full monotonicity test behind `isPredictive` (M1.5).
   *
   * `isPredictive` is the two-state summary; this is the evidence. It carries
   * the rank correlation, its bootstrap interval, the permutation p-value, the
   * isotonic slope, and — importantly — a THREE-state verdict, because a
   * ladder whose interval straddles zero is unproven rather than disproven.
   */
  monotonicity: MonotonicityResult;
  message: string;
  /** The floor below which every rate is suppressed. */
  sampleFloor: number;
}

/**
 * One point of the calibration ladder: a score bucket and what it realised.
 */
export interface LadderBucket {
  /** Inclusive lower bound of the score bucket. */
  lo: number;
  /** Exclusive upper bound of the score bucket. */
  hi: number;
  /** How many resolved signals are in the bucket. */
  n: number;
  /** Realised win rate as a FRACTION (0..1). Null when it was suppressed. */
  winRate: number | null;
}

/**
 * The verdict of the calibration monotonicity test.
 *
 * Three states, not two. `INSUFFICIENT_EVIDENCE` means the association is not
 * distinguishable from noise — which is a different statement from
 * `NOT_MONOTONE`.
 */
export type MonotonicityVerdict =
  | 'MONOTONE'
  | 'NOT_MONOTONE'
  | 'INSUFFICIENT_EVIDENCE';

export interface MonotonicityResult {
  verdict: MonotonicityVerdict;
  /** Spearman's rho between score midpoint and win rate. */
  rho: number | null;
  /** Percentile bootstrap interval for rho. */
  rhoCi: [number, number] | null;
  /** Permutation p-value for rho under the null of no association. */
  permutationP: number | null;
  /** Slope of the isotonic fit, in win-rate fraction per score point. */
  isotonicSlope: number | null;
  /** Bootstrap interval for the isotonic slope. */
  isotonicSlopeCi: [number, number] | null;
  /** How many adjacent populated buckets DECREASE. */
  violations: number | null;
  /** The largest single decrease, in win-rate fraction. */
  maxViolation: number | null;
  /**
   * The EFFECT SIZE: the win rate of the highest populated bucket minus the
   * win rate of the lowest.
   *
   * Reported because a rank correlation says nothing about magnitude. A ladder
   * can be perfectly ordered and still move the win rate by one point, and
   * "predictive" without the size of the effect invites over-reading.
   */
  spread: number | null;
  /** Populated buckets the verdict rests on. */
  buckets: number;
  /** Signals inside those buckets. */
  n: number;
  /** Why, in words. Never empty. */
  reason: string;
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
  /**
   * Per-unit risk the signal was sized against, frozen at creation.
   *
   * Added for M3.2: the ledger's R is computed from the outcome and these
   * frozen levels, and the risk has to come from the same place the resolver
   * used. Reading it out of the frozen plan alone would have made the
   * historical rows depend on a nested optional object.
   */
  riskPerUnit: number;
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
  | { type: 'tick'; symbol: string; price: number; changePct: number; ts: number; E?: number }
  | { type: 'scan'; scan: ScanResult; ts: number }
  | { type: 'agg'; agg: LiveAggregate; ts: number }
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

// ─────────────────────────────────────────────────────────────────────────────
// MIND — the probabilistic decision layer (Part XIV, 17 Oct 2026)
// ─────────────────────────────────────────────────────────────────────────────
//
// One rule governs every field below: `null` means "we did not measure this".
// It NEVER means zero. House rule 2 — never invent a number — is enforced by the
// type system here, because a missing conviction component and a zero-scored one
// are exactly the conflation that made the board look healthy while half its
// context was never asked (Part XII, §XII.2).

/** A measured value with its own timestamp, or an explicit absence. */
export type Measured =
  | { value: number; at: number | null }
  | { value: null; at: null };

/**
 * The frozen feature vector stored with every ledger signal.
 *
 * Frozen, because a feature recomputed from later data is a different feature.
 * Re-deriving history from today's candles is how a backtest quietly acquires
 * look-ahead, and it is why this is stored rather than recomputed on read.
 */
export interface FeatureVector {
  /** Symbol this vector describes, e.g. `BTCUSDT`. */
  symbol: string;
  /** The candle-close timestamp the vector is valid AS OF. Everything in it is
   *  derived only from data available at or before this instant. */
  asOf: number;
  side: Side;

  // ── Structure ─────────────────────────────────────────────────────────────
  structure: {
    hasSetup: Measured;
    /** Minutes since the order block formed. */
    obAgeMin: Measured;
    /** Displacement away from the zone in multiples of the local range. */
    displacementX: Measured;
    hasFvg: Measured;
    /** True when a fair-value gap sits nested inside a higher-timeframe zone. */
    fvgInsideHtfOb: Measured;
    /** -1 = 15m, 0 = 1h, +1 = 4h agreement with the side. */
    htf15m: Measured;
    htf1h: Measured;
    htf4h: Measured;
    /** Distance from price to the nearest liquidity pool, as a fraction. */
    liqPoolDistFrac: Measured;
    /** Signed distance from session VWAP. Positive is above. */
    vwapDistFrac: Measured;
    choppiness: Measured;
    /** Retest state as the engine recorded it: fresh → violated. */
    retest: RetestState | null;
    /** The engine's own 0-100 strength, kept so the Mind score can be compared to it. */
    strength: Measured;
  };

  // ── Positioning ───────────────────────────────────────────────────────────
  positioning: {
    /** Funding normalised to an 8h rate, then z-scored over its rolling window. */
    fundingZ: Measured;
    oiChange1h: Measured;
    oiChange4h: Measured;
    oiChange24h: Measured;
    longShortRatio: Measured;
    /** Slope of cumulative volume delta. Positive is buy-aggressive. */
    cvdSlope: Measured;
    /** Distance to the nearest liquidation cluster, as a fraction. Null when no
     *  liquidation feed is available — which is most non-derivatives paths. */
    liqClusterDistFrac: Measured;
    basisPct: Measured;
    /** True when positioning is crowded AGAINST the side. */
    crowdedAgainst: Measured;
  };

  // ── Catalyst ──────────────────────────────────────────────────────────────
  catalyst: {
    /** Highest NIS published in the last 4h before asOf. */
    maxNis4h: Measured;
    /** Attribution coverage as a percentage, 0-100. */
    attributionCoveragePct: Measured;
    /** True when the leading driver is routine price commentary. */
    routineDominates: Measured;
    reversalRisk: Measured;
    /** Direction of the strongest aligned headline: -1, 0, +1. */
    newsDirection: -1 | 0 | 1 | null;
  };

  // ── Regime ────────────────────────────────────────────────────────────────
  regime: {
    btcDominanceTrendPp: Measured;
    ethBtcChangePct: Measured;
    stablecoinFloatUsd: Measured;
    /**
     * The stablecoin float's 24-hour change, in percent.
     *
     * The LEVEL above says how much float exists; this says whether it is
     * arriving or leaving, which is the part that moves prices.
     */
    stablecoinFlow24hPct: Measured;
    fearGreedZ: Measured;
    /** Minutes until the next tier-1 release; negative once inside the window. */
    macroBlackoutMin: Measured;
    /** Bullish share of the board, 0-1. */
    breadthRatio: Measured;
    sectorRelativeStrength: Measured;
  };

  // ── Context ───────────────────────────────────────────────────────────────
  context: {
    /** UTC hour of the candle. */
    hourUtc: Measured;
    session: 'asia' | 'europe' | 'us' | 'off' | null;
    atrPercentile: Measured;
    /** True when the move is large enough to be event risk. */
    eventRisk: Measured;
    /** Fraction of the conviction components that could not be measured. */
    convictionMissingFrac: Measured;
  };

  // ── Microstructure (added 20 Oct 2026, Part XIX) ──────────────────────────
  //
  // Five readings that the brief asked for and that the vector did not have.
  // Every one of them is `absent()` when the underlying feed is not attached,
  // because "not measured" and "measured as zero" are different claims and
  // the second one is how a research tool ends up with an edge that is only a
  // zero that was typed in.
  microstructure: {
    /**
     * Book imbalance: (bid - ask) / (bid + ask), from the depth snapshot.
     *
     * Positive means more bid depth than ask depth.
     */
    bookImbalance: Measured;
    /** The book's spread in bps, from the same snapshot. */
    spreadBps: Measured;
    /**
     * Aggressive buy minus aggressive sell, as a fraction of the total.
     *
     * Computed from the CLOSED candles' taker-buy notional, so it is
     * point-in-time by construction rather than by assertion.
     */
    aggTradeImbalance: Measured;
    /**
     * Net dealer gamma exposure in USD, market-wide.
     *
     * Positive means dealers are long gamma and the market stabilises; negative
     * means they are short gamma and moves amplify. It is a MARKET feature, not
     * an asset feature, so the same value applies to every asset.
     */
    gexUsd: Measured;
  };

  /**
   * Cross-venue premiums.
   *
   * Both are `absent()` unless the caller supplies a reading that was taken at
   * or before `asOf`. Neither has a historical source in this repo, so on the
   * crypto path they are almost always absent — which is the honest state,
   * not a zero.
   */
  crossVenue: {
    /** Coinbase's price over Binance's, in bps. */
    coinbasePremiumBps: Measured;
    /** The India market's premium or discount, in percent. Null on crypto. */
    indiaPremiumPct: Measured;
  };

  // ── Multi-timeframe (added 21 Oct 2026, Engine Lab) ──────────────────────
  //
  // The vector already had ONE frame: the 5m series. The Lab needs the 5m-4h
  // range, because "is this asset trending or chopping" is a statement about
  // several frames at once and a single frame cannot make it.
  //
  // Every field is computed from CLOSED candles only, and each carries the
  // timestamp of the candle it came from.
  timeframes: {
    /** Return over the closed 15m window, in percent. */
    ret15mPct: Measured;
    /** Return over the closed 1h window, in percent. */
    ret1hPct: Measured;
    /** Return over the closed 4h window, in percent. */
    ret4hPct: Measured;
    /** ATR on the 5m frame as a fraction of price (0.01 = 1%). */
    atrPct5m: Measured;
    /** Range of the last closed 1h candle as a percent of its close. */
    range1hPct: Measured;
    /** Where in its own 24h range the last closed 1h candle sits, 0-1. */
    rangePosition1h: Measured;
  };

  // ── Cross-asset (added 21 Oct 2026, Engine Lab) ──────────────────────────
  //
  // BTC is the market. A coin's move is partly BTC's move and partly its own.
  // Beta separates the two, and "the coin moved but BTC did not" is a
  // materially different trade from "the coin moved because BTC moved".
  crossAsset: {
    /** Rolling beta of this asset's returns to BTC's. */
    betaToBtc: Measured;
    /** Correlation of the two return series over the same window. */
    corrToBtc: Measured;
    /** BTC's own return over the window, in percent. */
    btcReturnPct: Measured;
    /** This asset's return minus (beta x BTC's return), in percent. */
    idiosyncraticReturnPct: Measured;
  };

  // ── Liquidations (added 21 Oct 2026, Engine Lab) ─────────────────────────
  //
  // The vector had the DISTANCE to a liquidation cluster. It did not have the
  // liquidation FLOW, which is the thing that actually moves a book.
  liquidations: {
    /** Long liquidations over the window, in USD. */
    longLiqUsd: Measured;
    /** Short liquidations over the window, in USD. */
    shortLiqUsd: Measured;
    /** (long - short) / (long + short). Positive means longs were flushed. */
    netLiqPressure: Measured;
  };

  // ── Order book (added 21 Oct 2026, Engine Lab) ───────────────────────────
  //
  // `microstructure` holds the top-of-book imbalance and the spread. These
  // are the depth-weighted readings: how much size is actually within reach.
  orderbook: {
    /** Depth within 10 bps of the mid, in USD. */
    depthUsd10bps: Measured;
    /** Depth within 50 bps of the mid, in USD. */
    depthUsd50bps: Measured;
    /** Imbalance of the near book only, (bid - ask) / (bid + ask). */
    imbalanceNear: Measured;
    /** Imbalance of the whole attached book, same formula. */
    imbalanceFar: Measured;
  };

  // ── Funding history (added 21 Oct 2026, Engine Lab) ──────────────────────
  //
  // `positioning.fundingZ` is the z-score of the current funding rate. This is
  // the raw series behind it, so a reader can see the SHAPE rather than one
  // standardised number.
  funding: {
    /** The most recent funding rate, as a fraction (0.0003 = +0.03%). */
    last8h: Measured;
    /** Mean funding over the last 24h (three prints). */
    mean24h: Measured;
    /** Lowest funding over the last 24h. */
    min24h: Measured;
    /** Highest funding over the last 24h. */
    max24h: Measured;
  };

  /**
   * The classifier's verdict, frozen alongside the features that produced it so a
   * historical regime can never be re-derived from today's market.
   */
  regimeLabel: MindRegime;
}

/** One named feature's push on the log-odds, for the "why this score" panel. */
export interface Driver {
  feature: string;
  /** Signed contribution to log-odds. */
  contribution: number;
  /** Human-readable justification. Never a bare number. */
  reason: string;
  /**
   * True for "you are reading a thin number" notices rather than "this feature
   * moved the score" — missing-data and coverage warnings.
   *
   * Disclosure drivers are exempt from the top-3 cut. They exist to stop a
   * low-confidence number being read as a confident one, and a warning that
   * loses the argument to a well-measured feature is a warning that does not get
   * shown.
   */
  disclosure?: boolean;
}

/** A hard veto. Presence means the score is 0 and the grade is NO TRADE. */
export interface MindVeto {
  code: string;
  reason: string;
  /** Which rule produced it, so the UI can link to it. */
  rule: 'positioning' | 'macro' | 'catalyst' | 'structure' | 'regime';
}

export interface MindSignal {
  id: string;
  symbol: string;
  side: Side;
  /** Calibrated P(win). Never presented as a binary. */
  probability: number;
  /** Gross expected R from the plan's targets, before costs. */
  expectedR: number;
  /** Expected R after costs. The actionability gate uses this, never `expectedR`. */
  netExpectedR: number;
  regime: MindRegime;
  drivers: Driver[];
  vetoes: MindVeto[];
  confidenceBand: 'high' | 'medium' | 'low';
  /** True only when probability, net R and vetoes all clear their gates. */
  actionable: boolean;
  /** Ranking score: Kelly-inspired edge at MIND.KELLY_FRACTION. */
  rank: number;
  asOf: number;
}

/** One cell of the reliability diagram: predicted bucket vs realised frequency. */
export interface CalibrationBucket {
  /** Inclusive lower bound of the predicted-probability bucket, 0-1. */
  lo: number;
  hi: number;
  /** How many resolved signals landed in this bucket. */
  n: number;
  /** Mean predicted probability in the bucket. */
  meanPredicted: number | null;
  /** Realised win frequency in the bucket. Null below the sample floor. */
  realised: number | null;
}

/**
 * Calibration of the Mind probabilities against resolved outcomes.
 *
 * The headline number is `brier`, and `brierBaseRate` is the score a
 * constant-equal-to-the-base-rate predictor would achieve. A model is only
 * better than nothing when `brier < brierBaseRate` by a meaningful margin.
 */
export interface CalibrationReport {
  updatedAt: number;
  /** Signals considered. 0 when the ledger has never resolved anything. */
  n: number;
  /** Suppressed below MIND.CALIBRATION_MIN_SAMPLES. */
  suppressed: boolean;
  suppressReason: string | null;

  /** Brier score of the Mind probabilities. Lower is better. */
  brier: number | null;
  /** Brier score of always predicting the observed base rate. The bar to beat. */
  brierBaseRate: number | null;
  /** `brierBaseRate - brier`. Positive means the model adds information. */
  brierDelta: number | null;

  /**
   * Decomposition of the Brier score.
   *
   * The standard identity is `brier = reliability − resolution + uncertainty`
   * (Murphy 1972/1973) — resolution **subtracts**, because spreading forecasts
   * away from the base rate is the whole point. It is exact when the
   * conditioning set is the set of distinct forecast values; binning for a
   * readable reliability diagram introduces within-bin variation that leaves a
   * measured `residual` (Stephenson, Coelho & Jolliffe 2008, give the five-term
   * form `REL − RES + UNC + WBV − WBC`).
   *
   * Known finite-sample bias, not corrected: reliability is overestimated and
   * uncertainty underestimated, decaying as 1/n (Ferro & Fricker 2012).
   */
  decomposition: {
    /** Within each predicted-probability bucket, the gap between what we said and what happened. */
    reliability: number | null;
    /** How much the forecasts discriminate outcomes. Larger is better; it subtracts. */
    resolution: number | null;
    /** The base rate's own variance, `o(1−o)`. Fixed by the outcomes, not by the model. */
    uncertainty: number | null;
    /** How far the FORECASTS spread from the base rate (sharpness). Not part of the identity. */
    forecastSpread: number | null;
    /** `reliability − resolution + uncertainty − brier`. Non-zero only because of binning. */
    residual: number | null;
    /** `1 − brier/climatology`. Exact. Positive means better than the constant base rate. */
    brierSkill: number | null;
  } | null;

  baseRate: number | null;
  buckets: CalibrationBucket[];
  /** Per-grade realised win rate and average honest R. */
  byGrade: Array<{ grade: Grade; n: number; winRate: number | null; avgR: number | null }>;
  /** Mean predicted probability per grade, for the "we said Y%, got X%" footnote. */
  predictedByGrade: Array<{ grade: Grade; n: number; meanPredicted: number | null }>;
  /** ISO date of the last weight refit, or null if the weights are still the originals. */
  lastRefitAt: number | null;
  /**
   * True when `brierDelta` clears MIND.BRIER_MEANINGFUL_DELTA. The UI says
   * "better than the base rate" only when this is true — not when the delta is
   * merely positive.
   */
  beatsBaseRate: boolean;
}

/** `GET /api/mind/health` payload. */
export interface MindHealth {
  ok: boolean;
  updatedAt: number;
  regime: MindRegime;
  /** One line per regime input, so the verdict can be argued with. */
  regimeEvidence: Array<{ input: string; value: number | string | null; reading: string }>;
  calibration: CalibrationReport;
  /** Signal counts by band, from the last scan. */
  bands: { high: number; medium: number; low: number; actionable: number; vetoed: number };
  vetoCounts: Array<{ code: string; n: number }>;
  /** Model identity, so a stale reader cannot mistake one model for another. */
  model: {
    id: string;
    /** True while the weights are the shipped [TUNED] values. */
    usingShippedWeights: boolean;
    baseRateSamples: number;
    baseRateSource: 'ledger' | 'prior';
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine Lab — Part XX (21 Oct 2026)
// ─────────────────────────────────────────────────────────────────────────────
//
// The Lab is a supervision surface, not a trading surface. Every field below
// exists so that a reader can tell the difference between "the engine did not
// act" and "the engine could not measure", and between "no edge found" and
// "not enough samples to say".

/**
 * The execution modes the Lab supports.
 *
 * `LIVE` is NOT a member and never will be. Real-money execution is not built;
 * `server/src/engine/lab/executor.ts` holds a disabled stub that says what it
 * would take to enable it.
 */
export type LabMode = 'SHADOW' | 'PAPER' | 'TESTNET';

/**
 * How a losing trade is classified after the fact.
 *
 * `variance` — and its synonym `no-fault-no-change` — is the COMMON case and is
 * explicitly a verdict, not an excuse: a trade that lost with no fault found is
 * the price of being in the sample at all.
 */
export type LabFailureClass =
  | 'variance'
  | 'bad-timing'
  | 'stop-too-tight'
  | 'news-shock'
  | 'regime-misread'
  | 'cost-drag'
  | 'data-problem'
  | 'no-fault-no-change';

/** A model version in the Lab's registry. */
export interface LabModelVersion {
  /** The version string, e.g. `lab-1.0.0`. */
  version: string;
  role: 'CHAMPION' | 'CHALLENGER' | 'RETIRED';
  createdAt: number;
  /** How many resolved trades the model was fitted on. Null when it was never fitted. */
  trainedOnTrades: number | null;
  /** The date the model was fitted. Null when it was never fitted. */
  trainedAt: number | null;
  /** The feature schema it was fitted against, so an old model cannot be applied to a new vector. */
  featureSchema: string;
  /** The fit options, verbatim, so a fit can be reproduced. */
  fit: { lambda: number; iterations: number; learningRate: number; seed: number } | null;
  /** Out-of-sample expectancy in R. Null when the model has not been evaluated. */
  oosExpectancyR: number | null;
  /** Out-of-sample Brier. Null when the model has not been evaluated. */
  oosBrier: number | null;
  /** Out-of-sample log loss. */
  oosLogLoss: number | null;
  /** Out-of-sample decided trades. */
  oosTrades: number | null;
  /** What the promotion gate said, in words. */
  verdict: string | null;
}

/** One row of the walk-forward fold table. */
export interface LabFoldRow {
  index: number;
  trainRows: number;
  testRows: number;
  /** Rows the purge removed from the training set. */
  purged: number;
  /** Rows the embargo removed from the training set. */
  embargoed: number;
  brier: number | null;
  /** The constant-base-rate Brier on the same rows, for comparison. */
  brierBaseRate: number | null;
  logLoss: number | null;
  /** Coverage: the share of test rows the model spoke on. */
  coveragePct: number | null;
  /** The hit rate of the rows it spoke on. */
  winRatePct: number | null;
  netR: number | null;
  /** False when the fold could not be evaluated. The reason is in `skipReason`. */
  evaluable: boolean;
  skipReason: string | null;
}

/** A row of the confidence-tier table. */
export interface LabTierRow {
  /** The threshold, e.g. 0.7. */
  threshold: number;
  /** How many decided trades the tier speaks on. */
  n: number;
  /**
   * The tier's share of decided trades, 0-100.
   *
   * Null when there are no decided trades at all — a zero there would read as
   * "the tier spoke on nothing", which is a different claim.
   */
  coveragePct: number | null;
  /** The realised hit rate, or null when the tier is below the sample floor. */
  hitRatePct: number | null;
  /** The Wilson 95% interval on the hit rate. Null when the tier is below the floor. */
  hitRateCi: [number, number] | null;
  /** The mean net R of the tier's trades. */
  netR: number | null;
  /** Why a number is missing, in words. Null when nothing is missing. */
  reason: string | null;
}

/** A row of the reliability table. */
export interface LabReliabilityRow {
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number | null;
  observed: number | null;
  /** |observed - meanPredicted|, or null when the bucket is empty. */
  gap: number | null;
}

/** The Lab's status panel. `GET /api/lab/status`. */
export interface LabStatus {
  updatedAt: number;
  mode: LabMode;
  /** Always false. Real-money execution is not built. */
  liveAvailable: false;
  running: boolean;
  /** The champion model in force. */
  model: {
    version: string;
    role: 'CHAMPION' | 'CHALLENGER' | 'NONE';
    trainedAt: number | null;
    /** How many resolved trades the model was trained on. */
    trainedOnTrades: number | null;
    featureSchema: string;
  };
  /** The challenger running in shadow beside the champion. Null when there is none. */
  challenger: {
    version: string;
    trainedAt: number | null;
    trainedOnTrades: number | null;
    verdict: string;
  } | null;
  drift: {
    state: 'GREEN' | 'DEGRADED' | 'UNKNOWN';
    liveBrier: number | null;
    validationBrier: number | null;
    liveExpectancyR: number | null;
    validationExpectancyR: number | null;
    /** How many live trades the rolling window holds. */
    n: number;
    /** A sentence saying what the monitor concluded and why. */
    reason: string;
    /** True when the monitor has forced shadow-only. */
    shadowOnlyForced: boolean;
  };
  killSwitch: boolean;
  shadowOnly: boolean;
  dailyLoss: {
    /** Realised P&L today, in USD. Negative is a loss. */
    realisedPnlUsdToday: number;
    /** Realised net R today. */
    realisedNetRToday: number;
    /** The limit, in USD, derived from the account equity and the config percentage. */
    limitUsd: number;
    halted: boolean;
    /** Why the engine is halted, in words. Null when it is not halted. */
    reason: string | null;
  };
  executors: {
    paper: { available: true };
    testnet: {
      available: boolean;
      /** True when the env vars the adapter needs are present. The key is never shown. */
      configured: boolean;
      enabled: boolean;
      /** Why it is unavailable, in words. */
      reason: string;
    };
    live: { available: false; reason: string };
  };
}

/** One thing the engine is considering right now. */
export interface LabDecision {
  /** Stable id for the decision, so the UI can key on it. */
  id: string;
  symbol: string;
  side: 'bullish' | 'bearish';
  /** The candle-close instant the decision was made against. */
  asOf: number;
  /** The model's probability of a win, or null when the model has never been fitted. */
  pWin: number | null;
  /**
   * The interval on `pWin`.
   *
   * Null when there are too few resolved trades to put an interval on — an
   * interval on an unmeasured probability would be a made-up number.
   */
  pWinCi: [number, number] | null;
  /** The expected net R, after costs. Null when it cannot be computed. */
  expectedNetR: number | null;
  /** The features that moved the probability the most, best first. */
  topFeatures: Array<{ name: string; unit: string; value: number; contribution: number }>;
  /** The vetoes that were checked and did NOT fire. */
  vetoesNotFired: Array<{ kind: string; why: string }>;
  /** The reason the engine did not take the trade. Null when it did. */
  skippedReason: string | null;
  /** True when the engine would have taken this. */
  actionable: boolean;
  /** The features at the moment of the decision, frozen. */
  featureSnapshot: FeatureVector | null;
}

/** A fill in the paper/testnet account. */
export interface LabFill {
  id: string;
  at: number;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  /** Quantity in the base asset. */
  qty: number;
  /** Taker fee in quote currency. */
  feeUsd: number;
  /** Slippage allowance in quote currency. */
  slippageUsd: number;
  /** The venue: `PAPER` or `TESTNET`. */
  venue: 'PAPER' | 'TESTNET';
  /** A note saying the costs are MODELLED, where that is true. */
  costNote: string;
}

/** An open paper/testnet position. */
export interface LabPosition {
  id: string;
  symbol: string;
  side: 'bullish' | 'bearish';
  openedAt: number;
  entryPrice: number;
  /** The price as of the last mark. */
  markPrice: number;
  stop: number;
  targets: number[];
  /** Net R as of the last mark, after modelled costs. */
  netR: number | null;
  /** The probability the model published at entry. */
  pWin: number | null;
  /** The expected net R at entry. */
  expectedNetR: number | null;
  sector: string | null;
  /** The venue: `PAPER` or `TESTNET`. */
  venue: 'PAPER' | 'TESTNET';
}

/** The paper/testnet account panel. `GET /api/lab/account`. */
export interface LabAccount {
  updatedAt: number;
  venue: 'PAPER' | 'TESTNET';
  /** Account equity in quote currency. */
  equityUsd: number;
  /** Realised net R to date. */
  realisedNetR: number;
  /** How many trades have been closed. */
  closedTrades: number;
  /** The equity curve, oldest first. */
  equityCurve: Array<{ at: number; equityUsd: number; netR: number }>;
  openPositions: LabPosition[];
  fills: LabFill[];
}

/** One post-trade review row. */
export interface LabReview {
  id: string;
  /** The signal id the review belongs to. */
  signalId: string;
  /** The paper position the review came from. Null when it came from the ledger. */
  positionId: string | null;
  symbol: string;
  side: 'bullish' | 'bearish';
  openedAt: number;
  closedAt: number;
  /** The probability the model published at entry. */
  predictedPWin: number | null;
  /** 1 for a take-profit, 0 for a stop, null for an expiry (censored). */
  outcome: 0 | 1 | null;
  /** What the resolver decided. */
  outcomeLabel: string;
  /** Gross R before costs. */
  grossR: number | null;
  /** Net R after modelled costs. */
  netR: number | null;
  /** The modelled cost, in R. */
  costR: number | null;
  /** The classification of the failure. */
  failureClass: LabFailureClass;
  /** A sentence saying why the engine reached that classification. */
  failureNote: string;
  /** True when the review says the model was right and the outcome was variance. */
  noFault: boolean;
  /** The features at entry. Null when the snapshot was not frozen. */
  featureSnapshot: FeatureVector | null;
  /** The url the UI can open to see the stored snapshot. */
  snapshotUrl: string | null;
}

/** The learning history panel. `GET /api/lab/learning`. */
export interface LabLearning {
  updatedAt: number;
  models: LabModelVersion[];
  /** The walk-forward fold table of the champion. */
  folds: LabFoldRow[];
  /** Every promotion, rejection and rollback, newest first. */
  decisions: Array<{
    at: number;
    /** The model that was considered. */
    version: string;
    /** 'PROMOTED' | 'REJECTED' | 'ROLLED_BACK' | 'RETRAINED'. */
    kind: 'PROMOTED' | 'REJECTED' | 'ROLLED_BACK' | 'RETRAINED';
    /** Why, in words. */
    reason: string;
    /** The champion's expectancy and the challenger's, in R. */
    championExpectancyR: number | null;
    challengerExpectancyR: number | null;
    championBrier: number | null;
    challengerBrier: number | null;
  }>;
  /** The promotion criteria that are not yet met, in words. */
  promotionBlockedBy: string[];
}

/** The calibration panel. `GET /api/lab/calibration`. */
export interface LabCalibration {
  updatedAt: number;
  /** How many decided trades the figures are computed on. */
  n: number;
  /** How many resolved trades were censored (expired) and excluded. */
  censored: number;
  baseRate: number | null;
  brier: number | null;
  /** The constant-base-rate Brier on the same rows. */
  brierBaseRate: number | null;
  /** `1 - brier / brierBaseRate`. */
  brierSkill: number | null;
  logLoss: number | null;
  reliability: LabReliabilityRow[];
  tiers: LabTierRow[];
  /** A sentence saying what the numbers mean, in words. */
  verdict: string;
}

/** The Lab panel as a whole. `GET /api/lab/overview`. */
export interface LabOverview {
  status: LabStatus;
  decisions: LabDecision[];
  account: LabAccount;
  reviews: LabReview[];
  learning: LabLearning;
  calibration: LabCalibration;
  /** The outbound TradingView-style alert message, when there is something to say. */
  alertMessage: LabAlertMessage | null;
}

/**
 * The optional outbound alert message.
 *
 * TradingView's paper-trading account is a manual UI simulator with no public
 * order-placement API. Its only automation is an OUTBOUND alert webhook, so
 * this is a message the user pastes into a TradingView alert or chart note.
 * It is never sent anywhere by this app.
 */
export interface LabAlertMessage {
  symbol: string;
  side: 'bullish' | 'bearish';
  entry: number;
  stop: number;
  targets: number[];
  /** The model's probability of a win, 0-1. Null when the model is unfitted. */
  pWin: number | null;
  /** The model version that produced the message. */
  modelVersion: string;
  /** The whole thing, as a JSON string, ready to paste. */
  json: string;
}

/** The result of a control action. */
export interface LabControlResult {
  ok: boolean;
  /** What happened, in words. */
  message: string;
  /** The status after the action, so the UI does not need a second round trip. */
  status: LabStatus | null;
}

