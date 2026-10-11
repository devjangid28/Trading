import { fetchJson } from '../lib/http.js';
import { cached } from '../lib/cache.js';
import { istDateKey, parseIstDateKey, sessionState, MINUTE } from '../lib/time.js';
import { FNO_UNIVERSE, yahooChartCached } from './yahoo.js';
import { averageRange, detectOrderBlock, strengthScore } from '../engine/orderblock.js';
import type { Candle, IndianMarket, Side } from '../../../shared/types.js';

const NSE_HEADERS = {
  Referer: 'https://www.nseindia.com/',
  Accept: 'application/json,text/plain,*/*',
  Origin: 'https://www.nseindia.com',
};

/** Only these NSE endpoints survive a non-browser request; the rest are WAF-blocked. */
export async function nseAllIndices() {
  return cached('nse:allIndices', 5 * 60_000, async () => {
    const res = await fetchJson<{
      data: {
        index: string;
        last: number;
        percentChange: number;
        yearHigh?: number;
        yearLow?: number;
      }[];
    }>('https://www.nseindia.com/api/allIndices', { label: 'nse allIndices', headers: NSE_HEADERS, retries: 1 });
    return res.data ?? [];
  });
}

export async function nseMarketStatus() {
  return cached('nse:marketStatus', 2 * 60_000, async () => {
    const res = await fetchJson<{
      marketState?: {
        market: string;
        marketStatus: string;
        tradeDate: string;
        index: string;
        last: number;
        percentChange: number | string;
        marketStatusMessage?: string;
      }[];
    }>('https://www.nseindia.com/api/marketStatus', { label: 'nse marketStatus', headers: NSE_HEADERS, retries: 1 });
    return res;
  });
}

export interface NseHoliday {
  tradingDate: string;
  weekDay: string;
  description: string;
  morning_session: string | null;
  evening_session: string | null;
}

/**
 * NSE holiday calendar. The F&O segment bucket is "FO", not "FNO" â€” the wrong
 * key throws immediately, which is the single easiest mistake with this API.
 */
export async function nseHolidays(): Promise<Record<string, NseHoliday[]>> {
  return cached('nse:holidays', 24 * 60 * 60_000, async () => {
    const res = await fetchJson<Record<string, NseHoliday[]>>(
      'https://www.nseindia.com/api/holiday-master?type=trading',
      { label: 'nse holidays', headers: NSE_HEADERS, retries: 1 },
    );
    return res ?? {};
  });
}

const FOCUS_INDICES = [
  'NIFTY 50',
  'NIFTY BANK',
  'NIFTY FINANCIAL SERVICES',
  'NIFTY IT',
  'NIFTY MIDCAP 100',
  'INDIA VIX',
  'NIFTY NEXT 50',
];

export async function indianMarket(): Promise<IndianMarket> {
  const now = Date.now();
  const session = sessionState('fnf', now);

  const [indicesRaw, statusRaw, holidays] = await Promise.all([
    nseAllIndices().catch(() => []),
    nseMarketStatus().catch(() => ({ marketState: [] })),
    nseHolidays().catch(() => ({} as Record<string, NseHoliday[]>)),
  ]);

  const cmState = statusRaw.marketState?.find((m) => m.market === 'Capital Market');
  const today = istDateKey(now);
  const foHolidays = holidays.FO ?? holidays.CM ?? [];
  const holidayToday = foHolidays.find((h) => h.tradingDate === today)?.description ?? null;

  const upcoming = foHolidays
    .map((h) => ({ ts: parseIstDateKey(h.tradingDate), h }))
    .filter((x): x is { ts: number; h: NseHoliday } => x.ts !== null && x.ts >= now)
    .sort((a, b) => a.ts - b.ts);

  const indices = indicesRaw
    .filter((i) => FOCUS_INDICES.includes(i.index))
    .map((i) => ({
      name: i.index,
      last: i.last,
      change: Math.round((i.percentChange / 100) * i.last * 100) / 100,
      percentChange: i.percentChange,
      yearHigh: i.yearHigh ?? null,
      yearLow: i.yearLow ?? null,
    }));

  // Run the same order-block engine over the Indian F&O universe.
  const CONC = 5;
  const fno: IndianMarket['fno'] = [];
  let fnoError: IndianMarket['unavailable'] = null;
  for (let i = 0; i < FNO_UNIVERSE.length; i += CONC) {
    const batch = FNO_UNIVERSE.slice(i, i + CONC);
    const results = await Promise.allSettled(
      batch.map(async (u) => {
        const chart = await yahooChartCached(u.yahoo, '5m', '1d', 60_000);
        if (!chart || chart.candles.length < 40) return null;
        const candles: Candle[] = chart.candles;
        const closed = candles.filter((c) => c.closed);
        const last = candles[candles.length - 1];
        const prev = closed[closed.length - 2] ?? last;

        const changePct = prev.c > 0 ? ((last.c - prev.c) / prev.c) * 100 : 0;
        const dayHigh = Math.max(...closed.slice(-48).map((c) => c.h), last.h);
        const dayLow = Math.min(...closed.slice(-48).map((c) => c.l), last.l);
        const rangePct = dayLow > 0 ? ((dayHigh - dayLow) / last.c) * 100 : 0;

        const setup = detectOrderBlock(candles, { range: averageRange(closed, 20) });
        void setup;

        return {
          symbol: u.nse,
          name: u.name,
          sector: u.sector,
          price: Math.round(last.c * 100) / 100,
          changePct: Math.round(changePct * 100) / 100,
          strength: strengthScore(changePct, rangePct),
          side: (changePct >= 0 ? 'bullish' : 'bearish') as Side,
          spark: candles.slice(-80).map((c) => c.c),
        };
      }),
    );

    results.forEach((r) => {
      if (r.status === 'fulfilled' && r.value) {
        fno.push(r.value);
      } else if (!fnoError) {
        fnoError = {
          available: false,
          reason: 'Yahoo Finance chart API is unreachable or rate-limited. The crypto terminal is unaffected.',
          lastGoodAt: null,
        };
      }
    });
  }

  fno.sort((a, b) => b.strength - a.strength);

  return {
    updatedAt: now,
    session: {
      state: cmState?.marketStatus ?? (session.state === 'open' ? 'Open' : session.state === 'pre' ? 'Pre Open' : 'Close'),
      tradeDate: cmState?.tradeDate ?? '',
      message: holidayToday
        ? `Market holiday â€” ${holidayToday}`
        : cmState?.marketStatusMessage ?? (session.state === 'open' ? 'Market is open' : 'Market is closed'),
    },
    open: session.state === 'open' && !holidayToday,
    holidayToday,
    nextHoliday: upcoming.length
      ? { date: upcoming[0].h.tradingDate, description: upcoming[0].h.description }
      : null,
    indices,
    fno,
    unavailable: fnoError,
  };
}

export { MINUTE };
