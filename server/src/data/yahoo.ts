import { fetchJson, fetchText } from '../lib/http.js';
import { cached } from '../lib/cache.js';
import type { Candle } from '../../../shared/types.js';

/**
 * Yahoo now requires a cookie + crumb handshake. A bare chart call returns a
 * misleading "symbol may be delisted" error that is really an auth failure.
 * Sequence: seed cookies from fc.yahoo.com, fetch the crumb, then call /v8.
 */
let crumbCache: { crumb: string; cookie: string; at: number } | null = null;

async function getCrumb(): Promise<{ crumb: string; cookie: string }> {
  if (crumbCache && Date.now() - crumbCache.at < 30 * 60_000) {
    return { crumb: crumbCache.crumb, cookie: crumbCache.cookie };
  }

  const seedRes = await fetch('https://fc.yahoo.com/', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  const rawCookie = seedRes.headers.getSetCookie?.() ?? [];
  const cookie = rawCookie.map((c) => c.split(';')[0]).join('; ');
  // Drain the body so the connection is reusable.
  await seedRes.arrayBuffer().catch(() => undefined);

  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Cookie: cookie,
    },
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes('<')) throw new Error('Yahoo crumb fetch failed');

  crumbCache = { crumb, cookie, at: Date.now() };
  return { crumb, cookie };
}

interface YahooChart {
  chart: {
    result?: YahooResult[];
    error: { code?: string; description?: string } | null;
  };
}

interface YahooResult {
  meta: {
    currency: string;
    symbol: string;
    regularMarketPrice: number;
    regularMarketChangePercent?: number;
    shortName?: string;
    longName?: string;
    currentTradingPeriod?: { regular?: { start: number; end: number; timezone?: string } };
  };
  timestamp?: number[];
  indicators?: {
    quote?: {
      open?: (number | null)[];
      high?: (number | null)[];
      low?: (number | null)[];
      close?: (number | null)[];
      volume?: (number | null)[];
    }[];
  };
}

export interface YahooCandle extends Candle {
  timeSec: number;
}

export interface YahooMeta {
  currency: string;
  symbol: string;
  regularMarketPrice: number;
  regularMarketChangePercent?: number;
  shortName?: string;
  longName?: string;
  currentTradingPeriod?: { regular?: { start: number; end: number; timezone?: string } };
}

export interface YahooChartResult {
  meta: YahooMeta;
  candles: YahooCandle[];
}

export async function yahooChart(
  symbol: string,
  interval: '5m' | '15m' | '1h' | '1d' = '5m',
  range = '5d',
): Promise<YahooChartResult | null> {
  const { crumb, cookie } = await getCrumb();
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}&includePrePost=false&crumb=${encodeURIComponent(crumb)}`;

  const text = await fetchText(url, {
    label: `yahoo chart ${symbol}`,
    headers: { Cookie: cookie },
    retries: 1,
  });
  const json = JSON.parse(text) as YahooChart;
  const r = json.chart.result?.[0];
  if (!r) return null;

  // Yahoo returns parallel, index-aligned arrays with null holes for
  // non-trading intervals, not per-candle objects.
  const ts = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0] ?? {};
  const candles: YahooCandle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({
      timeSec: ts[i],
      t: ts[i] * 1000,
      o,
      h,
      l,
      c,
      v: q.volume?.[i] ?? 0,
      closed: i < ts.length - 1,
    });
  }
  return { meta: r.meta, candles };
}

/** F&O liquid stocks with their NSE sector, for the Indian board. */
export const FNO_UNIVERSE = [
  { yahoo: 'RELIANCE.NS', nse: 'RELIANCE', name: 'Reliance Industries', sector: 'Energy' },
  { yahoo: 'TCS.NS', nse: 'TCS', name: 'Tata Consultancy Services', sector: 'IT' },
  { yahoo: 'HDFCBANK.NS', nse: 'HDFCBANK', name: 'HDFC Bank', sector: 'Financials' },
  { yahoo: 'ICICIBANK.NS', nse: 'ICICIBANK', name: 'ICICI Bank', sector: 'Financials' },
  { yahoo: 'INFY.NS', nse: 'INFY', name: 'Infosys', sector: 'IT' },
  { yahoo: 'SBIN.NS', nse: 'SBIN', name: 'State Bank of India', sector: 'Financials' },
  { yahoo: 'BHARTIARTL.NS', nse: 'BHARTIARTL', name: 'Bharti Airtel', sector: 'Telecom' },
  { yahoo: 'ITC.NS', nse: 'ITC', name: 'ITC', sector: 'FMCG' },
  { yahoo: 'LT.NS', nse: 'LT', name: 'Larsen & Toubro', sector: 'Industrials' },
  { yahoo: 'AXISBANK.NS', nse: 'AXISBANK', name: 'Axis Bank', sector: 'Financials' },
  { yahoo: 'KOTAKBANK.NS', nse: 'KOTAKBANK', name: 'Kotak Mahindra Bank', sector: 'Financials' },
  { yahoo: 'HINDUNILVR.NS', nse: 'HINDUNILVR', name: 'Hindustan Unilever', sector: 'FMCG' },
  { yahoo: 'BAJFINANCE.NS', nse: 'BAJFINANCE', name: 'Bajaj Finance', sector: 'Financials' },
  { yahoo: 'MARUTI.NS', nse: 'MARUTI', name: 'Maruti Suzuki', sector: 'Auto' },
  { yahoo: 'TATAMOTORS.NS', nse: 'TATAMOTORS', name: 'Tata Motors', sector: 'Auto' },
  { yahoo: 'TITAN.NS', nse: 'TITAN', name: 'Titan Company', sector: 'Consumer' },
  { yahoo: 'WIPRO.NS', nse: 'WIPRO', name: 'Wipro', sector: 'IT' },
  { yahoo: 'HCLTECH.NS', nse: 'HCLTECH', name: 'HCL Technologies', sector: 'IT' },
  { yahoo: 'ASIANPAINT.NS', nse: 'ASIANPAINT', name: 'Asian Paints', sector: 'Consumer' },
  { yahoo: 'SUNPHARMA.NS', nse: 'SUNPHARMA', name: 'Sun Pharmaceutical', sector: 'Pharma' },
];

export async function yahooChartCached(
  symbol: string,
  interval: '5m' | '15m' | '1h' | '1d' = '5m',
  range = '5d',
  ttl = 60_000,
) {
  return cached(`yahoo:${symbol}:${interval}:${range}`, ttl, () => yahooChart(symbol, interval, range));
}

export { fetchJson };
