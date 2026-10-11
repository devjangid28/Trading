/**
 * Phase 0 — source probe.
 *
 * Every data source OrderFlow might use gets hit once, and the result is
 * recorded. Nothing is built against a source until it has proved OK from
 * THIS machine, because several hosts are blocked from Indian IPs.
 *
 *   npm run probe
 *
 * Writes a table to stdout and a machine-readable JSON snapshot to
 * server/data/probe-results.json for DATA_SOURCES.md.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

type Verdict = 'OK' | 'FAIL' | 'BLOCKED';

export interface ProbeResult {
  category: string;
  name: string;
  url: string;
  method: 'GET' | 'POST';
  verdict: Verdict;
  status: number | null;
  ms: number;
  sample: string;
  error: string;
}

interface ProbeSpec {
  category: string;
  name: string;
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  /** A function that pulls one interesting field out of the parsed body. */
  sample?: (j: unknown, text: string) => string;
  timeoutMs?: number;
}

const SPECS: ProbeSpec[] = [
  // ---------------------------------------------------------------- spot
  {
    category: 'Spot',
    name: 'Binance klines',
    url: 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=2',
    sample: (j) => `rows=${(j as unknown[]).length} lastClose=${(j as unknown[][]).at(-1)?.[4]}`,
  },
  {
    category: 'Spot',
    name: 'Binance 24h ticker',
    url: 'https://data-api.binance.vision/api/v3/ticker/24hr?symbol=BTCUSDT',
    sample: (j) => `lastPrice=${(j as Record<string, string>).lastPrice} chg%=${(j as Record<string, string>).priceChangePercent}`,
  },
  {
    category: 'Spot',
    name: 'Binance order book depth',
    url: 'https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=20',
    sample: (j) => {
      const d = j as { bids: [string, string][]; asks: [string, string][] };
      return `bids=${d.bids.length} top=${d.bids[0]?.[0]}`;
    },
  },
  {
    category: 'Spot',
    name: 'Binance exchangeInfo',
    url: 'https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT',
    sample: (j) => `symbols=${(j as { symbols: unknown[] }).symbols.length}`,
    timeoutMs: 25_000,
  },

  // ------------------------------------------------------------ futures
  {
    category: 'Futures',
    name: 'Binance F premiumIndex (funding/mark)',
    url: 'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT',
    sample: (j) => {
      const d = j as Record<string, string>;
      return `mark=${d.markPrice} funding=${d.lastFundingRate} next=${new Date(Number(d.nextFundingTime)).toISOString()}`;
    },
  },
  {
    category: 'Futures',
    name: 'Binance F openInterest',
    url: 'https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT',
    sample: (j) => `openInterest=${(j as Record<string, string>).openInterest}`,
  },
  {
    category: 'Futures',
    name: 'Binance F fundingRate history',
    url: 'https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=5',
    sample: (j) => `rows=${(j as unknown[]).length}`,
  },
  {
    category: 'Futures',
    name: 'Binance F fundingInfo (interval per symbol)',
    url: 'https://fapi.binance.com/fapi/v1/fundingInfo',
    sample: (j) => `symbols=${(j as unknown[]).length}`,
  },
  {
    category: 'Futures',
    name: 'Binance F openInterestHist',
    url: 'https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=5',
    sample: (j) => `rows=${(j as unknown[]).length}`,
  },
  {
    category: 'Futures',
    name: 'Binance F globalLongShortAccountRatio',
    url: 'https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=5',
    sample: (j) => `rows=${(j as unknown[]).length}`,
  },
  {
    category: 'Futures',
    name: 'Binance F topLongShortPositionRatio',
    url: 'https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=5m&limit=5',
    sample: (j) => `rows=${(j as unknown[]).length}`,
  },
  {
    category: 'Futures',
    name: 'Binance F takerlongshortRatio',
    url: 'https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=5m&limit=5',
    sample: (j) => `rows=${(j as unknown[]).length}`,
  },
  {
    category: 'Futures',
    name: 'Binance F 24h ticker',
    url: 'https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT',
    sample: (j) => `last=${(j as Record<string, string>).lastPrice}`,
  },

  // ------------------------------------------------------------ venues
  {
    category: 'Venue',
    name: 'Hyperliquid metaAndAssetCtxs',
    url: 'https://api.hyperliquid.xyz/info',
    method: 'POST',
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    headers: { 'Content-Type': 'application/json' },
    sample: (j) => {
      const d = j as [unknown[], Record<string, unknown>[]];
      return `perps=${d[1]?.length ?? 0}`;
    },
    timeoutMs: 20_000,
  },
  {
    category: 'Venue',
    name: 'Bybit linear tickers',
    url: 'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT',
    sample: (j) => {
      const d = j as { result: { list: Record<string, string>[] } };
      const t = d.result.list[0];
      return `funding=${t?.fundingRate} oi=${t?.openInterest}`;
    },
  },
  {
    category: 'Venue',
    name: 'Deribit option book summary',
    url: 'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option',
    sample: (j) => `rows=${(j as { result: unknown[] }).result.length}`,
    timeoutMs: 20_000,
  },
  {
    category: 'Venue',
    name: 'Deribit DVOL index',
    url: 'https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_dvol',
    sample: (j) => `price=${(j as { result: { price: number } }).result.price}`,
  },
  {
    category: 'Venue',
    name: 'Deribit volatility index data',
    url: 'https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&resolution=3600&start_timestamp=1&end_timestamp=9999999999999',
    sample: (j) => `continuation=${(j as { result: { continuation: unknown } }).result.continuation !== undefined}`,
    timeoutMs: 20_000,
  },
  {
    category: 'Venue',
    name: 'Coinbase BTC-USD ticker',
    url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
    sample: (j) => `price=${(j as Record<string, string>).price}`,
  },

  // ----------------------------------------------------------- market
  {
    category: 'Market',
    name: 'CoinGecko markets top 30',
    url: 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=30&page=1',
    sample: (j) => `coins=${(j as unknown[]).length}`,
    timeoutMs: 20_000,
  },
  {
    category: 'Market',
    name: 'CoinGecko global',
    url: 'https://api.coingecko.com/api/v3/global',
    sample: (j) => {
      const d = (j as { data: { total_market_cap: { usd: number } } }).data;
      return `mcap=$${(d.total_market_cap.usd / 1e9).toFixed(0)}B`;
    },
    timeoutMs: 20_000,
  },
  {
    category: 'Market',
    name: 'DefiLlama stablecoins',
    url: 'https://stablecoins.llama.fi/stablecoins',
    sample: (j) => `assets=${(j as { peggedAssets: unknown[] }).peggedAssets.length}`,
    timeoutMs: 25_000,
  },
  {
    category: 'Market',
    name: 'DefiLlama stablecoin charts (all)',
    url: 'https://stablecoins.llama.fi/stablecoincharts/all',
    sample: (j) => `rows=${(j as unknown[]).length}`,
    timeoutMs: 25_000,
  },
  {
    category: 'Market',
    name: 'Fear and Greed (31d)',
    url: 'https://api.alternative.me/fng/?limit=31',
    sample: (j) => `points=${(j as { data: unknown[] }).data.length}`,
  },
  {
    category: 'Market',
    name: 'DefiLlama emissions (unlocks)',
    url: 'https://api.llama.fi/emissions',
    sample: (j) => `keys=${Object.keys(j as object).length}`,
    timeoutMs: 20_000,
  },
  {
    category: 'Market',
    name: 'DefiLlama unlocks (documented path)',
    url: 'https://api.llama.fi/emission/breakdown',
    sample: () => 'n/a',
    timeoutMs: 20_000,
  },

  // ---------------------------------------------------------------- ETF
  {
    category: 'ETF',
    name: 'Farside BTC ETF flows',
    url: 'https://farside.co.uk/btc/',
    sample: (_j, text) => `html=${text.length}B hasTable=${/<table/i.test(text)} hasIBIT=${/IBIT/i.test(text)}`,
    headers: { Referer: 'https://farside.co.uk/' },
    timeoutMs: 25_000,
  },

  // ---------------------------------------------------------------- DEX
  {
    category: 'DEX',
    name: 'GeckoTerminal trending pools (ETH)',
    url: 'https://api.geckoterminal.com/api/v2/networks/eth/trending_pools',
    sample: (j) => `pools=${(j as { data: unknown[] }).data.length}`,
    timeoutMs: 20_000,
  },
  {
    category: 'DEX',
    name: 'DexScreener top boosts',
    url: 'https://api.dexscreener.com/token-boosts/top/v1',
    sample: (j) => `tokens=${(j as unknown[]).length}`,
    timeoutMs: 20_000,
  },

  // -------------------------------------------------------------- India
  {
    category: 'India',
    name: 'CoinDCX public ticker',
    url: 'https://api.coindcx.com/exchange/ticker',
    sample: (j) => {
      const d = j as { status: string; data?: Record<string, { last_price: number; volume: number }[]> };
      return `status=${d.status} markets=${d.data ? Object.keys(d.data).length : 0}`;
    },
    timeoutMs: 25_000,
  },

  // ---------------------------------------------------------- official
  {
    category: 'Official',
    name: 'Fed press releases (FOMC) page',
    url: 'https://www.federalreserve.gov/newsevents/pressreleases/2026-press-fomc.htm',
    sample: (_j, t) => `html=${t.length}B fomcHits=${(t.match(/monetary20\d\d/g) ?? []).length}`,
    timeoutMs: 25_000,
  },
  {
    category: 'Official',
    name: 'Fed speeches page',
    url: 'https://www.federalreserve.gov/newsevents/speeches.htm',
    sample: (_j, t) => `html=${t.length}B`,
    timeoutMs: 25_000,
  },
  {
    category: 'Official',
    name: 'SEC press releases RSS',
    url: 'https://www.sec.gov/news/pressreleases.rss',
    sample: (_j, t) => `xml=${t.length}B items=${(t.match(/<item/g) ?? []).length}`,
    headers: { 'User-Agent': 'OrderFlow research contact@example.com' },
    timeoutMs: 25_000,
  },
  {
    category: 'Official',
    name: 'BLS release schedule',
    url: 'https://www.bls.gov/schedule/news_release/2026_sched.htm',
    sample: (_j, t) => `html=${t.length}B cpi=${/Consumer Price Index/i.test(t)}`,
    headers: { 'User-Agent': UA },
    timeoutMs: 25_000,
  },
  {
    category: 'Official',
    name: 'RBI press releases',
    url: 'https://website.rbi.org.in/web/rbi/-/press-releases',
    sample: (_j, t) => `html=${t.length}B`,
    timeoutMs: 25_000,
  },
  {
    category: 'Official',
    name: 'NSE allIndices',
    url: 'https://www.nseindia.com/api/allIndices',
    headers: { Referer: 'https://www.nseindia.com/', Accept: 'application/json' },
    sample: (j) => `indices=${(j as { data: unknown[] }).data.length}`,
    timeoutMs: 25_000,
  },
  {
    category: 'Official',
    name: 'Binance exchange announcements (status)',
    url: 'https://www.binance.com/en/support/announcement',
    sample: (_j, t) => `html=${t.length}B`,
    timeoutMs: 25_000,
  },

  // -------------------------------------------------------------- news
  {
    category: 'News',
    name: 'GDELT doc API (1 req / 5s)',
    url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=bitcoin&mode=TimelineVol&format=json&timespan=1d&maxrecords=10',
    sample: (j) => `series=${(j as { timeline?: unknown[] }).timeline?.length ?? 0}`,
    timeoutMs: 30_000,
  },
];

/** WebSocket probes — separate because they need a socket, not a fetch. */
const WS_SPECS: { category: string; name: string; url: string; stream: string }[] = [
  {
    category: 'WebSocket',
    name: 'Binance spot combined (5m kline + miniTicker)',
    url: 'wss://data-stream.binance.vision/stream?streams=btcusdt@kline_5m/!miniTicker@arr',
    stream: 'btcusdt@kline_5m',
  },
  {
    category: 'WebSocket',
    name: 'Binance futures /market route (markPrice + forceOrder)',
    url: 'wss://fstream.binance.com/market/stream?streams=btcusdt@markPrice@1s/!forceOrder@arr',
    stream: 'btcusdt@markPrice@1s',
  },
];

function truncate(s: string, n = 72): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

async function probeSpec(spec: ProbeSpec): Promise<ProbeResult> {
  const started = Date.now();
  const base: Omit<ProbeResult, 'verdict' | 'status' | 'ms' | 'sample' | 'error'> = {
    category: spec.category,
    name: spec.name,
    url: spec.url,
    method: spec.method ?? 'GET',
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), spec.timeoutMs ?? 15_000);
  try {
    const res = await fetch(spec.url, {
      method: spec.method ?? 'GET',
      signal: ac.signal,
      headers: {
        'User-Agent': UA,
        Accept: spec.method === 'POST' ? 'application/json' : 'application/json, text/html, */*',
        ...spec.headers,
      },
      body: spec.method === 'POST' ? spec.body : undefined,
      redirect: 'follow',
    });
    const text = await res.text();
    const ms = Date.now() - started;

    if (!res.ok) {
      return {
        ...base,
        verdict: res.status === 403 || res.status === 451 ? 'BLOCKED' : 'FAIL',
        status: res.status,
        ms,
        sample: '',
        error: `HTTP ${res.status}`,
      };
    }

    let sample = `${truncate(text, 48)}`;
    if (spec.sample) {
      try {
        sample = spec.sample(JSON.parse(text), text);
      } catch {
        // Body was not JSON (HTML scrape) — the sample fn already handled text.
        if (!spec.sample) sample = `${truncate(text, 48)}`;
      }
    }
    return { ...base, verdict: 'OK', status: res.status, ms, sample: truncate(sample), error: '' };
  } catch (err) {
    const ms = Date.now() - started;
    const e = err as Error;
    const aborted = e.name === 'AbortError';
    return {
      ...base,
      verdict: 'FAIL',
      status: null,
      ms,
      sample: '',
      error: aborted ? `timeout after ${ms}ms` : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeWs(spec: { category: string; name: string; url: string; stream: string }): Promise<ProbeResult> {
  const started = Date.now();
  const base = { category: spec.category, name: spec.name, url: spec.url, method: 'GET' as const };

  return new Promise((resolvePromise) => {
    let settled = false;
    let ws: WebSocket;

    const finish = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolvePromise(r);
    };

    try {
      ws = new WebSocket(spec.url);
    } catch (err) {
      finish({
        ...base,
        verdict: 'FAIL',
        status: null,
        ms: Date.now() - started,
        sample: '',
        error: (err as Error).message,
      });
      return;
    }

    const timer = setTimeout(() => {
      finish({
        ...base,
        verdict: 'FAIL',
        status: null,
        ms: Date.now() - started,
        sample: '',
        error: `no message within 12s (connected=${ws.readyState === WebSocket.OPEN})`,
      });
    }, 12_000);

    ws.onopen = () => {
      /* wait for the first payload */
    };

    ws.onmessage = (ev) => {
      clearTimeout(timer);
      const raw = typeof ev.data === 'string' ? ev.data : '(binary)';
      finish({
        ...base,
        verdict: 'OK',
        status: 101,
        ms: Date.now() - started,
        sample: truncate(raw, 72),
        error: '',
      });
    };

    ws.onerror = () => {
      clearTimeout(timer);
      finish({
        ...base,
        verdict: 'BLOCKED',
        status: null,
        ms: Date.now() - started,
        sample: '',
        error: 'socket error (blocked or TLS failure)',
      });
    };

    ws.onclose = (ev) => {
      clearTimeout(timer);
      if (settled) return;
      finish({
        ...base,
        verdict: 'BLOCKED',
        status: null,
        ms: Date.now() - started,
        sample: '',
        error: `closed before first message (code ${ev.code})`,
      });
    };
  });
}

async function main() {
  console.log('\nOrderFlow source probe — started', new Date().toISOString(), '\n');

  const results: ProbeResult[] = [];

  // REST probes, 4 at a time so we do not trip per-host limits.
  const CONC = 4;
  for (let i = 0; i < SPECS.length; i += CONC) {
    const batch = SPECS.slice(i, i + CONC);
    const batchResults = await Promise.all(batch.map(probeSpec));
    for (const r of batchResults) {
      results.push(r);
      const icon = r.verdict === 'OK' ? 'OK  ' : r.verdict === 'BLOCKED' ? 'BLK ' : 'FAIL';
      const line = `  ${icon} ${r.category.padEnd(9)} ${r.name.padEnd(42)} ${String(r.ms).padStart(5)}ms  ${r.error || r.sample}`;
      console.log(line);
    }
  }

  console.log('');
  for (const spec of WS_SPECS) {
    const r = await probeWs(spec);
    results.push(r);
    const icon = r.verdict === 'OK' ? 'OK  ' : 'FAIL';
    console.log(`  ${icon} ${r.category.padEnd(9)} ${r.name.padEnd(42)} ${String(r.ms).padStart(5)}ms  ${r.error || r.sample}`);
  }

  const ok = results.filter((r) => r.verdict === 'OK');
  const blocked = results.filter((r) => r.verdict === 'BLOCKED');
  const failed = results.filter((r) => r.verdict === 'FAIL');

  console.log(`\n────────────────────────────────────────────`);
  console.log(`  ${results.length} probes: ${ok.length} OK · ${blocked.length} BLOCKED · ${failed.length} FAIL`);
  console.log('────────────────────────────────────────────\n');

  const byCategory = new Map<string, ProbeResult[]>();
  for (const r of results) {
    const arr = byCategory.get(r.category);
    if (arr) arr.push(r);
    else byCategory.set(r.category, [r]);
  }
  for (const [cat, rs] of byCategory) {
    const good = rs.filter((r) => r.verdict === 'OK').length;
    const tone = good === rs.length ? 'all OK' : good === 0 ? 'ALL BLOCKED' : `${good}/${rs.length} OK`;
    console.log(`  ${cat.padEnd(11)} ${tone}`);
  }

  const out = resolve(__dirname, '../server/data/probe-results.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nWrote ${out}\n`);
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});