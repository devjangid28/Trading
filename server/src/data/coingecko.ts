import { NETWORK, RATE } from '../config.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';

/**
 * One rate-limit-aware door to CoinGecko.
 *
 * The free API is shared per IP, so a page load burst used to look like abuse:
 * boot identity refresh, the scanner's altseason call, and `/api/macro` all
 * hit `/coins/markets` or `/global` within seconds. A 429 then banned the host
 * for two minutes and the macro strip silently lost its global tiles.
 *
 * Three rules now apply to every call:
 *  - one shared markets payload (250 rows) serves both identity and altseason;
 *  - successful responses are cached for five minutes;
 *  - requests are serialised with a minimum gap, so a cache miss cannot burst.
 *
 * A demo/pro key can be supplied through the environment. The key is optional:
 * without it the same code still works at the public rate.
 */

export interface GeckoMarket {
  id: string;
  symbol: string;
  name: string;
  image?: string;
  market_cap?: number;
  price_change_percentage_30d: number | null;
}

export interface GeckoGlobalResponse {
  data: {
    total_market_cap: { usd: number };
    total_volume: { usd: number };
    market_cap_percentage: { btc: number; eth: number };
    market_cap_change_percentage_24h_usd: number;
    active_cryptocurrencies: number;
  };
}

const MARKETS_PATH =
  '/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1'
  + '&price_change_percentage=30d';
const GLOBAL_PATH = '/api/v3/global';

let lastRequestAt = 0;
let paceChain: Promise<unknown> = Promise.resolve();

function headers(): Record<string, string> {
  const demo = process.env.COINGECKO_DEMO_KEY?.trim();
  if (demo) return { 'x-cg-demo-api-key': demo };
  const pro = process.env.COINGECKO_PRO_KEY?.trim();
  if (pro) return { 'x-cg-pro-api-key': pro };
  return {};
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialise upstream calls and enforce the minimum gap. The chain is advanced
 * even after a failure, otherwise one timeout would wedge every later request.
 */
function paced<T>(producer: () => Promise<T>): Promise<T> {
  const start = paceChain.then(async () => {
    const wait = lastRequestAt + RATE.COINGECKO_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await delay(wait);
    lastRequestAt = Date.now();
  });
  const run = start.then(producer);
  paceChain = run.then(() => undefined, () => undefined);
  return run;
}

function json<T>(path: string, ttlMs: number, label: string): Promise<T> {
  return cached(`coingecko:${path}`, ttlMs, () =>
    paced(() => fetchJson<T>(`${NETWORK.COINGECKO_HOST}${path}`, {
      label,
      retries: 1,
      timeoutMs: 20_000,
      purpose: 'nonessential',
      headers: headers(),
    })),
  );
}

/** Top 250 by market cap, with 30d change, shared by identity and altseason. */
export function geckoMarkets(): Promise<GeckoMarket[]> {
  return json<GeckoMarket[]>(MARKETS_PATH, RATE.COINGECKO_MARKETS_TTL_MS, 'coingecko markets');
}

/** Global market cap/volume/dominance. Cached separately from the coin list. */
export function geckoGlobal(): Promise<GeckoGlobalResponse> {
  return json<GeckoGlobalResponse>(GLOBAL_PATH, RATE.COINGECKO_GLOBAL_TTL_MS, 'coingecko global');
}
