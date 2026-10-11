import { DERIVATIVES, NETWORK, RATE, REFRESH } from '../../config.js';
import { cached } from '../../lib/cache.js';
import { fetchJson, fetchText } from '../../lib/http.js';
import type { LsPoint, Meta, OiPoint } from '../../../../shared/types';

/**
 * Phase 2 â€” derivatives providers.
 *
 * Binance futures is PRIMARY: Phase 0 confirmed every endpoint reachable from
 * India. Hyperliquid and Bybit exist for cross-venue comparison, which is
 * where they are actually valuable.
 */

export interface DerivRaw {
  symbol: string;
  /** The perp symbol on the venue, which can differ (e.g. 1000PEPEUSDT). */
  venueSymbol: string;
  markPrice: number;
  indexPrice: number;
  /** Raw funding rate for the symbol's own interval. */
  fundingRate: number;
  fundingIntervalH: number;
  nextFundingTime: number;
  openInterest: number;
}

export interface OiHist {
  symbol: string;
  points: OiPoint[];
}

export interface LsSeries {
  symbol: string;
  accountRatio: LsPoint[];
  topPositionRatio: LsPoint[];
  takerRatio: LsPoint[];
}

export interface DerivativesProvider {
  name: string;
  snapshot(symbols: string[]): Promise<DerivRaw[]>;
  oiHistory(symbol: string, period: '5m' | '15m' | '1h' | '4h' | '1d', limit: number): Promise<OiHist>;
  longShort?(symbol: string, period: string): Promise<LsSeries>;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Binance futures (primary â€” verified working from India)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const F = NETWORK.BINANCE_FUT_HOST;

/**
 * fundingInfo gives the per-symbol funding interval in milliseconds. Most are
 * 8h but some are 4h or 1h, and the rate must be normalised to 8h before
 * comparing across coins â€” otherwise a 4h coin looks twice as extreme.
 */
async function fundingIntervals(): Promise<Map<string, number>> {
  return cached('deriv:fundingInfo', REFRESH.DERIVATIVES_SNAPSHOT_MS, async () => {
    const res = await fetchJson<{ symbol: string; fundingIntervalHours: number }[]>(
      `${F}/fapi/v1/fundingInfo`,
      { label: 'binance fundingInfo', retries: 1 },
    );
    const m = new Map<string, number>();
    for (const r of res ?? []) {
      // The field is documented in hours on some builds and ms on others.
      const raw = Number(r.fundingIntervalHours);
      if (!Number.isFinite(raw) || raw <= 0) continue;
      m.set(r.symbol, raw > 100 ? raw / 3_600_000 : raw);
    }
    return m;
  });
}

/**
 * Binance renames rebased/rebased-style tokens on the perp book, so the perp
 * symbol is not always the spot symbol. PEPE is `PEPEUSDT` on spot but
 * `1000PEPEUSDT` on futures. `futuresSymbolCandidates` returns both so a
 * lookup never silently misses.
 */
export function futuresSymbolCandidates(base: string): string[] {
  const direct = `${base}USDT`;
  const candidates = [direct];
  if (/^(PEPE|FLOKI|BONK|SATS|HEI|RATS|LUNA|LUNC)/.test(base)) {
    candidates.push(`1000${direct}`);
  }
  return candidates;
}

export const binanceFutures: DerivativesProvider = {
  name: 'binance-futures',

  async snapshot(symbols) {
    if (!symbols.length) return [];
    const intervals = await fundingIntervals().catch(() => new Map<string, number>());
    const out: DerivRaw[] = [];

    // premiumIndex returns the mark for every perp in one call, but OI is
    // per-symbol. Pull premiumIndex once, then OI in small batches.
    const CONC = 8;
    const premium = await cached('deriv:premiumIndex', REFRESH.DERIVATIVES_SNAPSHOT_MS, async () => {
      const res = await fetchJson<
        { symbol: string; markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number }[]
      >(`${F}/fapi/v1/premiumIndex`, { label: 'binance premiumIndex', retries: 1 });
      return new Map((res ?? []).map((r) => [r.symbol, r]));
    });

    // Resolve each requested spot pair to the perp symbol that actually exists.
    const resolved = symbols.map((s) => {
      const candidates = futuresSymbolCandidates(s.replace(/USDT$/, ''));
      const found = candidates.find((c) => premium.has(c));
      return { requested: s, actual: found ?? null, candidates };
    });

    for (let i = 0; i < resolved.length; i += CONC) {
      const batch = resolved.slice(i, i + CONC);
      const results = await Promise.allSettled(
        batch.map(async ({ requested, actual }) => {
          if (!actual) return null;
          const p = premium.get(actual)!;
          const oi = await cached(
            `deriv:oi:${actual}`,
            REFRESH.DERIVATIVES_SNAPSHOT_MS,
            () =>
              fetchJson<{ openInterest: string; time: number }>(
                `${F}/fapi/v1/openInterest?symbol=${actual}`,
                { label: `oi ${actual}`, retries: 1 },
              ),
          );
          const oiNum = Number(oi.openInterest);
          const mark = Number(p.markPrice);
          if (!Number.isFinite(oiNum) || !Number.isFinite(mark)) return null;
          return {
            // Report under the REQUESTED symbol so it joins to the board row,
            // but keep the venue's own name for the UI to display.
            symbol: requested,
            venueSymbol: actual,
            markPrice: mark,
            indexPrice: Number(p.indexPrice),
            fundingRate: Number(p.lastFundingRate),
            fundingIntervalH: intervals.get(actual) ?? 8,
            nextFundingTime: Number(p.nextFundingTime) || 0,
            openInterest: oiNum,
          } satisfies DerivRaw;
        }),
      );
      for (const r of results) if (r.status === 'fulfilled' && r.value) out.push(r.value);
    }
    return out;
  },

  async oiHistory(symbol, period, limit) {
    const res = await cached(
      `deriv:oih:${symbol}:${period}:${limit}`,
      REFRESH.OI_HISTORY_MS,
      () =>
        fetchJson<{ timestamp: number; sumOpenInterest: string; sumOpenInterestValue: string }[]>(
          `${F}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${Math.min(limit, 500)}`,
          { label: `oiHist ${symbol}`, retries: 1 },
        ),
    );
    const arr = res ?? [];
    const points: OiPoint[] = arr.map((r) => ({
      t: Number(r.timestamp),
      oi: Number(r.sumOpenInterest),
      changePct: 0,
    }));
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1].oi;
      points[i].changePct = prev > 0 ? ((points[i].oi - prev) / prev) * 100 : 0;
    }
    return { symbol, points };
  },

  async longShort(symbol, period) {
    const [acc, top, taker] = await Promise.allSettled([
      cached(`deriv:ls:${symbol}`, REFRESH.LONG_SHORT_RATIO_MS, () =>
        fetchJson<{ timestamp: number; longShortRatio: string }[]>(
          `${F}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=30`,
          { label: `ls ${symbol}`, retries: 1 },
        )),
      cached(`deriv:lsTop:${symbol}`, REFRESH.LONG_SHORT_RATIO_MS, () =>
        fetchJson<{ timestamp: number; longShortRatio: string }[]>(
          `${F}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=${period}&limit=30`,
          { label: `lsTop ${symbol}`, retries: 1 }),
      ),
      cached(`deriv:taker:${symbol}`, REFRESH.LONG_SHORT_RATIO_MS, () =>
        fetchJson<{ timestamp: number; buySellRatio: string; buyVol: string; sellVol: string }[]>(
          `${F}/futures/data/takerlongshortRatio?symbol=${symbol}&period=${period}&limit=30`,
          { label: `taker ${symbol}`, retries: 1 },
        )),
    ]);

    const toLs = (v: unknown): LsPoint[] => {
      if (!Array.isArray(v)) return [];
      return (v as { timestamp: number; longShortRatio: string; buySellRatio: string }[]).map((r) => ({
        t: Number(r.timestamp),
        ratio: Number(r.longShortRatio ?? r.buySellRatio),
      }));
    };

    return {
      symbol,
      accountRatio: acc.status === 'fulfilled' ? toLs(acc.value) : [],
      topPositionRatio: top.status === 'fulfilled' ? toLs(top.value) : [],
      takerRatio: taker.status === 'fulfilled' ? toLs(taker.value) : [],
    };
  },
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Hyperliquid â€” cross-venue comparison. 234 perps in one call. [PROBED] OK
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface HyperRow {
  symbol: string;
  markPrice: number;
  funding8h: number;
  openInterest: number;
  volume24h: number;
}

export async function hyperliquidSnapshot(): Promise<HyperRow[]> {
  return cached('deriv:hyperliquid', RATE.HYPERLIQUID_MIN_INTERVAL_MS, postHyperliquid);
}

async function postHyperliquid(): Promise<HyperRow[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(NETWORK.HYPERLIQUID_INFO, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 OrderFlow',
      },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      signal: ac.signal,
    });
    if (!res.ok) return [];
    const json = (await res.json()) as [
      { universe: { name: string }[] },
      Record<string, { funding?: string; openInterest?: string; markPx?: string; dayNtlVlm?: string }>,
    ];
    const [meta, ctx] = json;
    const out: HyperRow[] = [];
    meta.universe.forEach((u, i) => {
      const c = ctx[i];
      if (!c) return;
      // Hyperliquid reports funding hourly; annualise-equivalent to 8h here.
      const hourly = Number(c.funding ?? 0);
      out.push({
        symbol: `${u.name}USDT`,
        markPrice: Number(c.markPx ?? 0),
        funding8h: hourly * 8,
        openInterest: Number(c.openInterest ?? 0),
        volume24h: Number(c.dayNtlVlm ?? 0),
      });
    });
    return out.filter((r) => Number.isFinite(r.markPrice) && r.markPrice > 0);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Bybit â€” cross-venue comparison. [PROBED] OK
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function bybitSnapshot(symbols: string[]): Promise<Map<string, { funding8h: number; oiUsd: number }>> {
  return cached('deriv:bybit', RATE.BYBIT_MIN_INTERVAL_MS, async () => {
    const m = new Map<string, { funding8h: number; oiUsd: number }>();
    const res = await fetchJson<{
      result: { list: { symbol: string; fundingRate: string; openInterest: string; openInterestValue: string; nextFundingTime: string }[] };
    }>(`${NETWORK.BYBIT_HOST}/v5/market/tickers?category=linear`, {
      label: 'bybit tickers',
      retries: 1,
      timeoutMs: 20_000,
    }).catch(() => null);
    if (!res?.result?.list) return m;
    // Bybit funding is per 8h on linear perps.
    for (const t of res.result.list) {
      m.set(t.symbol, {
        funding8h: Number(t.fundingRate) || 0,
        oiUsd: Number(t.openInterestValue) || 0,
      });
    }
    void symbols;
    return m;
  });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Deribit â€” BTC and ETH options only. [PROBED] OK
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface DeribitOptionData {
  dvol: number | null;
  dvolHistory: { t: number; value: number }[];
  putCallOiRatio: number | null;
  maxPain: { expiry: string; price: number; distancePct: number } | null;
  expiries: { name: string; expiryUtc: number; isNearest: boolean }[];
}

export async function deribitOptions(
  currency: 'BTC' | 'ETH',
  spot: number,
): Promise<DeribitOptionData> {
  return cached(`deriv:deribit:${currency}`, REFRESH.OPTIONS_MS, async () => {
    // DVOL comes from get_volatility_index_data. get_index_price?index_name=btc_dvol
    // is NOT a valid index and returns 400 â€” probed in Phase 0.
    const volPromise = fetchJson<{
      result: { data: [number, number, number, number, number][]; continuation: number | null };
    }>(
      `${NETWORK.DERIBIT_HOST}/api/v2/public/get_volatility_index_data?currency=${currency}&resolution=3600&start_timestamp=${Date.now() - 30 * 86400_000}&end_timestamp=${Date.now()}`,
      { label: `deribit dvol ${currency}`, retries: 1, timeoutMs: 20_000 },
    ).catch(() => null);

    const bookPromise = fetchJson<{
      result: { instrument_name: string; open_interest?: number; mark_iv?: number }[];
    }>(
      `${NETWORK.DERIBIT_HOST}/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`,
      { label: `deribit book ${currency}`, retries: 1, timeoutMs: 20_000 },
    ).catch(() => null);

    const [vol, book] = await Promise.all([volPromise, bookPromise]);

    const dvolHistory = (vol?.result?.data ?? []).map((r) => ({ t: r[0], value: r[4] }));
    const dvol = dvolHistory.length ? dvolHistory[dvolHistory.length - 1].value : null;

    let putCallOiRatio: number | null = null;
    const expiries: DeribitOptionData['expiries'] = [];
    if (book?.result?.length) {
      let putOi = 0;
      let callOi = 0;
      const seen = new Map<string, number>();
      for (const r of book.result) {
        const m = /-(\d{1,2}[A-Z]{3}\d{2})$/.exec(r.instrument_name);
        if (!m) continue;
        const oi = Number(r.open_interest ?? 0);
        if (/-P-/.test(r.instrument_name)) putOi += oi;
        else if (/-C-/.test(r.instrument_name)) callOi += oi;
        const ts = seen.get(m[1]);
        if (ts === undefined) {
          // Deribit expiry stamps are UTC ms; settle at 08:00 UTC = 13:30 IST.
          const expiry = Date.UTC(
            2000 + Number(m[1].slice(-2)),
            ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(m[1].slice(0, 3)),
            Number(m[1].slice(4, 6)),
            DERIVATIVES.DERIBIT_SETTLE_UTC_H,
          );
          seen.set(m[1], expiry);
        }
      }
      for (const [name, expiryUtc] of seen) {
        expiries.push({ name, expiryUtc, isNearest: false });
      }
      expiries.sort((a, b) => a.expiryUtc - b.expiryUtc);
      expiries.forEach((e, i) => {
        e.isNearest = i === 0;
      });
      if (putOi + callOi > 0) putCallOiRatio = putOi / (putOi + callOi);
    }

    let maxPain: DeribitOptionData['maxPain'] = null;
    if (expiries.length && spot > 0) {
      try {
        const pain = await maxPainFor(expiries[0].name, spot);
        maxPain = pain;
      } catch {
        maxPain = null;
      }
    }

    return { dvol, dvolHistory, putCallOiRatio, maxPain, expiries };
  });
}

/**
 * Max pain by OI: the strike at which total option-holder payout is smallest.
 * Computed from the public book summary, so no paid endpoint is needed.
 */
async function maxPainFor(instrument: string, spot: number): Promise<{ expiry: string; price: number; distancePct: number } | null> {
  const book = await fetchJson<{
    result: { instrument_name: string; open_interest?: number; strike?: number }[];
  }>(
    `${NETWORK.DERIBIT_HOST}/api/v2/public/get_book_summary_by_currency?currency=${instrument.slice(0, 3)}&kind=option`,
    { label: `deribit maxpain ${instrument}`, retries: 1, timeoutMs: 20_000 },
  ).catch(() => null);
  if (!book?.result?.length) return null;

  const byStrike = new Map<number, { call: number; put: number }>();
  for (const r of book.result) {
    if (!r.instrument_name.startsWith(instrument)) continue;
    const strike = Number(r.strike);
    if (!Number.isFinite(strike)) continue;
    const oi = Number(r.open_interest ?? 0);
    const e = byStrike.get(strike) ?? { call: 0, put: 0 };
    if (/-C-/.test(r.instrument_name)) e.call += oi;
    else e.put += oi;
    byStrike.set(strike, e);
  }
  if (!byStrike.size) return null;

  const strikes = [...byStrike.keys()].sort((a, b) => a - b);
  let best = strikes[0];
  let bestPain = Infinity;
  for (const settle of strikes) {
    let pain = 0;
    for (const s of strikes) {
      const e = byStrike.get(s)!;
      if (s < settle) pain += e.call * (settle - s);
      else pain += e.put * (s - settle);
    }
    if (pain < bestPain) {
      bestPain = pain;
      best = settle;
    }
  }
  return {
    expiry: instrument,
    price: best,
    distancePct: ((best - spot) / spot) * 100,
  };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Spot order book depth
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function spotDepth(symbol: string): Promise<{
  bidUsd: number; askUsd: number; imbalance: number; spreadBps: number;
  walls: { price: number; usd: number; side: 'bid' | 'ask' }[];
  distanceToPriceBps: number; asOf: number; meta: Meta;
} | null> {
  return cached(`deriv:depth:${symbol}`, 60_000, async () => {
    const res = await fetchJson<{ bids: [string, string][]; asks: [string, string][] }>(
      `${NETWORK.BINANCE_SPOT_HOST}/api/v3/depth?symbol=${symbol}&limit=${DERIVATIVES.DEPTH_LIMIT}`,
      { label: `depth ${symbol}`, retries: 1 },
    ).catch(() => null);
    if (!res?.bids?.length || !res?.asks?.length) return null;

    const levels: { price: number; usd: number; side: 'bid' | 'ask' }[] = [
      ...res.bids.map(([p, q]) => ({ price: Number(p), usd: Number(p) * Number(q), side: 'bid' as const })),
      ...res.asks.map(([p, q]) => ({ price: Number(p), usd: Number(p) * Number(q), side: 'ask' as const })),
    ];
    const mean = levels.reduce((a, l) => a + l.usd, 0) / levels.length;
    const walls = levels
      .filter((l) => l.usd >= mean * DERIVATIVES.WALL_MULTIPLE)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 4);

    const bidUsd = res.bids.reduce((a, [p, q]) => a + Number(p) * Number(q), 0);
    const askUsd = res.asks.reduce((a, [p, q]) => a + Number(p) * Number(q), 0);
    const bestBid = Number(res.bids[0][0]);
    const bestAsk = Number(res.asks[0][0]);
    const mid = (bestBid + bestAsk) / 2;

    return {
      bidUsd, askUsd,
      imbalance: bidUsd + askUsd > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0,
      spreadBps: mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0,
      walls,
      distanceToPriceBps: 0,
      asOf: Date.now(),
      meta: { asOf: Date.now(), source: 'binance-spot-depth', stale: false },
    };
  });
}

export { fetchText };
