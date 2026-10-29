import type { NewsCategory } from '../../../shared/types.js';
import type { ExchangeSymbol, Ticker24h } from './binance.js';
import { fetchExchangeSymbols, fetchTickers } from './binance.js';
import {
  STABLECOIN_BASES, WRAPPED_BASES, UNIVERSE_BY_BASE, type UniverseEntry,
} from './universe.js';
import { MIN_UNIVERSE_VOLUME_USD, UNIVERSE_MAX_PAIRS, UNIVERSE_REFRESH_MS } from '../config.js';

/**
 * The live, volume-filtered universe.
 *
 * WHY THIS REPLACES A HAND-WRITTEN LIST
 *
 * The diagnostic proved the old scanner dropped 14 liquid coins because it
 * keyed 24h tickers by BASE after stripping `(USDT|FDUSD|BUSD)$` and kept the
 * FIRST pair it saw. Binance returns BUSD/FDUSD pairs before USDT for several
 * bases, so the volume test was applied to the deprecated, thin book and the
 * pair was discarded.
 *
 * This module resolves each base to its USDT spot pair EXPLICITLY, takes the
 * volume/price/change from that same pair, and never falls back to BUSD or
 * FDUSD. USDC is the only fallback, and only when a base has no USDT market,
 * and it is labelled.
 *
 * The hand-written `universe.ts` is kept solely as METADATA: names, sectors,
 * beta groups and news tags. A pair without metadata is still included, with
 * sector "Other" and its base as a provisional name; `resolveIdentity` then
 * fills a real name from the cached CoinGecko list when one exists.
 */

export type BetaGroup = UniverseEntry['betaGroup'];

export interface LiveUniverseEntry {
  base: string;
  /** The pair actually used. `${base}USDT` unless the base only trades vs USDC. */
  pair: string;
  quote: 'USDT' | 'USDC';
  name: string;
  sector: string;
  betaGroup: BetaGroup;
  tags: NewsCategory[];
  /** True when name/sector came from the hand-maintained file, not the ticker. */
  hasMetadata: boolean;
  /** Newest 24h ticker for `pair`, taken from the SAME pair the volume came from. */
  ticker: Ticker24h;
}

export interface ExcludedSymbol {
  base: string;
  pair: string;
  reason: string;
}

export interface UniverseResolution {
  entries: LiveUniverseEntry[];
  /** How many candidate pairs clear each volume threshold. For the boot log. */
  volumeCounts: Record<string, number>;
  excluded: ExcludedSymbol[];
}

export const VOLUME_THRESHOLDS = [2_000_000, 5_000_000, 10_000_000, 20_000_000] as const;

/**
 * Is this base a leveraged token (`BTCUP`, `BTCDOWN`, `XYZBULL`, `XYZBEAR`)?
 *
 * A naive suffix test would drop real coins: `JUP` (Jupiter) ends in "UP" and
 * `PUMP` ends in "UP" too. Binance's leveraged tokens use the underlying as a
 * prefix, so the rule is: the base ends with a leveraged suffix AND the
 * remaining root is itself a traded base. `BTCUP` -> `BTC` (traded) => drop.
 * `JUP` -> `J` (not traded) => keep.
 */
function isLeveraged(base: string, tradedBases: Set<string>): boolean {
  if (/(BULL|BEAR)$/.test(base)) return true;
  const m = /^(.*?)(UP|DOWN)$/.exec(base);
  if (!m) return false;
  const root = m[1];
  return root.length >= 2 && tradedBases.has(root);
}

/**
 * Pure selection. No network, no clock, no module state — this is what the unit
 * tests drive directly with a hand-built symbol + ticker list.
 *
 * Order of exclusions is deliberate and each one is logged with a reason so the
 * Stage 1 completeness test can assert that a liquid pair was dropped on
 * purpose rather than by accident.
 */
export function selectUniverse(args: {
  symbols: ExchangeSymbol[];
  tickers: Ticker24h[];
  minVolumeUsd: number;
  maxPairs: number;
  metadata?: Map<string, UniverseEntry>;
  thresholds?: readonly number[];
}): UniverseResolution {
  const {
    symbols, tickers, minVolumeUsd, maxPairs,
    metadata = UNIVERSE_BY_BASE,
    thresholds = VOLUME_THRESHOLDS,
  } = args;

  const tickerBySymbol = new Map<string, Ticker24h>();
  for (const t of tickers) tickerBySymbol.set(t.symbol, t);

  // USDT spot bases that are actually trading. Used both for pair choice and
  // for the leveraged-token rule (is the suffix root a real base?).
  const tradedBases = new Set(
    symbols.filter((s) => s.quote === 'USDT' && s.status === 'TRADING').map((s) => s.base),
  );

  const usdtByBase = new Map<string, ExchangeSymbol>();
  const usdcByBase = new Map<string, ExchangeSymbol>();
  for (const s of symbols) {
    if (s.status !== 'TRADING') continue;
    if (s.quote === 'USDT' && !usdtByBase.has(s.base)) usdtByBase.set(s.base, s);
    if (s.quote === 'USDC' && !usdcByBase.has(s.base)) usdcByBase.set(s.base, s);
  }

  const entries: LiveUniverseEntry[] = [];
  const excluded: ExcludedSymbol[] = [];

  for (const base of new Set([...usdtByBase.keys(), ...usdcByBase.keys()])) {
    const usdt = usdtByBase.get(base);
    const usdc = usdcByBase.get(base);
    // USDT first, always. USDC only when there is no USDT market.
    const chosen = usdt ?? usdc!;
    const quote: 'USDT' | 'USDC' = usdt ? 'USDT' : 'USDC';

    const exclude = (reason: string) =>
      excluded.push({ base, pair: chosen.symbol, reason });

    if (STABLECOIN_BASES.has(base)) { exclude('stablecoin'); continue; }
    if (WRAPPED_BASES.has(base)) { exclude('wrapped/bridged duplicate'); continue; }
    if (isLeveraged(base, tradedBases)) { exclude('leveraged token'); continue; }

    const ticker = tickerBySymbol.get(chosen.symbol);
    if (!ticker || !Number.isFinite(ticker.quoteVolume)) { exclude('no 24h ticker'); continue; }
    if (ticker.quoteVolume < minVolumeUsd) {
      exclude(`24h quote volume $${Math.round(ticker.quoteVolume).toLocaleString('en-US')} < $${minVolumeUsd.toLocaleString('en-US')}`);
      continue;
    }

    const meta = metadata.get(base);
    entries.push({
      base,
      pair: chosen.symbol,
      quote,
      name: meta?.name ?? base,
      sector: meta?.sector ?? 'Other',
      betaGroup: meta?.betaGroup ?? 'infra',
      tags: meta?.tags ?? [],
      hasMetadata: Boolean(meta),
      ticker,
    });
  }

  // Highest volume first, then cap. A cap keeps the WS kline subscription and
  // the multi-timeframe scan bounded as the exchange lists more markets.
  entries.sort((a, b) => b.ticker.quoteVolume - a.ticker.quoteVolume);
  const capped = entries.slice(0, maxPairs);

  const volumeCounts: Record<string, number> = {};
  const allWithTicker = [...new Set([...usdtByBase.keys(), ...usdcByBase.keys()])];
  for (const threshold of thresholds) {
    let count = 0;
    for (const base of allWithTicker) {
      const pair = (usdtByBase.get(base) ?? usdcByBase.get(base)!).symbol;
      const t = tickerBySymbol.get(pair);
      if (t && t.quoteVolume >= threshold) count++;
    }
    volumeCounts[`$${(threshold / 1_000_000).toFixed(0)}M`] = count;
  }

  return { entries: capped, volumeCounts, excluded };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cached async wrapper — startup + hourly refresh
// ─────────────────────────────────────────────────────────────────────────────

let cache: { at: number; resolution: UniverseResolution } | null = null;

/**
 * Resolve the universe from the exchange, at most once per UNIVERSE_REFRESH_MS.
 * Falls back to the last good resolution when a refresh fails.
 */
export async function resolveUniverse(force = false): Promise<UniverseResolution> {
  const now = Date.now();
  if (!force && cache && now - cache.at < UNIVERSE_REFRESH_MS) return cache.resolution;

  const [symbols, tickers] = await Promise.all([fetchExchangeSymbols(), fetchTickers()]);
  const resolution = selectUniverse({
    symbols, tickers,
    minVolumeUsd: MIN_UNIVERSE_VOLUME_USD,
    maxPairs: UNIVERSE_MAX_PAIRS,
    metadata: UNIVERSE_BY_BASE,
  });

  if (!resolution.entries.length && cache) {
    console.warn('[universe] refresh produced an empty set; keeping the last good universe');
    return cache.resolution;
  }

  cache = { at: now, resolution };
  console.log(
    `[universe] ${resolution.entries.length} pairs >= $${(MIN_UNIVERSE_VOLUME_USD / 1_000_000).toFixed(0)}M ` +
    `(candidate pairs by volume: ${Object.entries(resolution.volumeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}), ` +
    `${resolution.excluded.length} excluded`,
  );
  console.log(`[universe] final list: ${resolution.entries.map((e) => e.base).join(', ')}`);
  logUniverseCost(resolution);
  return resolution;
}

/**
 * Stage 1 cost plan.
 *
 * What the live universe costs, measured against the venue's own limits rather
 * than guessed:
 *
 *  - SPOT WS: one `@kline_5m` stream per pair, plus one `!miniTicker@arr` that
 *    carries every symbol regardless of the set below. Binance allows 1024
 *    streams per connection, so the pool is capped at 1024.
 *  - REST backfill: `/api/v3/klines` costs weight 2 per request. The scan pulls
 *    four timeframes, staggered 4-at-a-time with a 400ms gap, and SQLite serves
 *    the already-stored candles so a warm restart costs almost no weight.
 *  - Weight ceiling: `data-api.binance.vision` allows 6000 weight/minute. The
 *    scanner budgets at most 50% of that (3000) for klines. At 2 weight per
 *    request that is 1500 requests/minute — far above the ~380 a cold scan
 *    issues, so the ceiling is never the binding constraint.
 */
export function logUniverseCost(resolution: UniverseResolution): void {
  const pairs = resolution.entries.length;
  const streams = Math.min(MAX_STREAMS, pairs) + 1; // + !miniTicker@arr
  const coldRequests = pairs * TF_COUNT;
  const coldWeight = coldRequests * KLINE_WEIGHT;
  const ceilingPct = Math.round((SCANNER_WEIGHT_BUDGET / WEIGHT_CEILING_PER_MIN) * 100);
  const coldPct = Math.round((coldWeight / WEIGHT_CEILING_PER_MIN) * 100);

  console.log(
    `[universe] cost plan: ${streams} spot WS streams ` +
    `(${pairs} × @kline_5m + 1 × !miniTicker@arr); ` +
    `cold REST backfill ${coldRequests} requests = ${coldWeight} weight ` +
    `(${coldPct}% of the ${WEIGHT_CEILING_PER_MIN}/min ceiling, one-off, staggered 4-at-a-time); ` +
    `warm restart reads SQLite and fetches only the missing tail; ` +
    `scanner budget ${ceilingPct}% (${SCANNER_WEIGHT_BUDGET}/min) so the zoned setup path keeps headroom`,
  );
}

/** Spot streams per connection the venue permits. */
const MAX_STREAMS = 1024;
/** Timeframes the scan pulls per symbol (5m/15m/1h/4h). */
const TF_COUNT = 4;
/** Weight/minute ceiling on the spot market-data host. */
const WEIGHT_CEILING_PER_MIN = 6000;
/** The scanner keeps itself under half of the ceiling. */
const SCANNER_WEIGHT_BUDGET = WEIGHT_CEILING_PER_MIN / 2;
/** Weight of one `/api/v3/klines` request. */
const KLINE_WEIGHT = 2;

/** Last resolved universe, or null before the first resolution. */
export function currentUniverse(): UniverseResolution | null {
  return cache?.resolution ?? null;
}

/** Look up one base in the resolved universe. */
export function universeEntry(base: string): LiveUniverseEntry | null {
  return cache?.resolution.entries.find((e) => e.base === base) ?? null;
}

/** Boot-log helper: every excluded pair with its reason. */
export function logUniverseExclusions(resolution: UniverseResolution, limit = 40): void {
  for (const e of resolution.excluded.slice(0, limit)) {
    console.log(`[universe] excluded ${e.pair} (${e.base}): ${e.reason}`);
  }
  if (resolution.excluded.length > limit) {
    console.log(`[universe] … ${resolution.excluded.length - limit} more excluded pairs`);
  }
}
