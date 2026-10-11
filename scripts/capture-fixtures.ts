/**
 * Captures real API responses into `server/test/fixtures/*.json`.
 *
 * Fixtures are saved from live responses rather than hand-written so the tests
 * exercise the actual wire shapes Binance returns — including the field-order
 * traps that caused the CVD bug (taker volume is at index 9 for base and 10
 * for quote) and the numeric-as-string behaviour of every kline field.
 *
 *   npx tsx scripts/capture-fixtures.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson } from '../server/src/lib/http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../server/test/fixtures');
mkdirSync(OUT, { recursive: true });

const SPOT = 'https://data-api.binance.vision';
const FUT = 'https://fapi.binance.com';

async function grab(name: string, url: string, keep?: (j: unknown) => unknown) {
  try {
    const j = await fetchJson<unknown>(url, { label: name, retries: 1, timeoutMs: 20_000 });
    const payload = {
      _capturedAt: new Date().toISOString(),
      _source: url,
      ...(typeof j === 'object' && j !== null && keep ? (keep(j) as object) : { data: j }),
    };
    writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(payload, null, 2));
    const size = JSON.stringify(payload).length;
    console.log(`  saved ${name}.json  ${(size / 1024).toFixed(1)}KB`);
  } catch (err) {
    console.warn(`  FAILED ${name}: ${(err as Error).message}`);
  }
}

console.log('\nCapturing live fixtures for unit tests...\n');

// ── Klines: the CVD source. Keep 40 rows so the taker-volume fields survive.
await grab(
  'klines_btc_5m',
  `${SPOT}/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=40`,
  (j) => ({ rows: j }),
);

// A cheap alt, to prove the CVD scaling is not a BTC-only accident.
await grab(
  'klines_xrp_5m',
  `${SPOT}/api/v3/klines?symbol=XRPUSDT&interval=5m&limit=40`,
  (j) => ({ rows: j }),
);

// ── premiumIndex: mark, index and lastFundingRate in one call.
await grab(
  'premium_index',
  `${FUT}/fapi/v1/premiumIndex?symbol=BTCUSDT`,
);

// ── fundingInfo: the per-symbol funding interval that normalisation depends on.
await grab(
  'funding_info',
  `${FUT}/fapi/v1/fundingInfo`,
  (j) => {
    const arr = j as { symbol: string; fundingIntervalHours: number }[];
    return { sample: arr.slice(0, 25), total: arr.length };
  },
);

// ── openInterestHist: the series oiChanges() reads.
await grab(
  'oi_hist_btc',
  `${FUT}/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=30`,
  (j) => ({ rows: j }),
);

// ── long/short ratios.
await grab(
  'long_short_btc',
  `${FUT}/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=20`,
  (j) => ({ rows: j }),
);

// ── Coinbase + Binance side by side, for the premium check the user asked for.
const [cb, bn] = await Promise.allSettled([
  fetchJson<{ price: string }>(`https://api.exchange.coinbase.com/products/BTC-USD/ticker`, { retries: 1 }),
  // /api/v3/ticker/price returns {symbol, price} — NOT {symbol, lastPrice},
  // which is the /ticker/24hr shape. Getting this wrong produced NaN.
  fetchJson<{ symbol: string; price: string }>(`${SPOT}/api/v3/ticker/price?symbol=BTCUSDT`, { retries: 1 }),
]);
if (cb.status === 'fulfilled' && bn.status === 'fulfilled') {
  const coinbase = Number(cb.value.price);
  const binance = Number(bn.value.price);
  writeFileSync(
    resolve(OUT, 'coinbase_premium.json'),
    JSON.stringify(
      {
        _capturedAt: new Date().toISOString(),
        coinbasePrice: coinbase,
        binancePrice: binance,
        premiumPct: ((coinbase - binance) / binance) * 100,
        note: 'Coinbase BTC-USD vs Binance BTCUSDT. USDT is assumed ~1 USD; a real USDT/USD rate would refine this.',
      },
      null,
      2,
    ),
  );
  console.log(`  saved coinbase_premium.json  premium=${(((coinbase - binance) / binance) * 100).toFixed(4)}%`);
} else {
  console.warn('  FAILED coinbase_premium');
}

console.log('\nDone.\n');
