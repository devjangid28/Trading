import { fetchJson, fetchJsonSafe } from '../lib/http.js';
import { cached } from '../lib/cache.js';
import type { MacroState } from '../../../shared/types';
import { fetchTickers } from './binance.js';
import { geckoGlobal } from './coingecko.js';
import { yahooChartCached } from './yahoo.js';


/**
 * alternative.me Fear & Greed index. Note two gotchas: `value` is a STRING,
 * and `time_until_update` breaks when `date_format` is passed, so we use the
 * default epoch timestamps.
 */
async function fearGreed(): Promise<MacroState['fearGreed']> {
  const res = await fetchJson<{
    data: { value: string; value_classification: string; timestamp: string }[];
  }>('https://api.alternative.me/fng/?limit=8', { label: 'alternative.me fng', retries: 1 });
  const pts = res.data ?? [];
  if (!pts.length) return null;
  const now = Date.now();
  const latest = pts[0];
  const value = Number(latest.value);
  const ts = Number(latest.timestamp) * 1000;
  // The API returns midnight-UTC snapshots, so a "7d ago" point may not exist
  // yet in the 8-item window; fall back to comparing against the oldest point.
  const weekAgo = pts.find((p) => Math.abs(ts - Number(p.timestamp) * 1000) >= 6.5 * 86400_000)
    ?? pts[pts.length - 1];
  const change7d = weekAgo ? value - Number(weekAgo.value) : null;
  return {
    value,
    label: latest.value_classification,
    change7d,
    updatedAt: ts <= now ? ts : now,
  };
}

/**
 * DefiLlama stablecoin float. The documented api.llama.fi endpoints now 404 —
 * the stablecoin APIs moved to the stablecoins.llama.fi host.
 */
async function stablecoins(): Promise<MacroState['stablecoins']> {
  const chart = await fetchJsonSafe<
    { date: string; totalCirculatingUSD?: { peggedUSD: number }; totalCirculating?: { peggedUSD: number } }[]
  >('https://stablecoins.llama.fi/stablecoincharts/all', [], { label: 'defillama stablecoins', retries: 1 });

  if (!chart.length) return null;
  const val = (p: (typeof chart)[number]) => p.totalCirculatingUSD?.peggedUSD ?? p.totalCirculating?.peggedUSD ?? 0;
  const last = val(chart[chart.length - 1]);
  const findAgo = (days: number) => {
    const target = Date.now() / 1000 - days * 86400;
    let best = chart[0];
    let bestDiff = Infinity;
    for (const p of chart) {
      const d = Math.abs(Number(p.date) - target);
      if (d < bestDiff) {
        bestDiff = d;
        best = p;
      }
    }
    return val(best);
  };
  const week = findAgo(7);
  const month = findAgo(30);

  // Shares and the peg monitor come from the asset list, which carries `price`
  // and `circulating` per asset — so depeg detection is free.
  const assets = await fetchJsonSafe<{
    peggedAssets: {
      symbol: string; name: string; price: number;
      circulating: { peggedUSD?: number };
    }[];
  }>('https://stablecoins.llama.fi/stablecoins', { peggedAssets: [] }, { label: 'defillama stablecoin list', retries: 1 });

  const total = assets.peggedAssets.reduce((a, s) => a + (s.circulating?.peggedUSD ?? 0), 0) || last;
  const shareOf = (sym: string): number | null => {
    const found = assets.peggedAssets.find((s) => s.symbol.toUpperCase() === sym);
    if (!found || total <= 0) return null;
    return Math.round(((found.circulating?.peggedUSD ?? 0) / total) * 10_000) / 100;
  };

  // [V] Anything under 0.995 is a depeg.
  const pegged = assets.peggedAssets
    .filter((s) => (s.circulating?.peggedUSD ?? 0) > 100_000_000 && Number.isFinite(s.price))
    .map((s) => ({
      symbol: s.symbol.toUpperCase(),
      price: s.price,
      depegged: s.price < 0.995,
    }))
    .sort((a, b) => a.price - b.price)
    .slice(0, 8);

  return {
    totalUsd: Math.round(last),
    change7dPct: week > 0 ? Math.round(((last - week) / week) * 10_000) / 100 : null,
    change30dPct: month > 0 ? Math.round(((last - month) / month) * 10_000) / 100 : null,
    usdtShare: shareOf('USDT'),
    usdcShare: shareOf('USDC'),
    pegged,
    updatedAt: Date.now(),
  };
}

export async function globalMarket(): Promise<MacroState['globalMarket']> {
  const res = await geckoGlobal();
  const d = res.data;
  return {
    totalMarketCapUsd: Math.round(d.total_market_cap.usd),
    totalVolumeUsd: Math.round(d.total_volume.usd),
    marketCapChange24h: d.market_cap_change_percentage_24h_usd ?? 0,
    btcDominance: Math.round((d.market_cap_percentage?.btc ?? 0) * 10) / 10,
    ethDominance: Math.round((d.market_cap_percentage?.eth ?? 0) * 10) / 10,
    activeCoins: d.active_cryptocurrencies,
  };
}

export interface IndiaSnapshot {
  vix: number | null;
  usdInr: number | null;
  sensex: number | null;
  nifty: number | null;
  niftyChangePct: number | null;
  sensexChangePct: number | null;
  btcInr: number | null;
  inrPremiumPct: number | null;
  premiumSource: string | null;
}

/**
 * [PROBED] CoinDCX returns a BARE ARRAY of market objects, not the
 * `{status, data}` wrapper its docs suggest, and every field is a string.
 * Markets are BASEUSDT with USDT as the INR quote.
 */
export async function indiaExchangePremium(btcUsd: number | null): Promise<IndiaSnapshot> {
  const empty: IndiaSnapshot = {
    vix: null, usdInr: null, sensex: null, nifty: null,
    niftyChangePct: null, sensexChangePct: null,
    btcInr: null, inrPremiumPct: null, premiumSource: null,
  };

  const [dcx, usdInr] = await Promise.all([
    fetchJsonSafe<
      { market: string; last_price: string; volume: string }[]
    >('https://api.coindcx.com/exchange/ticker', [], { label: 'coindcx ticker', retries: 1, timeoutMs: 20_000 }),
    cached('india:usdinr', 300_000, () => yahooQuote('INR=X')),
  ]);

  if (!dcx.length || !usdInr || !btcUsd) return { ...empty, usdInr };

  const btcInrMarket = dcx.find((m) => m.market === 'BTCUSDT');
  if (!btcInrMarket) return { ...empty, usdInr };

  const btcInr = Number(btcInrMarket.last_price);
  if (!Number.isFinite(btcInr) || btcInr <= 0) return { ...empty, usdInr };

  // The premium is COMPUTED, never assumed from blog posts.
  const globalInr = btcUsd * usdInr;
  const inrPremiumPct = globalInr > 0
    ? Math.round(((btcInr - globalInr) / globalInr) * 10_000) / 100
    : null;

  return {
    vix: null, usdInr, sensex: null, nifty: null,
    niftyChangePct: null, sensexChangePct: null,
    btcInr,
    inrPremiumPct,
    premiumSource: 'coindcx',
  };
}

/** Yahoo chart is the only no-key route for FX. Needs the cookie+crumb. */
async function yahooQuote(symbol: string): Promise<number | null> {
  try {
    const chart = await yahooChartCached(symbol, '1h', '1d', 300_000);
    return chart?.meta.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

/** Indian risk gauges come from the NSE allIndices endpoint, which is keyless. */
export async function indiaSnapshot(): Promise<IndiaSnapshot> {
  const base: IndiaSnapshot = {
    vix: null, usdInr: null, sensex: null, nifty: null,
    niftyChangePct: null, sensexChangePct: null,
    btcInr: null, inrPremiumPct: null, premiumSource: null,
  };
  try {
    const res = await fetchJson<{
      data: { index: string; last: number; percentChange: number }[];
    }>('https://www.nseindia.com/api/allIndices', {
      label: 'nse allIndices',
      retries: 1,
      timeoutMs: 10_000,
      headers: { Referer: 'https://www.nseindia.com/', Accept: 'application/json' },
    });
    const pick = (name: string) => res.data.find((d) => d.index === name);
    const vix = pick('INDIA VIX');
    const sensex = pick('S&P BSE SENSEX');
    const nifty = pick('NIFTY 50');
    const bank = pick('NIFTY BANK');
    return {
      ...base,
      vix: vix ? Math.round(vix.last * 100) / 100 : null,
      sensex: sensex?.last ?? null,
      sensexChangePct: sensex?.percentChange ?? null,
      // NSE allIndices has no NIFTY 50 by that exact name in every build, so
      // fall back to Bank Nifty rather than showing a hole.
      nifty: nifty?.last ?? bank?.last ?? null,
      niftyChangePct: nifty?.percentChange ?? bank?.percentChange ?? null,
    };
  } catch {
    return base;
  }
}

export async function macroState(): Promise<MacroState> {
  return cached('macro:state', 60_000, async () => {
    const [fg, sc, gm, btcTicker] = await Promise.all([
      fearGreed().catch(() => null),
      stablecoins().catch(() => null),
      globalMarket().catch(() => null),
      fetchTickers().catch(() => []),
    ]);

    const btc = btcTicker.find((t) => t.symbol === 'BTCUSDT');
    const [nse, premium, coinbase] = await Promise.all([
      indiaSnapshot(),
      indiaExchangePremium(btc?.lastPrice ?? null),
      coinbasePremium(btc?.lastPrice ?? null),
    ]);

    const india: MacroState['india'] = {
      vix: nse.vix,
      usdInr: premium.usdInr,
      btcInr: premium.btcInr,
      sensex: nse.sensex,
      nifty: nse.nifty,
      niftyChangePct: nse.niftyChangePct,
      sensexChangePct: nse.sensexChangePct,
      inrPremiumPct: premium.inrPremiumPct,
      premiumSource: premium.premiumSource,
    };

    return {
      fearGreed: fg,
      stablecoins: sc,
      globalMarket: gm,
      btc: btc ? { price: btc.lastPrice, changePct: btc.priceChangePercent } : null,
      coinbasePremiumPct: coinbase,
      // [TUNED] float / total market cap — "dry powder".
      dryPowderRatio:
        sc && gm ? Math.round((sc.totalUsd / gm.totalMarketCapUsd) * 10_000) / 10_000 : null,
      etfFlows: { available: false, reason: ETF_FLOWS_BLOCKED_REASON, lastGoodAt: null },
      options: [],
      india,
    };
  });
}

const ETF_FLOWS_BLOCKED_REASON =
  'Farside and SoSoValue both return HTTP 403 from this network. ETF flow data is unavailable. ' +
  'Populate server/data/etf-flows.json manually to override.';

/**
 * [V] A persistently positive Coinbase premium is a US-demand proxy; negative
 * shows US selling. It is a USD-denominated comparison, not a directional call.
 */
async function coinbasePremium(btcUsd: number | null): Promise<number | null> {
  if (!btcUsd) return null;
  const cb = await fetchJsonSafe<{ price: string } | null>(
    'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
    null,
    { label: 'coinbase ticker', retries: 1 },
  );
  const price = Number(cb?.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  return Math.round(((price - btcUsd) / btcUsd) * 10_000) / 100;
}
