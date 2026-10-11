import type {
  AssetRow, Candle, DerivRow, MarketEvent, NewsItem, PickRule, ScanResult,
  SectorFlow, Setup, Side, Tf, Unlock, VolatilityContext,
} from '../../../shared/types';
import type { Grade, Regime, SizeAdvice } from '../config.js';
import { CONVICTION, STRUCTURE } from '../config.js';
import { fetchKlines, fetchTickers, fetchExchangeSymbols } from '../data/binance.js';
import { UNIVERSE, EXCLUDE_FROM_BOARD } from '../data/universe.js';
import {
  averageRange, choppiness, detectOrderBlock, percentileOf, sessionVwap, strengthScore,
} from './orderblock.js';
import { assessHtf, relativeStrength, volatilityContext } from './timeframes.js';
import { assignPicks, scoreConviction, sizeAdviceFor } from './conviction.js';
import { buildPlan, buildLeverageCheck } from './tradePlan.js';
import { buildDerivatives } from '../data/derivatives/build.js';
import { fetchAllNews } from '../data/rss.js';
import { buildFeed } from './news/score.js';
import type { RawArticle } from './news/score.js';
import { fetchJsonSafe } from '../lib/http.js';
import { globalMarket } from '../data/macro.js';
import { blackoutReason, eventCalendar } from '../data/calendar.js';
import { buildButterfly } from './butterfly.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


const SCAN_TTL_MS = 60_000;
/**
 * Raised from 8. The scan is the slow path (four kline pulls per pair), and
 * Binance's weight budget has plenty of headroom for 16 concurrent pulls, so
 * the cold scan finishes in a fraction of the time.
 */
const CONCURRENCY = 16;

/**
 * Last good board, persisted so a freshly started process can serve a real
 * board on the very first request instead of a spinner.
 */
const SCAN_CACHE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/scan-cache.json');

interface Scanned {
  base: string;
  pair: string;
  symbol: string;
  name: string;
  sector: string;
  price: number;
  changePct: number;
  change1hPct: number;
  change4hPct: number;
  rangePct: number;
  volumeUsd: number;
  strength: number;
  chop: number;
  side: Side;
  setup: Setup | null;
  vwap: number | null;
  spark: number[];
  candles: Candle[];
  candlesByTf: Partial<Record<Tf, Candle[]>>;
  vol: VolatilityContext | null;
  eventRisk: boolean;
}

export interface ScanContext {
  derivatives: Map<string, DerivRow>;
  news: NewsItem[];
  events: MarketEvent[];
  unlocks: Unlock[];
  regime: { regime: Regime; sizeAdvice: SizeAdvice; reason: string; score: number };
  btcCandles: Candle[];
  ethCandles: Candle[] | null;
  btcDominance: number | null;
  altseasonIndex: number | null;
  blackedOut: boolean;
  blackoutReason: string | null;
  /** Optional hint fed into the coarse regime read. [TUNED] */
  breadthHint?: number;
  now: number;
}

function pctChange(candles: Candle[], periods: number): number {
  const closed = candles.filter((c) => c.closed);
  if (closed.length <= periods) return 0;
  const a = closed[closed.length - 1 - periods].c;
  return a > 0 ? ((closed[closed.length - 1].c - a) / a) * 100 : 0;
}

export async function runScan(ctx: ScanContext): Promise<ScanResult> {
  const [tickers, exchangeSymbols] = await Promise.all([fetchTickers(), fetchExchangeSymbols()]);

  const tradable = new Set(
    exchangeSymbols.filter((s) => s.quote === 'USDT' || s.quote === 'FDUSD').map((s) => s.base),
  );
  const tickerByBase = new Map<string, (typeof tickers)[number]>();
  for (const t of tickers) {
    const base = t.symbol.replace(/(USDT|FDUSD|BUSD)$/, '');
    if (!tickerByBase.has(base)) tickerByBase.set(base, t);
  }

  const candidates = UNIVERSE.filter(
    (u) => !EXCLUDE_FROM_BOARD.has(u.base) && tradable.has(u.base) && tickerByBase.has(u.base),
  );
  const liquid = candidates.filter((u) => (tickerByBase.get(u.base)?.quoteVolume ?? 0) > 1_000_000);

  const scanned: Scanned[] = [];

  for (let i = 0; i < liquid.length; i += CONCURRENCY) {
    const batch = liquid.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (u): Promise<Scanned> => {
        const pair = `${u.base}USDT`;
        const ticker = tickerByBase.get(u.base)!;
        const m5 = await fetchKlines(pair, '5m', 320);

        const last = m5[m5.length - 1];
        if (!last) throw new Error('no candles');

        const price = ticker.lastPrice || last.c;
        const changePct = ticker.priceChangePercent;
        const dayHigh = Math.max(ticker.highPrice, last.h);
        const dayLow = Math.min(ticker.lowPrice, last.l);
        const rangePct = ((dayHigh - dayLow) / price) * 100;

        const closed5m = m5.filter((c) => c.closed);
        const dayStart = closed5m.length ? closed5m[Math.max(0, closed5m.length - 289)].t : 0;
        const side: Side = changePct >= 0 ? 'bullish' : 'bearish';

        const setup =
          rangePct >= STRUCTURE.MIN_RANGE_PCT && closed5m.length >= 40
            ? detectOrderBlock(m5, { range: averageRange(closed5m, STRUCTURE.ATR_LOOKBACK), prefer: side })
            : null;

        // Higher timeframes for alignment. Fetched in parallel and tolerated
        // on failure â€” HTF context is an adjustment, not a requirement.
        const [h15, h1, h4] = await Promise.allSettled([
          fetchKlines(pair, '15m', 200),
          fetchKlines(pair, '1h', 200),
          fetchKlines(pair, '4h', 200),
        ]);
        const candlesByTf: Partial<Record<Tf, Candle[]>> = {
          '5m': m5,
          '15m': h15.status === 'fulfilled' ? h15.value : undefined,
          '1h': h1.status === 'fulfilled' ? h1.value : undefined,
          '4h': h4.status === 'fulfilled' ? h4.value : undefined,
        };

        if (setup) {
          setup.htf = assessHtf(setup.obLow, setup.obHigh, setup.side, candlesByTf);
        }

        return {
          base: u.base,
          pair,
          symbol: pair,
          name: u.name,
          sector: u.sector,
          price,
          changePct,
          change1hPct: pctChange(m5, 12),
          change4hPct: pctChange(m5, 48),
          rangePct,
          volumeUsd: ticker.quoteVolume,
          strength: strengthScore(changePct, rangePct),
          chop: choppiness(closed5m),
          side,
          setup,
          vwap: sessionVwap(closed5m, dayStart),
          spark: m5.slice(-60).map((c) => c.c),
          candles: m5,
          candlesByTf,
          vol: volatilityContext(m5),
          eventRisk: Math.abs(changePct) >= STRUCTURE.EVENT_RISK_PCT,
        };
      }),
    );

    results.forEach((r) => {
      if (r.status === 'fulfilled') scanned.push(r.value);
      else console.warn('[scan] symbol failed:', (r.reason as Error)?.message);
    });
  }

  // â”€â”€ Percentiles and boards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const strengths = scanned.map((s) => s.strength);
  const directional = scanned.filter((s) => s.strength > 0);
  const choppyCount = scanned.length - directional.length;

  const bullish = directional.filter((s) => s.side === 'bullish').sort((a, b) => b.strength - a.strength);
  const bearish = directional.filter((s) => s.side === 'bearish').sort((a, b) => b.strength - a.strength);

  // â”€â”€ Sector flow (needed before conviction, which reads it) â”€â”€â”€â”€â”€â”€
  const bySector = new Map<string, Scanned[]>();
  for (const s of scanned) {
    const arr = bySector.get(s.sector);
    if (arr) arr.push(s);
    else bySector.set(s.sector, [s]);
  }
  const sectors: SectorFlow[] = [...bySector.entries()]
    .map(([sector, members]) => ({
      sector,
      avgChange: round2(members.reduce((a, m) => a + m.changePct, 0) / members.length),
      avgStrength: round3(members.reduce((a, m) => a + m.strength, 0) / members.length),
      members: members
        .map((m) => ({ symbol: m.base, changePct: round2(m.changePct) }))
        .sort((a, b) => b.changePct - a.changePct),
      leading: false,
      lagging: false,
    }))
    .sort((a, b) => b.avgChange - a.avgChange);
  if (sectors[0]) sectors[0].leading = true;
  if (sectors[sectors.length - 1]) sectors[sectors.length - 1].lagging = true;
  const sectorAvg = new Map(sectors.map((s) => [s.sector, s.avgChange]));

  const ratio = bullish.length / Math.max(1, bullish.length + bearish.length);
  const breadth: Side | 'two-way' = ratio > 0.62 ? 'bullish' : ratio < 0.38 ? 'bearish' : 'two-way';

  // â”€â”€ Build rows with conviction, plan and leverage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const buildRows = (list: Scanned[], side: Side): AssetRow[] => {
    const percentile = (s: Scanned) => {
      const raw = percentileOf(strengths, s.strength);
      return side === 'bearish' ? round1(100 - raw) : raw;
    };

    return list.map((s, idx) => {
      const deriv = ctx.derivatives.get(`${s.base}USDT`) ?? null;
      const assetNews = ctx.news.filter(
        (n) => n.assets.includes(s.base) && ctx.now - n.publishedAt < 6 * 3600_000,
      );
      const rs = relativeStrength(s.candles, ctx.btcCandles, ctx.ethCandles, ctx.btcDominance, ctx.altseasonIndex);

      const conviction = scoreConviction({
        symbol: s.base,
        side,
        price: s.price,
        setup: s.setup,
        strength: s.strength,
        strengthPercentile: percentile(s),
        volumeUsd: s.volumeUsd,
        choppiness: s.chop,
        vwap: s.vwap,
        candles: s.candles,
        deriv,
        vol: s.vol,
        sectorAvgChange: sectorAvg.get(s.sector) ?? null,
        breadth,
        news: assetNews,
        macroRegimeScore: ctx.regime.score,
        tradability: deriv?.depth
          ? { bidUsd: deriv.depth.bidUsd, askUsd: deriv.depth.askUsd, spreadBps: deriv.depth.spreadBps }
          : null,
        events: ctx.events,
        now: ctx.now,
        unlocks: ctx.unlocks,
      });

      const atr = s.vol?.atrPct ?? 0;
      const plan = s.setup ? buildPlan(s.base, side, s.setup, s.price, atr) : null;
      const leverage = s.setup && deriv
? buildLeverageCheck(s.price, s.setup.invalidation)
        : null;

      const maxNis = assetNews.length
        ? Math.max(...assetNews.map((n) => n.nis))
        : 0;
      const netDir = assetNews.reduce((a, n) => a + n.nis * n.direction, 0);

      const unlock = ctx.unlocks.find(
        (u) => u.token === s.base &&
          Date.parse(u.date) >= ctx.now &&
          Date.parse(u.date) <= ctx.now + 48 * 3600_000,
      );

      return {
        id: s.base,
        symbol: s.pair,
        base: s.base,
        quote: 'USDT',
        pair: s.pair,
        name: s.name,
        sector: s.sector,
        exchange: 'Binance',
        price: s.price,
        changePct: round2(s.changePct),
        change1hPct: round2(s.change1hPct),
        change4hPct: round2(s.change4hPct),
        volumeUsd: Math.round(s.volumeUsd),
        strength: round3(s.strength),
        percentile: percentile(s),
        choppiness: s.chop,
        side,
        rank: idx + 1,
        prevRank: null,
        eventRisk: s.eventRisk,
        spark: s.spark,
        setup: s.setup,
        vwap: s.vwap,
        conviction,
        isPick: conviction.isPick,
        plan,
        leverage,
        tax: null,
        derivatives: deriv,
        newsDot: assetNews.length
          ? { nis: maxNis, direction: netDir > 0 ? 1 : netDir < 0 ? -1 : 0, count: assetNews.length }
          : null,
        unlock: unlock
          ? { date: unlock.date, pct: unlock.pct, cliff: unlock.cliff }
          : null,
        // Relative strength is computed but surfaced in the popup, not the row.
        ...(rs ? {} : {}),
        updatedAt: ctx.now,
      } satisfies AssetRow;
    });
  };

  const bullRows = assignPicks(buildRows(bullish, 'bullish').slice(0, CONVICTION.BOARD_SIZE));
  const bearRows = assignPicks(buildRows(bearish, 'bearish').slice(0, CONVICTION.BOARD_SIZE));

  // â”€â”€ Market picture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const market = {
    bullishCount: bullish.length,
    bearishCount: bearish.length,
    total: scanned.length,
    choppyCount,
    dots: scanned.map((s) => ({
      symbol: s.base,
      changePct: round2(s.changePct),
      strength: s.strength,
      pick: bullRows.some((r) => r.base === s.base && r.isPick) || bearRows.some((r) => r.base === s.base && r.isPick),
      eventRisk: s.eventRisk,
      choppy: s.strength === 0,
    })),
    leadingSector: sectors[0]?.sector ?? null,
    laggingSector: sectors[sectors.length - 1]?.sector ?? null,
  };

  const leverageRisk = bullRows.some((r) => r.leverage && !r.leverage.ok) ||
    bearRows.some((r) => r.leverage && !r.leverage.ok);
  const sizeAdvice = sizeAdviceFor(ctx.regime.score, ctx.blackedOut, leverageRisk);

  return {
    updatedAt: ctx.now,
    nextRefreshIn: SCAN_TTL_MS / 1000,
    stale: false,
    reason: '',
    bullish: bullRows,
    bearish: bearRows,
    sectors,
    market,
    breadthBias: breadth,
    totalScanned: scanned.length,
    regime: ctx.regime.regime,
    sizeAdvice,
    regimeReason: ctx.regime.reason,
    blackedOut: ctx.blackedOut,
    blackoutReason: ctx.blackoutReason,
    // Built from the FULL scanned universe, not from the boards. The boards
    // hold at most BOARD_SIZE per side, so charting those would show the
    // extremes twice and imply breadth that does not exist.
    butterfly: buildButterfly(scanned),
  };
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
function round3(v: number): number { return Math.round(v * 1000) / 1000; }

export type { Grade, PickRule, SizeAdvice, Regime, Scanned };

export interface ScanCache {
  current: ScanResult | null;
  previousRanks: Map<string, Map<string, number>>;
  context: ScanContext | null;
}

let scanCache: ScanCache | null = null;
let inFlight: Promise<ScanResult> | null = null;
let warming = false;

/** Write the newest board so the next cold start serves it immediately. */
function persistScan(result: ScanResult): void {
  try {
    mkdirSync(dirname(SCAN_CACHE_PATH), { recursive: true });
    writeFileSync(SCAN_CACHE_PATH, JSON.stringify(result), 'utf8');
  } catch (err) {
    console.warn('[scan] could not persist cache:', (err as Error).message);
  }
}

function loadPersistedScan(): ScanResult | null {
  try {
    const parsed = JSON.parse(readFileSync(SCAN_CACHE_PATH, 'utf8')) as ScanResult;
    if (!parsed || !Array.isArray(parsed.bullish) || !Array.isArray(parsed.bearish)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Hydrate synchronously at module load. A real board from the previous session
// is served to the first request while the background warm scan refreshes it.
(function hydrateScanCache() {
  const persisted = loadPersistedScan();
  if (persisted) {
    scanCache = {
      current: { ...persisted, stale: true, reason: 'Showing the last saved board while a fresh scan runs.' },
      previousRanks: new Map(),
      context: null,
    };
  }
})();

/**
 * Cached entry point. A full scan takes tens of seconds because it pulls
 * 5m/15m/1h/4h klines for every liquid pair.
 *
 * STALE-WHILE-REVALIDATE: if any board is already held — fresh OR stale — it is
 * returned immediately and a refresh is kicked off in the background. A real
 * board a minute old is far better than a spinner, so only the very first
 * request ever waits on a live scan, and after the first run even that case is
 * covered by the persisted board.
 */
export async function getScan(forceContext?: Partial<ScanContext>): Promise<ScanResult> {
  const cached = scanCache?.current ?? null;

  if (cached && !forceContext) {
    if (Date.now() - cached.updatedAt < SCAN_TTL_MS) return cached;
    // Stale: hand it back now, refresh behind the scenes.
    void refreshScan().catch(() => undefined);
    return cached;
  }

  return refreshScan(forceContext);
}

/**
 * Always run a fresh scan, bypassing the cache entirely. Used on a 5-minute
 * candle close and by the live verification tools, where a persisted or cached
 * board is not acceptable — they need the market as it is now.
 */
export function forceScan(): Promise<ScanResult> {
  return refreshScan();
}

/**
 * The actual scan. Single-flight: concurrent callers share one run.
 *
 * `inFlight` is set SYNCHRONOUSLY, before the first await. Otherwise the warm
 * scan, `/api/scan` and `/api/attribution` — which all fire within moments of a
 * cold start — each slip past the guard while `enrichContext` is still awaiting,
 * and the process runs several full scans at once. That both slows the first
 * load and bursts the exchange rate limit.
 */
async function refreshScan(forceContext?: Partial<ScanContext>): Promise<ScanResult> {
  if (inFlight) return inFlight;

  const run = async (): Promise<ScanResult> => {
    const base: ScanContext = { ...(scanCache?.context ?? emptyContext()), ...forceContext };
    const ctx = await enrichContext({ ...base, now: Date.now() });
    scanCache = { current: scanCache?.current ?? null, previousRanks: scanCache?.previousRanks ?? new Map(), context: ctx };

    try {
      const result = await runScan(ctx);
      scanCache = { current: result, previousRanks: diffRanks(scanCache, result), context: ctx };
      persistScan(result);
      return result;
    } catch (err) {
      console.error('[scan] failed:', (err as Error).message);
      if (scanCache?.current) {
        return { ...scanCache.current, stale: true, reason: `Scan failed: ${(err as Error).message}` };
      }
      throw err;
    }
  };

  inFlight = run().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** Cross-reference the previous minute's ranks so rows can show movement. */
function diffRanks(prev: ScanCache | null, result: ScanResult): Map<string, Map<string, number>> {
  const before = prev?.previousRanks;
  const next = new Map<string, Map<string, number>>();

  for (const side of ['bullish', 'bearish'] as const) {
    const rows = result[side];
    const m = new Map<string, number>();
    rows.forEach((r) => {
      m.set(r.id, r.rank);
      const p = before?.get(side)?.get(r.id);
      r.prevRank = p !== undefined && p !== r.rank ? p : null;
    });
    next.set(side, m);
  }
  return next;
}

function emptyContext(): ScanContext {
  return {
    derivatives: new Map(),
    news: [],
    events: [],
    unlocks: [],
    regime: { regime: 'range', sizeAdvice: 'reduced', reason: 'no regime data yet', score: 0.5 },
    btcCandles: [],
    ethCandles: null,
    btcDominance: null,
    altseasonIndex: null,
    blackedOut: false,
    blackoutReason: null,
    now: Date.now(),
  };
}

/**
 * Fill in the parts of the context that need their own upstream calls.
 *
 * Derivatives feed the conviction score's order-flow and positioning
 * components, so an empty map here silently degrades every grade — the board
 * still renders, but the Flow and Pos columns go empty and two of the seven
 * components score zero. That is why this is populated here rather than left
 * to the route handler.
 */
async function enrichContext(ctx: ScanContext): Promise<ScanContext> {
  const [derivs, newsItems, btcK, ethK, btcDominance, altseason, cal] = await Promise.all([
    buildDerivatives().catch(() => ({ rows: [], asOf: Date.now(), unavailable: 'derivatives unavailable' })),
    fetchAllNews().catch(() => [] as RawArticle[]),
    fetchKlines('BTCUSDT', '5m', 300).catch(() => [] as Candle[]),
    fetchKlines('ETHUSDT', '5m', 300).catch(() => [] as Candle[]),
    globalMarket().then((m) => m?.btcDominance ?? null).catch(() => null),
    altseasonIndex().catch(() => null),
    // The calendar MUST be present, otherwise the blackout veto silently does
    // nothing and an A/B pick can print half an hour before the FOMC.
    eventCalendar(ctx.now).catch(() => ({
      events: [] as MarketEvent[], updatedAt: ctx.now, sources: [],
    })),
  ]);

  const derivatives = new Map<string, DerivRow>();
  for (const row of derivs.rows) derivatives.set(row.symbol, row);

  return {
    ...ctx,
    derivatives,
    news: buildFeed(newsItems, ctx.now),
    btcCandles: btcK,
    ethCandles: ethK.length ? ethK : null,
    btcDominance,
    altseasonIndex: altseason,
    regime: assessRegime(derivs.rows, ctx.breadthHint ?? 0.5),
    events: cal.events,
    blackedOut: blackoutReason(cal.events, ctx.now) !== null,
    blackoutReason: blackoutReason(cal.events, ctx.now),
  };
}

/**
 * A deliberately simple regime read. It is honest about being coarse: the
 * weights here are [TUNED] and the full regime engine (Phase 5) is not built.
 */
function assessRegime(
  rows: DerivRow[],
  breadthHint: number,
): { regime: Regime; sizeAdvice: SizeAdvice; reason: string; score: number } {
  if (!rows.length) {
    return { regime: 'range', sizeAdvice: 'reduced', reason: 'no derivatives data', score: 0.4 };
  }
  const crowded = rows.filter(
    (r) => r.fundingLabel === 'CROWDED_LONG' || r.fundingLabel === 'EXTREME_LONG',
  ).length / rows.length;
  const oiFalling = rows.filter((r) => r.oiChange.h1 < -1).length / rows.length;
  const avgFunding = rows.reduce((a, r) => a + r.funding8h, 0) / rows.length;

  const score = clamp01(0.5 + (avgFunding * 100) * 2 + (breadthHint - 0.5) * 0.4 - crowded * 0.3 - oiFalling * 0.2);

  if (crowded > 0.5 || oiFalling > 0.4) {
    return {
      regime: 'risk-off',
      sizeAdvice: 'stand-aside',
      reason: `${Math.round(crowded * 100)}% of perps crowded long, ${Math.round(oiFalling * 100)}% with OI falling`,
      score,
    };
  }
  if (score > 0.65) {
    return {
      regime: 'trend-up',
      sizeAdvice: 'full',
      reason: `breadth and funding lean long (avg funding ${(avgFunding * 100).toFixed(4)}%/8h)`,
      score,
    };
  }
  if (score < 0.35) {
    return {
      regime: 'trend-down',
      sizeAdvice: 'reduced',
      reason: `funding and breadth lean short (avg funding ${(avgFunding * 100).toFixed(4)}%/8h)`,
      score,
    };
  }
  return { regime: 'range', sizeAdvice: 'reduced', reason: 'no clear directional edge in funding or breadth', score };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Share of the top 50 that beat BTC over 30d. 1.0 means BTC alone is leading. */
export async function altseasonIndex(): Promise<number | null> {
  const markets = await fetchJsonSafe<{ symbol: string; price_change_percentage_30d: number | null }[]>(
    'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&price_change_percentage=30d',
    [],
    { label: 'coingecko markets', retries: 1, timeoutMs: 20_000 },
  );
  if (markets.length < 10) return null;
  const btc = markets.find((m) => m.symbol === 'btc');
  if (!btc || btc.price_change_percentage_30d === null) return null;
  const outperforming = markets.filter(
    (m) => m.price_change_percentage_30d !== null && m.price_change_percentage_30d > btc.price_change_percentage_30d!,
  ).length;
  return Math.round((outperforming / markets.length) * 1000) / 1000;
}

/** Kick off a scan in the background so the first page load is not blocking. */
export function warmScan(): void {
  if (warming) return;
  warming = true;
  getScan().catch(() => undefined).finally(() => {
    warming = false;
  });
}

export function currentScan(): ScanResult | null {
  return scanCache?.current ?? null;
}