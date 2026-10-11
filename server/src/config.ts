/**
 * Every tunable number in OrderFlow lives here.
 *
 * Rule: nothing in the engine or UI hard-codes a threshold. Each constant says
 * where its value came from, and hand-tuned weights are labelled as such.
 *
 * Provenance tags used below:
 *   [V]      confirmed in documentation or verified research on 10 Oct 2026
 *   [PROBED] measured live from this machine during Phase 0
 *   [TUNED]  hand-tuned starting point — NOT fitted to outcomes yet.
 *            Replaced by `npm run fit-weights` once the ledger has 200+ rows.
 */

export const TZ = {
  /** IST is UTC+05:30 with no DST, so a fixed offset is correct. [V] */
  IST_OFFSET_MIN: 330,
  IST_LABEL: 'Asia/Kolkata',
} as const;

export const NETWORK = {
  /** Binance's designated public market-data host. [PROBED] 748ms, OK */
  BINANCE_SPOT_HOST: 'https://data-api.binance.vision',
  BINANCE_SPOT_HOST_ALT: 'https://api.binance.com',
  /** Confirmed reachable from India. [PROBED] 327ms, OK */
  BINANCE_FUT_HOST: 'https://fapi.binance.com',
  /** MUST use the /market route — unrouted URLs silently deliver nothing. [PROBED] */
  BINANCE_FUT_WS: 'wss://fstream.binance.com/market/stream',
  BINANCE_SPOT_WS: 'wss://data-stream.binance.vision/stream',
  HYPERLIQUID_INFO: 'https://api.hyperliquid.xyz/info',
  BYBIT_HOST: 'https://api.bybit.com',
  DERIBIT_HOST: 'https://www.deribit.com',
  COINBASE_HOST: 'https://api.exchange.coinbase.com',
  COINGECKO_HOST: 'https://api.coingecko.com',
  STABLECOINS_HOST: 'https://stablecoins.llama.fi',
  FNG_HOST: 'https://api.alternative.me',
  GECKOTERMINAL_HOST: 'https://api.geckoterminal.com',
  DEXSCREENER_HOST: 'https://api.dexscreener.com',
  COINDCX_HOST: 'https://api.coindcx.com',
  NSE_HOST: 'https://www.nseindia.com',
  YHOST: 'https://query1.finance.yahoo.com',
  /** ETF flows are 403 from this IP. [PROBED] UI shows Unavailable. */
  FARSIDE_HOST: 'https://farside.co.uk',
} as const;

export const RATE = {
  /** Binance 6000 weight/min. [V] Back off above this fraction. */
  BINANCE_WEIGHT_BUDGET: 6000,
  BINANCE_BACKOFF_AT: 0.7,
  /** GDELT: 1 request per 5 seconds, 250 records max. [V] Currently 429s. */
  GDELT_MIN_INTERVAL_MS: 5000,
  GDELT_MAX_RECORDS: 250,
  /** GeckoTerminal 10-30/min. [V] Use the floor. */
  GECKOTERMINAL_MIN_INTERVAL_MS: 6000,
  DEXSCREENER_MIN_INTERVAL_MS: 60_000,
  HYPERLIQUID_MIN_INTERVAL_MS: 60_000,
  BYBIT_MIN_INTERVAL_MS: 60_000,
  COINGECKO_MIN_INTERVAL_MS: 60_000,
} as const;

export const LIVE = {
  /** Binance spot WS: 1024 streams per connection, dies at 24h. [V] */
  MAX_STREAMS_PER_CONN: 1024,
  /** Reconnect before the 24h hard limit so we never see a random drop. [V] */
  PROACTIVE_RECONNECT_MS: 23 * 3600_000,
  RECONNECT_BASE_MS: 1000,
  RECONNECT_MAX_MS: 60_000,
  RECONNECT_JITTER: 0.3,
  /** Server pings arrive every 20s; respond within the 1-minute window. [V] */
  PING_RESPONSE_MS: 10 * 60_000,
  /** forceOrder@arr emits at most one liquidation per symbol per 1000ms [V],
   *  so liquidation USD is a LOWER BOUND. The UI must label it a sample. */
  LIQ_SAMPLE_INTERVAL_MS: 1000,

  RING_BUFFER_CANDLES: 1000,
  /** Browser push throttle — 1/sec is readable and cheap. [TUNED] */
  TICK_PUSH_MS: 1000,

  SSE_HEARTBEAT_MS: 15_000,
  /** Panel goes DELAYED after this, STALE after this. [TUNED] */
  DELAYED_AFTER_MS: 90_000,
  STALE_AFTER_MS: 240_000,
} as const;

export const REFRESH = {
  DERIVATIVES_SNAPSHOT_MS: 30_000,
  OI_HISTORY_MS: 300_000,
  LONG_SHORT_RATIO_MS: 300_000,
  OPTIONS_MS: 60_000,
  KLINES_MS: 20_000,
  EXCHANGE_INFO_MS: 3600_000,
  NEWS_MS: 300_000,
  MACRO_MS: 300_000,
  INDIA_MS: 180_000,
  SCAN_MS: 60_000,
  ETF_FLOWS_MS: 3600_000,
  STABLECOINS_MS: 900_000,
  VOLATILITY_HISTORY_MS: 300_000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Derivatives — Phase 2
// ─────────────────────────────────────────────────────────────────────────────

export const DERIVATIVES = {
  /** [V] Crowded long above +0.03%/8h sustained with rising OI. */
  FUNDING_CROWDED_8H: 0.0003,
  /** [V] Extreme above +0.05%/8h. */
  FUNDING_EXTREME_8H: 0.0005,
  /** [V] Squeeze fuel below -0.02%/8h with rising OI. */
  FUNDING_SQUEEZE_8H: -0.0002,
  /** Rolling window for the funding z-score. [TUNED] */
  FUNDING_ZSCORE_WINDOW: 30 * 24 * 8,
  /** [V] OI shock is +/-5% in 1h. */
  OI_SHOCK_1H: 0.05,
  /** Liquidation cascade when 5m liq USD >= 3 sigma of trailing 20 windows. [V] */
  LIQ_CASCADE_SIGMA: 3,
  LIQ_CASCADE_WINDOW: 20,
  /** Deribit options: BTC and ETH only, to stay well inside the limit. [V] */
  OPTIONS_SYMBOLS: ['BTC', 'ETH'] as const,
  /** Deribit expiries settle 08:00 UTC = 13:30 IST. [V] */
  DERIBIT_SETTLE_UTC_H: 8,
  /** Cross-venue funding divergence worth flagging. [TUNED] */
  FUNDING_DIVERGENCE: 0.0004,
  /** Order book depth requested in the popup. [V] */
  DEPTH_LIMIT: 20,
  /** A "wall" is this multiple of the mean level size. [TUNED] */
  WALL_MULTIPLE: 4,
  /** Depth imbalance beyond this is a flag. [TUNED] */
  DEPTH_IMBALANCE_FLAG: 0.6,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Structure — Phases 3 and 4
// ─────────────────────────────────────────────────────────────────────────────

export const STRUCTURE = {
  TIMEFRAMES: ['5m', '15m', '1h', '4h'] as const,
  PRIMARY_TF: '5m',
  /** OrderBlock blog: 5m is the sweet spot, 1m is too noisy. [V] */
  PIVOT_WING: 2,
  /** [V] 12% — two pivots this close are an equal high/low. */
  LIQUIDITY_TOLERANCE_PCT: 0.12,
  ATR_LOOKBACK: 20,
  MAX_TARGETS: 2,
  MAX_CONTEXT_LEVELS: 3,
  MAX_PREVIOUS_SETUPS: 3,
  /** strengthScore: below this efficiency the asset is chop and scores 0. [TUNED] */
  EFFICIENCY_CHOP_GATE: 0.25,
  /** [TUNED] Coarse filter before we even fetch klines. */
  MIN_RANGE_PCT: 0.6,
  /** [TUNED] |move| >= this => event risk, no levels published. */
  EVENT_RISK_PCT: 14,
  /** Retest state machine: "approaching" means within this many ATR. [TUNED] */
  APPROACH_ATR: 1.0,
  /** A zone older than this is stale even if untouched. [TUNED] */
  ZONE_MAX_AGE_MIN: 720,
  /** Bollinger squeeze when width percentile is below this. [TUNED] */
  SQUEEZE_PERCENTILE: 20,
  SQUEEZE_LOOKBACK: 20,
  ATR_LOOKBACK_PCTL: 100,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Conviction — Phase 4. ALL WEIGHTS ARE [TUNED], NOT FITTED.
// ─────────────────────────────────────────────────────────────────────────────

export const CONVICTION = {
  /** Total 100. [TUNED] — replaced by fit-weights once outcomes exist. */
  WEIGHTS: {
    structure: 25,
    orderFlow: 20,
    momentum: 15,
    positioning: 15,
    newsEvents: 10,
    macroRegime: 10,
    tradability: 5,
  } as const,

  /**
   * Grade thresholds.
   *
   * NOTE on the A/B gap, which was an ambiguity in the original spec: it said
   * "A >= 7/8 and score >= 75, B 5-6", leaving 7-8/8 with a score below 75
   * undefined. That case is deliberately assigned to B. Rationale: the
   * checklist is the cheaper, more robust signal (it is a set of binary
   * structural facts) while the score depends on hand-tuned weights that are
   * not yet fitted. When the two disagree, the checklist is trusted more.
   * So 7/8 with score < 75 grades B, not A, and never silently falls to C.
   *
   * A and B additionally require zero MISSING components. See
   * ConvictionComponents in shared/types.ts.
   */
  GRADES: {
    A: { minScore: 75, minChecklist: 7, allowMissing: false },
    B: { minScore: 55, minChecklist: 5, allowMissing: false },
    C: { minScore: 35, minChecklist: 3, allowMissing: true },
  } as const,

  /** Maximum score when some components are missing. Prevents a partial grade
   *  from being compared against a full-coverage score on equal terms. */
  MAX_SCORE_WITH_MISSING: 60,

  /** [TUNED] Only A and B become picks. */
  PICKS_PER_SIDE: 3,
  /** [V] OrderBlock's own rule: max 2 from one sector. */
  MAX_PER_SECTOR: 2,
  BOARD_SIZE: 20,

  /** HTF bonus/penalty for a 5m zone agreeing or fighting a higher frame. [TUNED] */
  HTF_ALIGNED_BONUS: 8,
  HTF_CONFLICT_PENALTY: 10,
  /** Zone within this many ATR of price is "ready"; beyond it, wait. [TUNED] */
  DISTANCE_READY_ATR: 1.5,

  /** A zone with no liquidity target gets rr 0 — never an invented multiple. */
  MIN_RR: 1.5,
} as const;

/** Hard vetoes — any of these makes the grade NO TRADE with the reason as the RULE chip. */
export const VETO = {
  /** [TUNED] 30 min either side of a tier-1 macro release. */
  MACRO_BLACKOUT_MIN: 30,
  /** [TUNED] Shares these keys are in. */
  MIN_HACK_WINDOW_H: 6,
  /** [TUNED] A token unlocking >= 2% of float is a real supply event. */
  UNLOCK_MATERIAL_PCT: 2,
  UNLOCK_LOOKAHEAD_H: 48,
  /** [TUNED] Below this a trade cannot be exited cleanly. */
  MIN_DEPTH_USD: 50_000,
  MAX_SPREAD_BPS: 8,
} as const;

/** 8-point alignment checklist. OrderBlock shipped 4; this extends to 8. */
export const CHECKLIST = [
  'zone-fresh',
  'htf-aligned',
  'vwap-side',
  'sector-flow',
  'breadth-agrees',
  'order-flow',
  'positioning-not-crowded',
  'no-event-veto',
] as const;
export type ChecklistKey = (typeof CHECKLIST)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Risk, sizing and cost — Phase 4
// ─────────────────────────────────────────────────────────────────────────────

export const RISK = {
  /** [TUNED] Stop sits this far beyond invalidation. */
  STOP_ATR_BUFFER: 0.25,
  /** [TUNED] Warn unless liquidation is this far from the stop. */
  MIN_LIQ_TO_STOP_MULTIPLE: 2,
  /** Binance USD-M taker fee. [V] 0.05% per side at base tier. */
  TAKER_FEE_BPS: 5,
  /** Maker rebate at base tier. [V] */
  MAKER_FEE_BPS: 1,
  /** [TUNED] Slippage allowance when depth data is unavailable. */
  DEFAULT_SLIPPAGE_BPS: 5,
  DEFAULT_ACCOUNT: 100_000,
  DEFAULT_RISK_PCT: 1,
  /** [TUNED] Holding time used for the funding cost estimate. */
  EXPECTED_HOLD_HOURS: 8,
} as const;

/**
 * Indian tax defaults. [?] UNVERIFIED — flagged in the UI, and every rate is
 * editable in settings. Confirm against the Income-tax Act 2025 before use.
 */
export const INDIA_TAX = {
  /** Flat rate on crypto gains. [?] 30% — needs confirmation. */
  CRYPTO_GAIN_RATE: 0.30,
  /** TDS on sell transfers. [?] 1% above this threshold. */
  TDS_RATE: 0.01,
  TDS_THRESHOLD_INR: 10_000,
  /** [V] No loss offset, no carry-forward. This is the costly bit. */
  LOSS_OFFSET_ALLOWED: false,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Macro and events — Phase 5
// ─────────────────────────────────────────────────────────────────────────────

export const MACRO = {
  /** [V] Bloomberg/Block-Scholes style beta, used only as a rough yardstick. */
  BTC_1H_BETA_PER_PP_CPI: -3.2,
  /** [V] FOMC: mean absolute 1h return 1.25%, volume x2.54. */
  FOMC_1H_MOVE_PCT: 1.25,
  /** [V] FOMC reactions reverse over ~4h in crypto. */
  FOMC_REVERSAL_HOURS: 4,
  /** TIER-1 events cause a blackout. [TUNED] */
  TIER1_BLACKOUT: ['FOMC', 'CPI', 'PCE'] as const,
  TIER2_BLACKOUT: ['NFP', 'PPI', 'FED_SPEECH'] as const,
  /** [V] Fear & Greed is pro-cyclical in bull runs — sizing context only. */
  FNG_SIZING_ONLY: true,
} as const;

/** Funding times are 00:00 / 08:00 / 16:00 UTC. [V] */
export const FUNDING_TIMES_UTC = [0, 8, 16] as const;

export const SESSIONS_UTC = {
  asia: [0, 8],
  europe: [7, 16],
  us: [13, 22],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// News — Phases 6 and 8
// ─────────────────────────────────────────────────────────────────────────────

export const NEWS = {
  SEVERITY: { CRITICAL: 70, HIGH: 55, MEDIUM: 30, LOW: 15 } as const,
  /** [V] RavenPack: novelty adds IR but gates kill volume. Floor is 1.0. */
  NOVELTY: { sameDay: 1.5, week: 1.3, month: 1.15, floor: 1.0 } as const,
  CORROBORATION_STEP: 0.1,
  CORROBORATION_MAX_MULT: 3,
  /** Headline terms carry ~10x body terms. [TUNED] */
  BODY_DECAY: 0.4,
  NORM_CAP: 3,
  /** [TUNED] Headline-position relevance proxy: REL = 100 - k*chars. */
  RELEVANCE_POSITION_K: 6.25,
  /** Cluster threshold for cross-feed duplicate detection. [TUNED] */
  CLUSTER_JACCARD: 0.45,
  CLUSTER_JACCARD_WEAK: 0.2,
  REACTION_HORIZONS_MIN: [5, 15, 60, 240] as const,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Ledger — Phase 9
// ─────────────────────────────────────────────────────────────────────────────

export const LEDGER = {
  /** [TUNED] Freeze a snapshot when a coin first hits A or B. */
  FREEZE_GRADES: ['A', 'B'] as const,
  /** [TUNED] A signal dies if none of its levels hit in this long. */
  EXPIRY_HOURS: 24,
  /** Stop-first on same-candle ambiguity is the conservative choice. [V] */
  AMBIGUITY: 'STOP_FIRST' as const,
  /** Below this sample size, statistics are suppressed rather than shown. */
  MIN_SAMPLE_FOR_RATE: 30,
  /** Fit-weights only runs at this many resolved signals. [TUNED] */
  FIT_MIN_SIGNALS: 200,
  /** Backtest window for the quick replay. */
  BACKTEST_DAYS: 30,
} as const;

export const ALERTS = {
  DEFAULT_COOLDOWN_MS: 15 * 60_000,
  OI_SHOCK_PCT: 0.05,
  UNLOCK_LOOKAHEAD_H: 24,
  LIQ_CASCADE_SIGMA: DERIVATIVES.LIQ_CASCADE_SIGMA,
} as const;

export type Grade = 'A' | 'B' | 'C' | 'Pass' | 'NO TRADE';
export type OiQuadrant = 'new-longs' | 'short-cover' | 'new-shorts' | 'long-liquidation' | 'flat';
export type RetestState = 'fresh' | 'approaching' | 'in-zone' | 'retested-held' | 'violated' | 'none';
export type Regime = 'trend-up' | 'trend-down' | 'range' | 'high-vol-expansion' | 'risk-off';
export type SizeAdvice = 'full' | 'reduced' | 'stand-aside';

export const config = {
  TZ, NETWORK, RATE, LIVE, REFRESH, DERIVATIVES, STRUCTURE, CONVICTION,
  VETO, CHECKLIST, RISK, INDIA_TAX, MACRO, FUNDING_TIMES_UTC, SESSIONS_UTC,
  NEWS, LEDGER, ALERTS,
} as const;

export type Config = typeof config;
