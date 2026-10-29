import { fetchJson, bans, hostOf } from '../lib/http.js';
import { cached, setManual } from '../lib/cache.js';
import type { Candle } from '../../../shared/types.js';
import {
  latestCandleTime, readStoredCandles, storeCandles,
} from '../ledger/store.js';

/**
 * `data-api.binance.vision` is Binance's officially designated public market-data
 * host: it mirrors /api/v3 without any account endpoints, and it is reachable
 * from Indian IPs. Binance completed FIU-IND registration in Aug 2024.
 */
const BINANCE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
let activeHost = 0;

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  openPrice: number;
  priceChangePercent: number;
  quoteVolume: number;
  highPrice: number;
  lowPrice: number;
}

export interface ExchangeSymbol {
  symbol: string;
  base: string;
  quote: string;
  status: string;
}

export interface SpotDepth {
  lastUpdateId: number;
  /** [price, quantity] pairs, descending price. */
  bids: [string, string][];
  /** [price, quantity] pairs, ascending price. */
  asks: [string, string][];
}

export interface AggTrade {
  /** Aggregate-trade id. */
  a: number;
  /** Price. */
  p: string;
  /** Quantity (base asset). */
  q: string;
  /** Trade time, epoch ms. */
  T: number;
  /** True when the buyer was the maker, i.e. the taker sold. */
  m: boolean;
}

async function binanceGet<T>(path: string, label: string, purpose: 'essential' | 'normal' | 'nonessential' = 'normal'): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < BINANCE_HOSTS.length; i++) {
    const host = BINANCE_HOSTS[(activeHost + i) % BINANCE_HOSTS.length];
    // A banned host is skipped outright. Note that Binance tracks limits per IP,
    // so the registry also gates the sibling hosts via its group ban — this
    // loop is the belt to that braces, and it keeps the failover honest when a
    // single host is genuinely down rather than banned.
    if (bans.isBanned(hostOf(host))) continue;
    try {
      const out = await fetchJson<T>(`${host}${path}`, { label, retries: 1, purpose });
      activeHost = (activeHost + i) % BINANCE_HOSTS.length;
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const KLINE_INTERVALS = new Map<string, number>([
  ['1m', 60_000], ['3m', 180_000], ['5m', 300_000], ['15m', 900_000],
  ['30m', 1_800_000], ['1h', 3_600_000], ['2h', 7_200_000], ['4h', 14_400_000],
  ['6h', 21_600_000], ['8h', 28_800_000], ['12h', 43_200_000],
  ['1d', 86_400_000], ['3d', 259_200_000], ['1w', 604_800_000],
]);

function intervalMs(interval: string): number {
  const ms = KLINE_INTERVALS.get(interval);
  if (!ms) throw new Error(`Unsupported interval: ${interval}`);
  return ms;
}

/**
 * Binance klines come back oldest-first as 12 string arrays:
 * [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades,
 *  takerBuyBase, takerBuyQuote, ignore]
 * The final row is the still-forming candle.
 *
 * Index 9 (takerBuyBase) is what CVD is computed from, so it is mapped here
 * rather than costing an extra request.
 */
type RawKline = [number, string, string, string, string, string, string, string, number, string, string, string];

function mapKline(k: RawKline, now: number): Candle {
  return {
    t: k[0],
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[5]),
    qv: Number(k[7]),
    trades: Number(k[8]),
    takerBuyBase: Number(k[9]),
    takerBuyQuote: Number(k[10]),
    closed: Number(k[6]) < now,
  };
}

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number,
  ttlMs = 20_000,
  purpose: 'essential' | 'normal' | 'nonessential' = 'normal',
): Promise<Candle[]> {
  if (!KLINE_INTERVALS.has(interval)) throw new Error(`Unsupported interval: ${interval}`);
  const safeLimit = Math.min(1000, Math.max(1, limit));
  const path = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${safeLimit}`;
  const label = `binance klines ${symbol} ${interval}`;

  return cached(`binance:kl:${symbol}:${interval}:${safeLimit}`, ttlMs, async () => {
    const raw = await binanceGet<RawKline[]>(path, label, purpose);
    const now = Date.now();
    return raw.map((k) => mapKline(k, now));
  });
}

/**
 * Full spot order book. The 20-level summary used by the derivatives panel
 * cannot drive a heatmap: it hides every level between the walls, which is
 * precisely the liquidity a heatmap exists to show.
 */
export async function fetchSpotDepth(
  symbol: string,
  limit = 1_000,
  ttlMs = 1_200,
  purpose: 'essential' | 'normal' | 'nonessential' = 'normal',
): Promise<SpotDepth> {
  const safeLimit = limit >= 1_000 ? 1_000 : limit >= 500 ? 500 : limit >= 100 ? 100 : 20;
  return cached(`binance:depth:${symbol}:${safeLimit}`, ttlMs, () =>
    binanceGet<SpotDepth>(
      `/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${safeLimit}`,
      `binance depth ${symbol}`,
      purpose,
    ),
  );
}

/**
 * Recent aggregate trades, oldest first as Binance returns them. The terminal
 * merges polls by `a` so a bubble is never drawn twice.
 */
export async function fetchAggTrades(
  symbol: string,
  limit = 500,
  ttlMs = 1_500,
  purpose: 'essential' | 'normal' | 'nonessential' = 'normal',
): Promise<AggTrade[]> {
  const safeLimit = Math.min(1_000, Math.max(1, limit));
  return cached(`binance:agg:${symbol}:${safeLimit}`, ttlMs, async () => {
    const raw = await binanceGet<AggTrade[]>(
      `/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=${safeLimit}`,
      `binance aggTrades ${symbol}`,
      purpose,
    );
    return raw
      .map((t) => ({
        a: Number(t.a),
        p: String(t.p),
        q: String(t.q),
        T: Number(t.T),
        m: Boolean(t.m),
      }))
      .filter((t) => Number.isFinite(t.a) && Number.isFinite(t.T));
  });
}

/**
 * Klines for a TIME WINDOW, not the most recent N.
 *
 * `fetchKlines()` returns the most recent `limit` candles, which is the wrong
 * question for a historical replay: a signal from eight days ago needs the
 * candles from eight days ago, and the most recent 1000 (83 hours at 5 m) do
 * not reach back that far. The ledger's own backfill hit exactly this and
 * silently under-covered every gap longer than 83 hours.
 *
 * Binance's klines endpoint takes `startTime` and `endTime`, so the window is
 * asked for directly. The page size is capped at 1000 by the venue, so a
 * longer window is walked in pages.
 *
 * NO CACHE. This is a historical read of a closed window; caching it would
 * mean a replay could silently read a different series than the one it
 * recorded, which is the exact failure the ledger is supposed to prevent.
 */
export async function fetchKlinesRange(
  symbol: string,
  interval: string,
  fromTs: number,
  toTs: number,
  purpose: 'essential' | 'normal' | 'nonessential' = 'normal',
): Promise<Candle[]> {
  if (!KLINE_INTERVALS.has(interval)) throw new Error(`Unsupported interval: ${interval}`);
  const step = intervalMs(interval);
  const out: Candle[] = [];
  const seen = new Set<number>();
  let cursor = fromTs;

  // Four pages covers 4000 candles — 14 days at 5 m, 69 days at 1 h.
  for (let page = 0; page < 4 && cursor <= toTs; page++) {
    const end = Math.min(toTs, cursor + 1000 * step - 1);
    const path =
      `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${end}&limit=1000`;
    const raw = await binanceGet<RawKline[]>(
      path, `binance klines ${symbol} ${interval} ${cursor}-${end}`, purpose,
    );
    if (!raw.length) break;
    const now = Date.now();
    for (const k of raw) {
      const c = mapKline(k, now);
      if (seen.has(c.t)) continue;
      seen.add(c.t);
      out.push(c);
    }
    const last = raw[raw.length - 1];
    const next = Number(last[0]) + step;
    if (next <= cursor) break; // no progress; stop rather than loop
    cursor = next;
    if (raw.length < 1000) break; // the window is exhausted
  }

  return out.sort((a, b) => a.t - b.t);
}

export interface PrimeReport {
  symbol: string;
  interval: string;
  fromCache: number;
  fromDisk: number;
  fetched: number;
}

/**
 * Restart-safe kline priming.
 *
 * The original startup re-downloaded `limit` candles for every tracked symbol.
 * Across ~56 symbols that is the single largest burst the app ever produces,
 * and it is a large share of the request weight implicated in the original
 * 418. This walks the opposite way: read what is already on disk, work out the
 * genuinely missing tail, and fetch only that.
 *
 * A cold database (first ever run) still fetches the full window — there is
 * nothing to read — but every restart after that costs a handful of candles
 * per symbol.
 */
export async function primeKlines(
  symbol: string,
  interval: string,
  limit: number,
  now = Date.now(),
): Promise<PrimeReport> {
  const step = intervalMs(interval);
  const safeLimit = Math.min(1000, Math.max(1, limit));
  const key = `binance:kl:${symbol}:${interval}:${safeLimit}`;

  const disk = readStoredCandles(symbol, interval, safeLimit);
  const newestOnDisk = latestCandleTime(symbol, interval);
  const oldestWanted = now - safeLimit * step;

  // How far behind is the stored series? Usually nothing.
  const needsTail = newestOnDisk === null || now - newestOnDisk > step * 1.5;
  const needsHead = disk.length < safeLimit;

  let fetched = 0;
  if (needsTail || needsHead) {
    // Fetch exactly the uncovered window. `startTime` bounds it server-side so
    // a two-candle delta costs weight for two candles, not for `limit`.
    const from = needsHead ? oldestWanted : (newestOnDisk ?? oldestWanted) + step;
    const wanted = Math.ceil((now - from) / step) + 1;
    const fetchLimit = Math.min(1000, Math.max(1, wanted));

    const path =
      `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}` +
      `&limit=${fetchLimit}&startTime=${Math.floor(from)}`;
    try {
      const raw = await binanceGet<RawKline[]>(path, `binance prime ${symbol} ${interval}`, 'essential');
      const now2 = Date.now();
      const mapped = raw.map((k) => mapKline(k, now2));
      fetched = storeCandles(symbol, interval, mapped.map((c) => ({
        t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, qv: c.qv ?? 0,
        trades: c.trades ?? 0, takerBuyBase: c.takerBuyBase ?? 0,
        takerBuyQuote: c.takerBuyQuote ?? 0,
      })));
      // Seed the live cache from the merged store so the first scan after a
      // restart reads locally instead of re-fetching.
      const merged = readStoredCandles(symbol, interval, safeLimit).map((r) => ({
        t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, qv: r.qv,
        trades: r.trades, takerBuyBase: r.takerBuyBase, takerBuyQuote: r.takerBuyQuote,
        closed: r.t + step <= now,
      }));
      if (merged.length) setManual(key, merged, 30_000);
    } catch (err) {
      // A banned or unreachable host must not abort startup; the scan degrades.
      console.warn(`[binance] prime failed for ${symbol} ${interval}: ${(err as Error).message}`);
    }
  }

  return {
    symbol,
    interval,
    fromCache: disk.length,
    fromDisk: disk.length,
    fetched,
  };
}

export async function fetchTickers(): Promise<Ticker24h[]> {
  const raw = await binanceGet<
    { symbol: string; lastPrice: string; openPrice: string; priceChangePercent: string; quoteVolume: string; highPrice: string; lowPrice: string }[]
  >('/api/v3/ticker/24hr', 'binance 24h tickers', 'essential');

  return raw
    .map((t) => ({
      symbol: t.symbol,
      lastPrice: Number(t.lastPrice),
      openPrice: Number(t.openPrice),
      priceChangePercent: Number(t.priceChangePercent),
      quoteVolume: Number(t.quoteVolume),
      highPrice: Number(t.highPrice),
      lowPrice: Number(t.lowPrice),
    }))
    .filter((t) => Number.isFinite(t.lastPrice) && t.lastPrice > 0);
}

/** One call per symbol â€” used to pick the tradable universe from exchangeInfo. */
export async function fetchExchangeSymbols(): Promise<ExchangeSymbol[]> {
  return cached('binance:exchangeSymbols', 60 * 60_000, async () => {
    const res = await binanceGet<{
      symbols: { symbol: string; baseAsset: string; quoteAsset: string; status: string; isSpotTradingAllowed: boolean }[];
    }>('/api/v3/exchangeInfo?permissions=SPOT', 'binance exchangeInfo');
    return res.symbols
      .filter((s) => s.isSpotTradingAllowed && s.status === 'TRADING')
      .map((s) => ({ symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset, status: s.status }));
  });
}

export async function fetchServerTime(): Promise<number> {
  const res = await binanceGet<{ serverTime: number }>('/api/v3/time', 'binance time');
  return res.serverTime;
}