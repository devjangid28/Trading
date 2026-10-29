/**
 * FIX 3 â€” `npm run record-fixtures`.
 *
 * A ONE-TIME capture of real responses into `fixtures/` plus a manifest.
 *
 * Politeness rules this script obeys, in order of importance:
 *   1. It refuses to run while any host is under a ban. Capturing during a ban
 *      is how you turn a 2-minute block into a 3-day one.
 *   2. Requests are sequential with a fixed gap. No bursts.
 *   3. It calls the ordinary `fetchText`, so the new rate limiter governs it â€”
 *      the recorder cannot accidentally bypass the thing it is helping protect.
 *   4. It runs once and writes a manifest with a timestamp. Re-running is a
 *      deliberate act, not something a test or `npm install` triggers.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchText, bans } from '../server/src/lib/http.js';
import { FIXTURES_DIR, saveManifest, type FixtureEntry } from '../server/src/mock/fixtures.js';
import { UNIVERSE, UNIVERSE_BY_BASE } from '../server/src/data/universe.js';

const FORCE = process.argv.includes('--force');
const GAP_MS = 700;
const OUT = FIXTURES_DIR;

/** Anything the UI needs to render a full screen. */
interface Target { name: string; url: string; optional?: boolean }

const SPOT = 'https://data-api.binance.vision';
const FUT = 'https://fapi.binance.com';

/**
 * Symbols to record.
 *
 * A bounded set on purpose: capturing every tracked pair on four timeframes is
 * ~220 requests, and doing that politely is minutes. The set below is chosen to
 * cover every sector plus the majors, so a mock board exercises the scanner's
 * sector, breadth and percentile logic rather than one sector only.
 */
const SAMPLE_BASES = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT',
  'MATIC', 'LTC', 'ATOM', 'UNI', 'APT', 'NEAR', 'INJ', 'FIL', 'ARB', 'OP',
];

const base = UNIVERSE_BY_BASE;
const TARGETS: Target[] = [];
for (const b of SAMPLE_BASES) {
  if (!base.has(b)) continue;
  const s = `${b}USDT`;
  for (const tf of ['5m', '15m', '1h', '4h']) {
    TARGETS.push({ name: `klines_${b}_${tf}`, url: `${SPOT}/api/v3/klines?symbol=${s}&interval=${tf}&limit=500` });
  }
}

// Single-call market-wide endpoints â€” cheap and high value.
TARGETS.push(
  { name: 'ticker_24hr', url: `${SPOT}/api/v3/ticker/24hr` },
  { name: 'exchange_info', url: `${SPOT}/api/v3/exchangeInfo?permissions=SPOT` },
  { name: 'server_time', url: `${SPOT}/api/v3/time` },
);

// Derivatives: the panels the mock UI renders.
TARGETS.push(
  { name: 'fapi_ticker_24hr', url: `${FUT}/fapi/v1/ticker/24hr`, optional: true },
  { name: 'fapi_premium_index', url: `${FUT}/fapi/v1/premiumIndex`, optional: true },
  { name: 'fapi_funding_info', url: `${FUT}/fapi/v1/fundingInfo`, optional: true },
  { name: 'fapi_open_interest', url: `${FUT}/fapi/v1/openInterest?symbol=BTCUSDT`, optional: true },
  { name: 'fapi_oi_hist_btc', url: `${FUT}/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=30`, optional: true },
  { name: 'fapi_ls_ratio_btc', url: `${FUT}/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=30`, optional: true },
  { name: 'fapi_taker_btc', url: `${FUT}/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=5m&limit=30`, optional: true },
  { name: 'fapi_depth_btc', url: `${SPOT}/api/v3/depth?symbol=BTCUSDT&limit=20` },
);

// Options (Deribit) and cross-venue.
TARGETS.push(
  { name: 'deribit_index', url: 'https://www.deribit.com/api/v2/public/get_index?index_name=btc_dvol', optional: true },
  { name: 'hyperliquid_meta', url: 'https://api.hyperliquid.xyz/info', optional: true },
  { name: 'bybit_tickers', url: 'https://api.bybit.com/v5/market/tickers?category=linear', optional: true },
);

// Macro and news.
TARGETS.push(
  { name: 'coingecko_markets', url: 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1', optional: true },
  { name: 'coingecko_global', url: 'https://api.coingecko.com/api/v3/global', optional: true },
  { name: 'fear_greed', url: 'https://api.alternative.me/fng/?limit=8' },
  { name: 'stablecoin_charts', url: 'https://stablecoins.llama.fi/stablecoincharts/all', optional: true },
);

for (const feed of [
  ['coindesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['cointelegraph', 'https://cointelegraph.com/rss'],
  ['decrypt', 'https://decrypt.co/feed'],
  ['bitcoinmagazine', 'https://bitcoinmagazine.com/feed'],
] as const) {
  TARGETS.push({ name: `rss_${feed[0]}`, url: feed[1], optional: true });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('');
  console.log('FIXTURE RECORDING â€” one-time capture of real responses');
  console.log(`universe: ${UNIVERSE.length} tracked pairs, sampling ${SAMPLE_BASES.length}`);
  console.log(`output:   ${OUT}`);
  console.log('');

  // Rule 1. Do not touch a banned host, ever.
  const snap = bans.snapshot();
  const banned = snap.hosts.filter((h) => h.banned);
  if (banned.length) {
    console.error('REFUSING TO RECORD â€” a host is under an active ban:');
    for (const b of banned) {
      console.error(`  ${b.host} until ${new Date(b.bannedUntil!).toISOString()} (${Math.ceil(b.remainingMs / 1000)}s)`);
    }
    console.error('Run again after the window closes.');
    process.exit(2);
  }

  mkdirSync(OUT, { recursive: true });
  const entries: FixtureEntry[] = [];
  const failed: string[] = [];

  for (const t of TARGETS) {
    const started = Date.now();
    try {
      const body = await fetchText(t.url, {
        label: `record ${t.name}`,
        retries: 1,
        timeoutMs: 20_000,
        // Recording is the one moment we justify spending weight.
        purpose: 'essential',
      });
      const u = new URL(t.url);
      const entry: FixtureEntry = {
        key: `${u.host}${u.pathname}`,
        url: t.url,
        host: u.host,
        path: u.pathname,
        status: 200,
        headers: { 'content-type': guessType(u.pathname) },
        body,
        capturedAt: new Date().toISOString(),
        bytes: Buffer.byteLength(body),
      };
      entries.push(entry);
      console.log(`  ok   ${t.name.padEnd(26)} ${(entry.bytes / 1024).toFixed(1)}KB  ${Date.now() - started}ms`);
    } catch (err) {
      if (!t.optional) failed.push(t.name);
      console.log(`  FAIL ${t.name.padEnd(26)} ${(err as Error).message}`);
    }
    await sleep(GAP_MS);
  }

// The manifest already carries every body, which is what the replay
  // transport reads. Writing them out again doubles the fixture directory for
  // no functional gain, so the readable copies are opt-in via --bodies.
  if (process.argv.includes('--bodies')) {
    const bodies = join(OUT, 'bodies');
    mkdirSync(bodies, { recursive: true });
    for (const e of entries) {
      const ext = e.path.includes('rss') || e.host.includes('decrypt') ? 'xml' : 'json';
      writeFileSync(join(bodies, `${e.key.replace(/[^a-z0-9]+/gi, '_')}.${ext}`), e.body, 'utf8');
    }
  }

  saveManifest({ entries, capturedAt: new Date().toISOString() });

  console.log('');
  console.log(`  recorded ${entries.length} fixtures (${(entries.reduce((a, e) => a + e.bytes, 0) / 1024 / 1024).toFixed(2)}MB)`);
  console.log(`  manifest: ${join(OUT, 'manifest.json')}`);
  if (failed.length) {
    console.log(`  REQUIRED targets failed: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log(`  required targets: all captured`);
  console.log('');
  console.log('  Now run:  npm run dev:mock');
  console.log('');
}

function guessType(pathname: string): string {
  if (pathname.includes('rss') || pathname.endsWith('/')) return 'application/xml';
  return 'application/json';
}

void main();
