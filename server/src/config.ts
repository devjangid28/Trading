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
  /**
   * CoinGecko has no documented free-tier quota header we can budget against.
   * Pacing is a floor between requests; the data caches below do the real work.
   * [TUNED] 2s + 5min caches, after a shared-IP 429 with only ~2 calls/min.
   */
  COINGECKO_MIN_INTERVAL_MS: 2_000,
  /** One shared markets payload feeds identity AND altseason. [TUNED] */
  COINGECKO_MARKETS_TTL_MS: 5 * 60_000,
  COINGECKO_GLOBAL_TTL_MS: 5 * 60_000,
} as const;

export const LIVE = {
  /** Binance spot WS: 1024 streams per connection, dies at 24h. [V] */
  MAX_STREAMS_PER_CONN: 1024,
  /** Reconnect before the 24h hard limit so we never see a random drop. [V] */
  PROACTIVE_RECONNECT_MS: 23 * 3600_000,
  RECONNECT_BASE_MS: 1000,
  RECONNECT_MAX_MS: 60_000,
  RECONNECT_JITTER: 0.3,
  /** [V] Binance caps connection attempts per IP. Exceeding it risks a ban. */
  WS_CONNECT_LIMIT: 300,
  /** Rolling window the connection-attempt cap applies over. */
  WS_CONNECT_WINDOW_MS: 5 * 60_000,
  /** Server pings arrive every 20s; respond within the 1-minute window. [V] */
  PING_RESPONSE_MS: 10 * 60_000,
  /** forceOrder@arr emits at most one liquidation per symbol per 1000ms [V],
   *  so liquidation USD is a LOWER BOUND. The UI must label it a sample. */
  LIQ_SAMPLE_INTERVAL_MS: 1000,

  RING_BUFFER_CANDLES: 1000,

  /**
   * Browser push interval.
   *
   * This was 1000ms and it was not a speed choice — it was an admission that
   * `!miniTicker@arr`, the only price stream the socket carried, only publishes
   * once a second. The socket now also carries `<symbol>@aggTrade`, which
   * Binance documents as real-time, so this number is a BANDWIDTH decision
   * again: it bounds how often the browser repaints, not how old a price is.
   *
   * 200ms = 5Hz repaint. A symbol that trades forty times inside one window
   * still collapses to exactly one update, and the newest price wins, because
   * `streamHub.stageTick` is keyed by symbol. At 5Hz with the per-client
   * visible-symbol cap of 200 the whole flush is one `res.write`.
   *
   * [TUNED] 200ms sits below the ~150ms it takes a human to perceive a change
   * as "instant" being a visible claim about the UI, so it is held at 5Hz
   * rather than pushed to the wire rate. Raise it if the stream ever has to
   * scale past one client.
   */
  TICK_PUSH_MS: 200,

  SSE_HEARTBEAT_MS: 15_000,
  /**
   * Per-client symbol budget for /api/stream/visible. A client tells the
   * server which symbols it is actually showing, and the server only pushes
   * ticks for those. This is a subscription cap AND a safety valve: a hostile
   * or buggy client asking for the whole universe is clamped here rather than
   * honoured.
   */
  MAX_VISIBLE_SYMBOLS_PER_CLIENT: 200,

  /**
   * Freshness thresholds.
   *
   * These were 90_000 / 240_000 and that was wrong in a way that mattered. They
   * were tuned when the only live number on screen was a 60s board scan, and
   * they were then reused for PRICE freshness — so a price 85 seconds stale
   * rendered a green LIVE badge. That is the house rule "STALE is never
   * rendered as LIVE" broken by an over-generous constant: the badge was
   * technically reporting what the code believed and the code was wrong.
   *
   * A price feed that is more than a few seconds behind is not live, and a
   * trader looking at a 3-second-old BTC price and a live one is reading a
   * different market. The numbers below are tied to the flush interval: past a
   * few flushes the socket has stopped delivering, and past that the data is
   * not usable.
   *
   * [TUNED] ~15 flushes at TICK_PUSH_MS=200 before DELAYED, and ~3s of
   * further grace before STALE. Derived from the push cadence, not from feel.
   */
  DELAYED_AFTER_MS: 3_000,
  STALE_AFTER_MS: 6_000,
} as const;

/**
 * Universe construction.
 *
 * The scanned universe is no longer a hand-written list. It is built from
 * Binance exchangeInfo (every USDT spot pair with status TRADING) filtered by
 * 24h quote volume. `server/src/data/universe.ts` is kept only as METADATA
 * (name, sector, beta group, tags); a pair without metadata gets sector
 * "Other" and its ticker as a name.
 *
 * This fixes the root-cause bug the diagnostic found: the old scanner keyed
 * tickers by BASE after stripping `(USDT|FDUSD|BUSD)$`, so a base whose
 * alphabetically-first pair was the deprecated BUSD or FDUSD market
 * (e.g. DOTBUSD before DOTUSDT) had its $1M volume test applied to the wrong,
 * thinner book and was dropped. Pair resolution is now explicit: `${base}USDT`,
 * with USDC only as a documented fallback.
 */
export const MIN_UNIVERSE_VOLUME_USD = 5_000_000;

/** Upper bound on scanned pairs, highest volume first. Bounds WS kline load. */
export const UNIVERSE_MAX_PAIRS = 200;

/** Movers panel floor: raw 24h movers above this 24h quote volume. */
export const MOVERS_MIN_VOLUME_USD = 2_000_000;

/** Rebuild the candidate universe at most this often (startup + hourly). */
export const UNIVERSE_REFRESH_MS = 3600_000;

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
// Order-block fan — the 24h thread fan on the Order Block tab
// ─────────────────────────────────────────────────────────────────────────────

export const FAN = {
  /** [V] 15m candles over 24h = 96 points, one identical window for every asset. */
  INTERVAL: '15m',
  POINTS: 96,
  /** Rebuild the fan payload at most this often, matching the scan cadence. [TUNED] */
  TTL_MS: 60_000,
  /** Klines fetched in parallel per batch, inside the weight budget. [TUNED] */
  CONCURRENCY: 12,
  /** Top N by 24h move form the bull/bear sets; the rest are faint background. [TUNED] */
  SET_SIZE: 20,
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
  /**
   * Mainland Binance futures is unreachable from this machine and times out
   * silently. One short attempt decides the primary, then the provider falls
   * back to Bybit rather than spending a full request timeout per symbol.
   * [TUNED] 4s + no retry after the 27 Oct 2026 external block.
   */
  BINANCE_FUT_TIMEOUT_MS: 4_000,
  BINANCE_FUT_RETRIES: 0,
  /** Order book depth requested in the popup. [V] */
  DEPTH_LIMIT: 20,
  /** A "wall" is this multiple of the mean level size. [TUNED] */
  WALL_MULTIPLE: 4,
  /** Depth imbalance beyond this is a flag. [TUNED] */
  DEPTH_IMBALANCE_FLAG: 0.6,
} as const;

/**
 * Terminal chart and order-book heatmap.
 *
 * The heatmap polls a full book rather than the 20-level derivatives summary.
 * Binance's spot depth endpoint accepts 1000 levels; at 2s the response is the
 * dominant cost, so the server caches each symbol briefly and the client asks
 * only for the market it is actually showing.
 */
export const TERMINAL = {
  /** [V] Binance spot /api/v3/depth accepts this maximum. */
  DEPTH_LIMIT: 1_000,
  /** [TUNED] Enough tape for bubbles without shipping the whole day. */
  TRADE_LIMIT: 500,
  /** [TUNED] Slightly under the client poll so a poll never fans out to Binance. */
  BOOK_TTL_MS: 2_500,
  TRADE_TTL_MS: 2_500,
  /** [V] Binance klines maximum page. The terminal asks for a render-sized tail. */
  CHART_LIMIT: 320,
  /** [TUNED] Candle closes only need to be corrected every few seconds. */
  CHART_TTL_MS: 8_000,
  /** [TUNED] Full-depth books are rate-heavy; three seconds keeps the heatmap live. */
  SAMPLE_MS: 3_000,
  /**
   * [TUNED] Server-side depth capture. Saved samples are what survive a reload,
   * so the cadence matches the live heatmap rather than the slower REST fallback.
   */
  HISTORY_SAMPLE_MS: 3_000,
  /** [TUNED] Compact price lattice: 0.5 bp is about one rendered row on BTC. */
  HISTORY_BIN_BPS: 0.5,
  /** [TUNED] Covers the widest fixed range (±1%) with a little edge margin. */
  HISTORY_RANGE_PCT: 0.012,
  /** [TUNED] Keeps a full day plus a buffer for the 1D span. */
  HISTORY_RETENTION_MS: 27 * 60 * 60_000,
  /** [TUNED] One chart can draw this many captured frames without becoming sludge. */
  HISTORY_MAX_FRAMES: 900,
  /** [TUNED] Two active symbols keeps depth weight comfortably below the budget. */
  HISTORY_MAX_SYMBOLS: 2,
  /** [TUNED] Exact tape below this count; wider windows are time-bucketed by SQL. */
  HISTORY_EXACT_TRADES: 12_000,
  /** [TUNED] Target bucket count for a wide-span tape read. */
  HISTORY_TRADE_BUCKETS: 1_800,
  /** [TUNED] Retention cleanup cadence; deleting more often buys nothing. */
  HISTORY_PRUNE_MS: 10 * 60_000,
  /** A wall is this multiple of the median near-touch level. [TUNED] */
  WALL_MULTIPLE: 3,
  /** Compare against the largest N levels, not the dust-heavy full book. [TUNED] */
  WALL_PEER_LEVELS: 20,
  /** Only levels within this fraction of mid are considered "near the touch". [TUNED] */
  WALL_NEAR_PCT: 0.005,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Structure — Phases 3 and 4
// ─────────────────────────────────────────────────────────────────────────────

export const STRUCTURE = {
  TIMEFRAMES: ['5m', '15m', '1h', '4h'] as const,
  PRIMARY_TF: '5m',
  /**
   * How many closed 5-minute candles the engine reads for "today".
   *
   * [V] 289 bars. 288 x 5m is 24h, and that span sits across 289 candles
   * because the oldest bar of the window is the session's opening candle and
   * the newest is the bar in progress - both are included. Every 24h figure
   * this product shows (session VWAP, day change, day high/low) is read over
   * exactly this window.
   *
   * It lives here because it used to be a literal `289` written out in eight
   * places, which is how the board and the asset popup could drift into
   * disagreeing about what "today" means. Read it through
   * `sessionStartIndex()` in engine/orderblock.ts rather than doing the
   * arithmetic yourself.
   */
  SESSION_CANDLES: 289,
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

// ─── HEALTH — the data-integrity gate (Part XV, 17 Oct 2026) ───────────────
// Spec rule 2: "Never generate a signal from incomplete, delayed, stale, mocked,
// or unverified data. If data freshness fails, output NO TRADE with the reason."
//
// The important distinction this group encodes: `BLOCK` means the engine refuses
// to call a setup tradable; `DEGRADE` means the setup is still shown but the
// affected evidence is left UNMEASURED rather than being scored as a real
// reading. Scoring an outage as a mid-range number is the defect this fixes.
export const HEALTH = {
  /** Price stream older than this cannot support a structural decision. [TUNED] */
  MAX_PRICE_AGE_MS: 8_000,
  /**
   * Price is the only stream with a seconds-scale bound. The others are cached
   * for minutes or hours by design and need their own limits — applying the 8s
   * price limit to the macro calendar classified a perfectly healthy 6-hour-old
   * calendar as stale and closed the gate on every single scan. Part XV shipped
   * that bug; the mock probe caught it, which is the argument for probe-first.
   */
  MAX_DERIVATIVES_AGE_MS: 60_000,
  MAX_NEWS_AGE_MS: 60 * 60_000,
  MAX_CALENDAR_AGE_MS: 24 * 3600_000,
  /**
   * The DELAYED boundary, per stream, for the same reason. A 3-second delay
   * tolerance is a price-stream notion; applying it to the macro calendar meant
   * a perfectly normal 6-hour-old published schedule read as `delayed` — and
   * since the spec lists "delayed" as a disqualifier, that blocked the gate on
   * every single scan. The calendar is a schedule, not a ticker: it is not
   * "delayed" for hours at a time.
   */
  DELAYED_PRICE_AFTER_MS: 3_000,
  DELAYED_DERIVATIVES_AFTER_MS: 15_000,
  DELAYED_NEWS_AFTER_MS: 15 * 60_000,
  DELAYED_CALENDAR_AFTER_MS: 12 * 3600_000,
  /**
   * An unavailable calendar BLOCKS. A blackout veto armed by "no events" is a
   * veto armed by ignorance: an outage would otherwise print A/B picks straight
   * through an FOMC. Unknown != clear. [TUNED]
   */
  BLOCK_ON_CALENDAR_UNAVAILABLE: true,
  /**
   * An unavailable news feed BLOCKS too, for the same reason and because
   * `newsScore()` used to award 5/10 for an empty feed — the same score a
   * genuinely quiet asset earns. [TUNED]
   */
  BLOCK_ON_NEWS_UNAVAILABLE: true,
  /**
   * Derivatives DEGRADE rather than block. Positioning is one of twelve gates,
   * so losing it leaves the other eleven intact and caps the grade at C. The
   * setup stays visible; only the trade is withheld. [TUNED]
   */
  DEGRADE_ON_DERIVATIVES_UNAVAILABLE: true,
  /** A mocked stream is never tradable, only demonstrable. [V] */
  MOCK_IS_TRADABLE: false,
};

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

  // ── Calibration monotonicity (M1.5) ────────────────────────────────────────
  //
  // The old check was `topAvg > bottomAvg` over the populated score buckets:
  // no null hypothesis, no interval, and with two populated buckets a coin
  // flip. These are the thresholds for the test that replaced it.
  //
  /** Minimum populated score buckets before monotonicity may be judged. [TUNED] */
  MONOTONICITY_MIN_BUCKETS: 3,
  /** Bootstrap resamples for the rho and isotonic-slope intervals. [TUNED] */
  MONOTONICITY_BOOTSTRAP: 2000,
  /** Permutation resamples for the p-value. [TUNED] */
  MONOTONICITY_PERMUTATIONS: 2000,
  /** Significance level for the permutation test. [V] Conventional 5%. */
  MONOTONICITY_ALPHA: 0.05,
  /** Seed for the resampling, so a report printed twice prints the same numbers. [TUNED] */
  MONOTONICITY_SEED: 20261020,
} as const;

export const ALERTS = {
  DEFAULT_COOLDOWN_MS: 15 * 60_000,
  OI_SHOCK_PCT: 0.05,
  UNLOCK_LOOKAHEAD_H: 24,
  LIQ_CASCADE_SIGMA: DERIVATIVES.LIQ_CASCADE_SIGMA,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// MIND — the probabilistic decision layer (Part XIV, 17 Oct 2026)
// ─────────────────────────────────────────────────────────────────────────────
//
// Every number here is [TUNED]. None of them is fitted to outcomes. That is the
// point, and it is deliberate: the layer ships a model whose intercept is
// anchored to the ledger's observed base rate, so with no fitted weights it is
// calibrated at the base rate *by construction* and can only beat the base rate
// if a feature genuinely carries information. `npm run mind:report` prints the
// live Brier score against the base rate so the claim is checkable, not asserted.
//
// DO NOT add an accuracy target here. Accuracy is not the objective; calibration
// and expectancy are. See the Part XIV decision log.

export const MIND = {
  // ── Model shape ───────────────────────────────────────────────────────────
  /** Logistic temperature. Higher = softer probabilities, closer to the base rate. [TUNED] */
  LOGISTIC_TEMPERATURE: 1.0,
  /**
   * Total log-odds swing when every feature is maximally aligned with the side,
   * scaled by CONVICTION.WEIGHTS. [TUNED]
   *
   * With the observed base rate (~0.535) this puts a perfectly-aligned setup near
   * p≈0.85 and a perfectly-opposed one near p≈0.19. Deliberately not wider: a
   * large swing on unfitted weights is how a research tool starts printing
   * numbers it cannot support.
   */
  ALIGNED_LOG_ODDS: 1.6,
  /**
   * Blend between the base-rate anchor (0) and a 50/50 prior (1) when the ledger
   * has too few resolved signals to trust its win rate. [TUNED]
   *
   * Below `BASE_RATE_MIN_SAMPLES` the observed rate is treated as unknown and the
   * model leans on the prior instead. It does not invent a rate.
   */
  BASE_RATE_PRIOR_BLEND: 0.5,
  /** Resolved signals needed before the ledger's win rate is trusted as the anchor. [TUNED] */
  BASE_RATE_MIN_SAMPLES: 100,

  // ── Confidence bands ──────────────────────────────────────────────────────
  /** A probability this low is reported as "low" confidence and is not actionable. [TUNED] */
  BAND_LOW: 0.45,
  /** At or above this, "high". [TUNED] */
  BAND_HIGH: 0.6,

  // ── Actionability gate ────────────────────────────────────────────────────
  /** Below this probability a candidate never becomes an actionable signal. [TUNED] */
  ACTIONABLE_MIN_PROBABILITY: 0.45,
  /** Net expected R must clear this after costs. Zero is not "break even enough". [TUNED] */
  ACTIONABLE_MIN_NET_R: 0.05,
  /**
   * Kelly-inspired ranking coefficient. Ranking score is
   * `netR * (p * f - (1 - p)) / f` — positive edge at the chosen fraction. [TUNED]
   *
   * Deliberately not full Kelly: full Kelly on an unfitted model is how a
   * research tool talks itself into large sizing on noise.
   */
  KELLY_FRACTION: 0.25,

  // ── Regime classifier ─────────────────────────────────────────────────────
  /** Absolute OI move (fraction) over 1h that counts as a positioning thrust. [TUNED] */
  REGIME_OI_THRUST: 0.02,
  /** Absolute price move (fraction) over the scan window that counts as thrust. [TUNED] */
  REGIME_PRICE_THRUST: 0.015,
  /** Breadth ratio above/below this the market reads as one-sided. [TUNED] */
  REGIME_BREADTH_STRONG: 0.65,
  /** Liquidation USD (fraction of volume) above this is a cascade. [TUNED] */
  REGIME_LIQ_CASCADE_USD: 0.004,
  /** BTC dominance move (percentage points) over the window that reads as a rotation. [TUNED] */
  REGIME_DOMINANCE_SHIFT_PP: 0.5,
  /** ATR percentile above this is a volatility expansion, not normal noise. [TUNED] */
  REGIME_ATR_PCTL_HIGH: 80,
  /** Below this many board members the breadth read is suppressed, not guessed. [TUNED] */
  REGIME_MIN_BOARD: 5,

  // ── Hard vetoes ───────────────────────────────────────────────────────────
  /** Funding (8h-normalised) beyond this against the side, with OI rising. [TUNED] */
  VETO_FUNDING_AGAINST: DERIVATIVES.FUNDING_CROWDED_8H,
  /** Minutes either side of a tier-1 release that forces NO TRADE. [TUNED] */
  VETO_BLACKOUT_MIN: 60,
  /** NIS above which routine commentary is treated as a catalyst claim. [TUNED] */
  VETO_ROUTINE_NIS: 55,
  /** Attribution coverage above this with only routine drivers is "commentary dominated". [TUNED] */
  VETO_ROUTINE_COVERAGE_PCT: 60,
  /** Event-risk move (fraction) that vetoes. Mirrors STRUCTURE.EVENT_RISK_PCT. [TUNED] */
  VETO_EVENT_RISK: STRUCTURE.EVENT_RISK_PCT / 100,
  /** Efficiency below this is chop, and chop does not get a probability. [TUNED] */
  VETO_EFFICIENCY: STRUCTURE.EFFICIENCY_CHOP_GATE,

  // ── Expected R ────────────────────────────────────────────────────────────
  /** R credited for the nearest target when a plan publishes one. [TUNED] */
  R_NEAREST_TARGET: 1.0,
  /** Fraction of gross R assumed lost to costs when no explicit cost figure exists. [TUNED] */
  DEFAULT_COST_R: 0.12,

  // ── Calibration reporting ─────────────────────────────────────────────────
  /** Reliability diagram buckets. [TUNED] */
  CALIBRATION_BUCKETS: 10,
  /** Below this many resolved signals, calibration metrics are suppressed. [TUNED] */
  CALIBRATION_MIN_SAMPLES: 100,
  /**
   * Brier improvement over the base-rate constant that the model must beat
   * before its probabilities are described as better than chance. [TUNED]
   */
  BRIER_MEANINGFUL_DELTA: 0.01,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// LAB — the Engine Lab (Part XX, 21 Oct 2026)
// ─────────────────────────────────────────────────────────────────────────────
//
// The Lab is where the engine is tested, trained and supervised. It runs a
// closed loop: observe -> decide -> execute (paper or testnet) -> review ->
// retrain in batches -> promote only if it beats the champion out-of-sample.
//
// Everything in this group is a THRESHOLD, and every threshold carries a
// provenance tag. There is no real-money execution here and there never will
// be: the modes are SHADOW, PAPER and TESTNET, and `PROMOTION_REQUIRES_MANUAL_APPROVAL`
// is `true` because the engine cannot promote itself.

export const LAB = {
  // ── Mode ─────────────────────────────────────────────────────────────────
  /**
   * The execution modes the Lab can be in.
   *
   * `LIVE` is deliberately absent. Real-money execution is NOT BUILT — see
   * `server/src/engine/lab/executor.ts` for the disabled stub and the criteria
   * it would have to meet. [V]
   */
  MODES: ['SHADOW', 'PAPER', 'TESTNET'] as const,

  // ── Hard risk limits ─────────────────────────────────────────────────────
  /**
   * Fraction of account equity that may be risked on ONE trade. [TUNED]
   *
   * A limit, not a target. The engine sizes down when the geometry is bad; it
   * never sizes up past this.
   */
  MAX_RISK_PER_TRADE_PCT: 0.5,
  /** How many positions may be open at once. [TUNED] */
  MAX_CONCURRENT_POSITIONS: 3,
  /** Total sector exposure, as a fraction of equity. [TUNED] */
  MAX_SECTOR_EXPOSURE_PCT: 30,
  /**
   * Daily loss, as a fraction of equity, that auto-halts the engine for the
   * day. [TUNED]
   *
   * Measured on realised net R for the UTC day, so a halt is a fact about the
   * account rather than an opinion about a chart.
   */
  MAX_DAILY_LOSS_PCT: 2,
  /** The UTC hour at which the daily-loss counter resets. [V] the exchange day. */
  DAILY_RESET_UTC_HOUR: 0,
  /**
   * The kill switch. When true, nothing is opened, in any mode. [V]
   *
   * It is a switch, not a number, and it is honoured by the risk gate BEFORE
   * any adapter is consulted — so it works even if the adapter is broken.
   */
  KILL_SWITCH: false,

  // ── Paper broker mechanics ───────────────────────────────────────────────
  /** A paper fill happens at the NEXT candle's open, never at the signal price. [V] */
  FILL_ON_NEXT_CANDLE_OPEN: true,
  /** Slippage allowance in bps when no book snapshot is attached. [TUNED] */
  PAPER_SLIPPAGE_BPS: 5,
  /** Funding is charged per 8-hour UTC boundary actually crossed. [V] */
  FUNDING_INTERVAL_HOURS: 8,
  /** Stop-first when one candle covers both the stop and a target. [V] */
  AMBIGUITY: 'STOP_FIRST' as const,
  /** A paper position that hits neither level dies here. [TUNED] */
  POSITION_EXPIRY_HOURS: 24,

  // ── Binance testnet ──────────────────────────────────────────────────────
  /**
   * Binance Spot TESTNET host. [V]
   * `https://testnet.binance.vision/api` — from the official Spot Test Network
   * page, which maps every `https://api.binance.com/api` URL to it. Only
   * `/api/*` is available there; `/sapi/*` is not.
   */
  TESTNET_SPOT_HOST: 'https://testnet.binance.vision',
  /**
   * Binance USD-M Futures TESTNET host. [V]
   * `https://testnet.binancefuture.com` — the futures counterpart of the same
   * testnet. Futures endpoints live under `/fapi`.
   */
  TESTNET_FUT_HOST: 'https://testnet.binancefuture.com',
  /** The testnet adapter is OFF unless this is switched on. [V] */
  TESTNET_ENABLED: false,
  /**
   * The env vars the testnet adapter reads its key from. [V]
   *
   * The values are never logged, never returned over HTTP, and never sent to
   * the browser. The adapter only ever sees the env var NAME.
   */
  TESTNET_API_KEY_ENV: 'BINANCE_TESTNET_API_KEY',
  TESTNET_API_SECRET_ENV: 'BINANCE_TESTNET_API_SECRET',

  // ── The learning loop ────────────────────────────────────────────────────
  /**
   * New RESOLVED trades required before a retrain batch runs. [TUNED]
   *
   * A batch, never a single trade: learning from one loss fits noise. The
   * value is a `[TUNED]` hand-set number until the ledger has enough resolved
   * outcomes to fit it.
   */
  RETRAIN_BATCH_SIZE: 25,
  /** Resolved training rows required before any retrain is attempted at all. [TUNED] */
  RETRAIN_MIN_ROWS: 60,
  /** Decided out-of-sample trades a challenger needs before it may be judged. [TUNED] */
  PROMOTION_MIN_OOS_TRADES: 30,
  /**
   * Maximum tolerated gap between predicted and observed probability in a
   * reliability bucket. [TUNED]
   */
  CALIBRATION_TOLERANCE: 0.1,
  /**
   * Minimum paper days before anything may be promoted beyond paper/testnet. [TUNED]
   */
  PROMOTION_MIN_DAYS: 90,
  /**
   * Minimum paper trades before anything may be promoted beyond paper/testnet. [TUNED]
   */
  PROMOTION_MIN_PAPER_TRADES: 300,
  /** Manual approval is always required. The engine cannot promote itself. [V] */
  PROMOTION_REQUIRES_MANUAL_APPROVAL: true,

  // ── Confidence tiers ─────────────────────────────────────────────────────
  /**
   * The probability thresholds the tier table reports. [TUNED]
   *
   * The brief names 0.6 / 0.7 / 0.8 / 0.9. They are thresholds, so they live
   * here and not in the UI.
   */
  TIER_THRESHOLDS: [0.6, 0.7, 0.8, 0.9] as const,
  /** Below this many trades a tier's hit rate is not quoted at all. [TUNED] */
  TIER_MIN_TRADES: 30,
  /** The z for a 95% Wilson interval. [V] */
  WILSON_Z: 1.959964,

  // ── Drift monitor ────────────────────────────────────────────────────────
  /** Live trades the rolling drift monitor reads. [TUNED] */
  DRIFT_WINDOW: 50,
  /** Relative Brier degradation over the window that trips the monitor. [TUNED] */
  DRIFT_BRIER_RELATIVE: 0.15,
  /** Absolute net-expectancy degradation, in R, that trips the monitor. [TUNED] */
  DRIFT_EXPECTANCY_R: 0.25,

  // ── The Lab's own polling ────────────────────────────────────────────────
  /** How often the Lab status is recomputed, in ms. [TUNED] */
  STATUS_REFRESH_MS: 15_000,
} as const;

/**
 * Mind regimes are a SEPARATE taxonomy from the engine's existing `Regime`
 * ('trend-up' | 'trend-down' | 'range' | 'high-vol-expansion' | 'risk-off'),
 * which is kept untouched. Two vocabularies for one idea invites a bug where one
 * is read where the other is meant.
 */
export type MindRegime =
  | 'trending-bull'
  | 'trending-bear'
  | 'range'
  | 'high-vol-cascade'
  | 'macro-blackout'
  | 'quiet';

export type Grade = 'A' | 'B' | 'C' | 'Pass' | 'NO TRADE';
export type OiQuadrant = 'new-longs' | 'short-cover' | 'new-shorts' | 'long-liquidation' | 'flat';
export type RetestState = 'fresh' | 'approaching' | 'in-zone' | 'retested-held' | 'violated' | 'none';
export type Regime = 'trend-up' | 'trend-down' | 'range' | 'high-vol-expansion' | 'risk-off';
export type SizeAdvice = 'full' | 'reduced' | 'stand-aside';

export const config = {
  TZ, NETWORK, RATE, LIVE, REFRESH, FAN, DERIVATIVES, STRUCTURE, CONVICTION,
  VETO, CHECKLIST, HEALTH, RISK, INDIA_TAX, MACRO, MIND, FUNDING_TIMES_UTC, SESSIONS_UTC,
  NEWS, LEDGER, ALERTS, LAB,
  MIN_UNIVERSE_VOLUME_USD, UNIVERSE_MAX_PAIRS, MOVERS_MIN_VOLUME_USD,
  UNIVERSE_REFRESH_MS,
} as const;

export type Config = typeof config;
