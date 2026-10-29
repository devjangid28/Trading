import { fetchJsonSafe } from '../lib/http.js';
import { cached } from '../lib/cache.js';

export interface GexStrike {
  strike: number;
  callOi: number;
  putOi: number;
  /** Net gamma exposure in USD. Positive = dealers long gamma (stabilising). */
  netGex: number;
}

export interface GexSnapshot {
  symbol: 'BTC' | 'ETH';
  price: number;
  /** Largest absolute GEX strike — acts as a magnet / pin level. */
  maxPainStrike: number;
  /** Strike with the most call open interest; dealers defend above it. */
  callWall: number;
  /** Strike with the most put open interest; dealers defend below it. */
  putWall: number;
  /** Strike where cumulative net GEX crosses zero, interpolated between strikes. */
  zeroGamma: number;
  /** Net market GEX. Positive = dealers long gamma (market stabilises). Negative = dealers short gamma (moves amplify). */
  totalNetGex: number;
  /** True when dealers are net short gamma — moves tend to accelerate. */
  dealersShortGamma: boolean;
  /** Key strikes sorted by |netGex| descending. */
  strikes: GexStrike[];
  asOf: number;
}

interface DeribitSummary {
  instrument_name: string;
  open_interest: number;
  mark_price: number;
  underlying_price: number;
}

/**
 * Fetch GEX from Deribit's free public API.
 * No key required. Rate limit is generous for this use case (~10 req/min).
 *
 * GEX = gamma × OI × spot² × 0.01
 * Dealers are assumed to be short options (the standard assumption for
 * market-maker positioning). A call OI at strike K means dealers are long
 * the underlying above K (stabilising). Put OI means dealers are short
 * below K (destabilising on the way down).
 */
async function fetchGex(currency: 'BTC' | 'ETH'): Promise<GexSnapshot | null> {
  const url =
    `https://www.deribit.com/api/v2/public/get_book_summary_by_currency` +
    `?currency=${currency}&kind=option`;

  type GexResult = { result: DeribitSummary[] };
  const res = await fetchJsonSafe<GexResult>(
    url,
    { result: [] },
    { label: `deribit gex ${currency}`, retries: 1, timeoutMs: 10_000 },
  );

  if (!res.result.length) return null;

  // Get spot price from the first result's underlying_price
  const spot = res.result.find((r) => r.underlying_price > 0)?.underlying_price ?? 0;
  if (spot <= 0) return null;

  // Parse strikes from instrument names like BTC-28JUN24-70000-C
  const strikeMap = new Map<number, { callOi: number; putOi: number }>();

  for (const item of res.result) {
    const parts = item.instrument_name.split('-');
    if (parts.length < 4) continue;
    const strike = Number(parts[2]);
    const isCall = parts[3] === 'C';
    if (!Number.isFinite(strike) || strike <= 0) continue;

    const existing = strikeMap.get(strike) ?? { callOi: 0, putOi: 0 };
    if (isCall) existing.callOi += item.open_interest;
    else existing.putOi += item.open_interest;
    strikeMap.set(strike, existing);
  }

  if (strikeMap.size === 0) return null;

  // Compute GEX per strike. Using simplified gamma proxy: OI × spot / 100
  // (full Black-Scholes gamma needs IV per strike which requires more calls)
  const strikes: GexStrike[] = [];
  let totalNetGex = 0;
  let maxPainStrike = spot;
  let maxPainOi = 0;

  for (const [strike, { callOi, putOi }] of strikeMap) {
    // Dealers short calls → long delta above strike (stabilising)
    // Dealers short puts → short delta below strike (destabilising)
    const callGex = callOi * spot * spot * 0.0001;
    const putGex = -putOi * spot * spot * 0.0001;
    const netGex = callGex + putGex;
    totalNetGex += netGex;
    strikes.push({ strike, callOi, putOi, netGex });

    // Max pain = strike with most total OI (where most options expire worthless)
    const totalOi = callOi + putOi;
    if (totalOi > maxPainOi) { maxPainOi = totalOi; maxPainStrike = strike; }
  }

  strikes.sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex));

  let callWall = maxPainStrike;
  let putWall = maxPainStrike;
  let maxCallOi = -1;
  let maxPutOi = -1;
  for (const s of strikes) {
    if (s.callOi > maxCallOi) { maxCallOi = s.callOi; callWall = s.strike; }
    if (s.putOi > maxPutOi) { maxPutOi = s.putOi; putWall = s.strike; }
  }

  const byStrike = [...strikes].sort((a, b) => a.strike - b.strike);
  let zeroGamma = spot;
  let cum = 0;
  let prevCum = 0;
  let prevStrike: number | null = null;
  for (const s of byStrike) {
    prevCum = cum;
    cum += s.netGex;
    if (prevStrike !== null && prevCum !== 0 && Math.sign(prevCum) !== Math.sign(cum)) {
      const weight = Math.abs(prevCum) / Math.max(1e-9, Math.abs(prevCum) + Math.abs(cum));
      zeroGamma = prevStrike + (s.strike - prevStrike) * weight;
      break;
    }
    prevStrike = s.strike;
  }

  return {
    symbol: currency,
    price: spot,
    maxPainStrike,
    callWall,
    putWall,
    zeroGamma,
    totalNetGex,
    dealersShortGamma: totalNetGex < 0,
    strikes: strikes.slice(0, 20),
    asOf: Date.now(),
  };
}

export async function getGex(currency: 'BTC' | 'ETH'): Promise<GexSnapshot | null> {
  return cached(`gex:${currency}`, 5 * 60_000, () => fetchGex(currency));
}

export async function getAllGex(): Promise<{ btc: GexSnapshot | null; eth: GexSnapshot | null }> {
  const [btc, eth] = await Promise.allSettled([getGex('BTC'), getGex('ETH')]);
  return {
    btc: btc.status === 'fulfilled' ? btc.value : null,
    eth: eth.status === 'fulfilled' ? eth.value : null,
  };
}
