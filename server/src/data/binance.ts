import { fetchJson } from '../lib/http.js';
import { cached } from '../lib/cache.js';
import type { Candle } from '../../../shared/types.js';

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

async function binanceGet<T>(path: string, label: string): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < BINANCE_HOSTS.length; i++) {
    const host = BINANCE_HOSTS[(activeHost + i) % BINANCE_HOSTS.length];
    try {
      const out = await fetchJson<T>(`${host}${path}`, { label, retries: 1 });
      activeHost = (activeHost + i) % BINANCE_HOSTS.length;
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const KLINE_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w',
]);

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

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number,
  ttlMs = 20_000,
): Promise<Candle[]> {
  if (!KLINE_INTERVALS.has(interval)) throw new Error(`Unsupported interval: ${interval}`);
  const safeLimit = Math.min(1000, Math.max(1, limit));
  const path = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${safeLimit}`;
  const label = `binance klines ${symbol} ${interval}`;

  return cached(`binance:kl:${symbol}:${interval}:${safeLimit}`, ttlMs, async () => {
    const raw = await binanceGet<RawKline[]>(path, label);
    const now = Date.now();
    return raw.map((k) => ({
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
    }));
  });
}

export async function fetchTickers(): Promise<Ticker24h[]> {
  const raw = await binanceGet<
    { symbol: string; lastPrice: string; openPrice: string; priceChangePercent: string; quoteVolume: string; highPrice: string; lowPrice: string }[]
  >('/api/v3/ticker/24hr', 'binance 24h tickers');

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
