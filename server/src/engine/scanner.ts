import type {
  AssetRow, Candle, Conviction, DerivRow, MarketEvent, NewsItem, PickRule, ScanResult,
  SectorFlow, Setup, Side, Tf, Unlock, VolatilityContext,
} from '../../../shared/types';
import type { Grade, Regime, SizeAdvice } from '../config.js';
import { CONVICTION, MIND, STRUCTURE } from '../config.js';
import { fetchKlines } from '../data/binance.js';
import { EXCLUDE_FROM_BOARD } from '../data/universe.js';
import { resolveUniverse } from '../data/universeBuilder.js';
import {
  averageRange, choppiness, detectOrderBlock, percentileOf, sessionStartTime, sessionVwap,
  strengthScore,
} from './orderblock.js';
import { assessHtf, relativeStrength, volatilityContext } from './timeframes.js';
import { assignPicks, scoreConviction, sizeAdviceFor } from './conviction.js';
import { buildPlan, buildLeverageCheck } from './tradePlan.js';
import { buildDerivatives } from '../data/derivatives/build.js';
import { fetchAllNews } from '../data/rss.js';
import { buildFeed } from './news/score.js';
import type { RawArticle } from './news/score.js';
import { bans, hostOf } from '../lib/http.js';
import { NETWORK } from '../config.js';
import { formatIst } from '../lib/time.js';
import { geckoMarkets } from '../data/coingecko.js';
import { globalMarket, macroState } from '../data/macro.js';
import { blackoutReason, eventCalendar } from '../data/calendar.js';
import { buildButterfly } from './butterfly.js';
import { idFor, runMindPass, type MarketContext } from './mind/scan.js';
import { assessDataHealth, gradeWithHealth, type DataHealth } from './dataHealth.js';

/**
 * Is the process serving fixtures? Part XV.
 *
 * The health gate must be able to say "this is a mock" as a fact rather than
 * inferring it from the absence of data. Read once at module load because the
 * transport cannot change mid-process.
 */
function isMockTransport(): boolean {
  return process.env.ORDERFLOW_MOCK === '1';
}

/**
 * Age of the newest price the live stream has published, in ms.
 *
 * `null` when the stream has published nothing at all, which the gate reads as
 * `unavailable` rather than as "very fresh" — a dead feed reporting healthy is
 * the exact failure the gate exists to stop.
 *
 * The source is bound at boot by `index.ts` to `streamHub.lastTickAt()`, which
 * was already the value `/api/health` reported. This exists because a pure
 * function cannot read a module singleton without losing its determinism, and
 * the gate's tests depend on the clock being injected.
 */
function priceStreamAgeMs(asOf: number): number | null {
  const seen = pricePublishedAt ? pricePublishedAt() : null;
  if (seen === null || seen === 0) return null;
  // A tick can arrive after the scan captured `asOf` but before this verdict is
  // built. A negative age is not "very fresh" to classifyStream; it is treated
  // as unavailable, which closed the gate on a healthy stream. Clamp to zero,
  // matching the completion-stamp handling used for the other feeds.
  return Math.max(0, asOf - seen);
}

/** Injected by the live ingest module at boot; `null` until then. */
let pricePublishedAt: (() => number | null) | null = null;

export function bindPriceClock(fn: () => number | null): void {
  pricePublishedAt = fn;
}

/**
 * Fold the health verdict into a conviction, preserving every other field.
 *
 * The reason is APPENDED to `vetoes` rather than replacing them, so the ledger
 * and the UI can still show what the market looked like. Losing the original
 * structure evidence would destroy the counter-example the shadow set exists to
 * keep — and the whole point of a data-integrity block is that we still record
 * what we would have said.
 *
 * A context with no `health` is treated as "not yet assessed", not "healthy":
 * `null` passes through unchanged rather than being read as a pass.
 */
function applyHealthToConviction(
  conviction: Conviction,
  health: DataHealth | undefined,
): Conviction {
  if (!health) return conviction;
  const next = gradeWithHealth(
    conviction.grade === 'A' || conviction.grade === 'B' ? conviction.grade : 'C',
    health,
  );
  if (next === conviction.grade) return conviction;
  const reasons = [...conviction.vetoes];
  if (!health.tradable) reasons.push(health.reason ?? 'data integrity: unknown');
  for (const d of health.degraded) reasons.push(`degraded: ${d.reason}`);
  return {
    ...conviction,
    grade: next,
    // A vetoed row is by definition not a pick, whatever the score said.
    isPick: next === 'A' || next === 'B' ? conviction.isPick : false,
    vetoes: reasons,
  };
}
import { resolveIdentity } from '../data/coinIdentity.js';
import { fixtureSymbols } from '../mock/dataset.js';
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
  displayTicker: string;
  displayName: string | null;
  logoUrl: string | null;
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
  /**
   * The data-integrity verdict for this scan. Present whenever `enrichContext`
   * has run; a hand-built test context may omit it, and every consumer treats
   * an absent verdict as "not yet assessed" rather than as "healthy".
   */
  health?: DataHealth;
  /** Optional hint fed into the coarse regime read. [TUNED] */
  breadthHint?: number;
  /**
   * Market-wide readings the Mind layer needs. **Omit it and the Mind pass does
   * not run** — rows come back with `mind: null` and the board is exactly what it
   * was before. That is deliberate rather than incidental: it keeps every
   * existing scan test honest (they construct a context without it) and means a
   * missing macro feed degrades to "no Mind numbers" instead of "wrong ones".
   */
  mind?: {
    market: MarketContext;
    baseRate: { observedWinRate: number | null; resolvedSamples: number };
  } | null;
  now: number;
}

function pctChange(candles: Candle[], periods: number): number {
  const closed = candles.filter((c) => c.closed);
  if (closed.length <= periods) return 0;
  const a = closed[closed.length - 1 - periods].c;
  return a > 0 ? ((closed[closed.length - 1].c - a) / a) * 100 : 0;
}

export async function runScan(ctx: ScanContext): Promise<ScanResult> {
  // The universe is resolved live: every USDT spot pair above the configured
  // volume floor, keyed by its EXPLICIT `${base}USDT` pair (USDC only as a
  // labelled fallback). See data/universeBuilder.ts for why keying by stripped
  // base silently dropped 14 liquid coins.
  const universe = await resolveUniverse();

  // Mock mode restricts the universe to the symbols the fixture set actually
  // covers. Without this the scan requests series the replay transport cannot
  // serve and logs a refusal for each on every boot. Outside mock mode
  // `fixtureSymbols()` is null and nothing is filtered.
  const mockOk = fixtureSymbols();
  const liquid = universe.entries.filter(
    (e) => !EXCLUDE_FROM_BOARD.has(e.base) && (mockOk ? mockOk.has(e.pair) : true),
  );

  const scanned: Scanned[] = [];

  for (let i = 0; i < liquid.length; i += CONCURRENCY) {
    const batch = liquid.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (u): Promise<Scanned> => {
        const pair = u.pair;
        const ticker = u.ticker;
        const m5 = await fetchKlines(pair, '5m', 320);

        const last = m5[m5.length - 1];
        if (!last) throw new Error('no candles');

        const price = ticker.lastPrice || last.c;
        const changePct = ticker.priceChangePercent;
        const dayHigh = Math.max(ticker.highPrice, last.h);
        const dayLow = Math.min(ticker.lowPrice, last.l);
        const rangePct = ((dayHigh - dayLow) / price) * 100;

        const closed5m = m5.filter((c) => c.closed);
        const dayStart = sessionStartTime(closed5m);
        const side: Side = changePct >= 0 ? 'bullish' : 'bearish';

        const setup =
          rangePct >= STRUCTURE.MIN_RANGE_PCT && closed5m.length >= 40
            ? detectOrderBlock(m5, { range: averageRange(closed5m, STRUCTURE.ATR_LOOKBACK), prefer: side })
            : null;

        // Higher timeframes for alignment. Fetched in parallel and tolerated
        // on failure Ã¢â‚¬â€ HTF context is an adjustment, not a requirement.
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

        const identity = resolveIdentity(u.base, u.hasMetadata ? u.name : '', u.sector);

        return {
          base: u.base,
          pair,
          symbol: pair,
          name: u.name,
          sector: u.sector,
          displayTicker: identity.displayTicker,
          // A missing name is `null`, never a guessed one. The UI shows the
          // ticker alone with a "name unavailable" tooltip in that case.
          displayName: identity.displayName || null,
          logoUrl: identity.logoUrl,
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

  // Ã¢â€â‚¬Ã¢â€â‚¬ Percentiles and boards Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const strengths = scanned.map((s) => s.strength);
  const directional = scanned.filter((s) => s.strength > 0);
  const choppyCount = scanned.length - directional.length;

  const bullish = directional.filter((s) => s.side === 'bullish').sort((a, b) => b.strength - a.strength);
  const bearish = directional.filter((s) => s.side === 'bearish').sort((a, b) => b.strength - a.strength);

  // Ã¢â€â‚¬Ã¢â€â‚¬ Sector flow (needed before conviction, which reads it) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

  // Ã¢â€â‚¬Ã¢â€â‚¬ Build rows with conviction, plan and leverage Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
      // `deriv` was omitted here, which sent `buildCosts` down its null branch on
      // every single row: funding was always 0 bps and slippage was always the
      // 5 bps default. `netExpectedR` — and therefore the actionability gate —
      // was therefore computed against understated costs. Passing the real row
      // is the fix; see CONTEXT.md Part XV.
      // `opts` is deliberately omitted: no account size has been chosen, so the
      // row publishes `riskPerUnit` and leaves `qty` null rather than sizing
      // against an invented balance.
      const plan = s.setup
        ? buildPlan(s.base, side, s.setup, s.price, atr, undefined, deriv)
        : null;
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
        // D1: the full ticker and the full name, always. `base` is never
        // shortened for display â€” a two-letter ticker loses the one piece of
        // information that identifies the coin on the row.
        displayTicker: s.displayTicker,
        displayName: s.displayName,
        logoUrl: s.logoUrl,
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
        // ── The data-integrity gate, applied to the grade (Part XV) ──────────
        // Spec rule 2: a signal may not come from stale, unverified or mocked
        // data. `gradeWithHealth` can only ever move a grade DOWN, so it cannot
        // manufacture an A. A blocked stream yields `NO TRADE` with the reason
        // recorded on the row; a degraded stream caps the grade at C while the
        // setup stays visible as shadow evidence.
        conviction: applyHealthToConviction(conviction, ctx.health),
        isPick: conviction.isPick && (ctx.health?.tradable ?? true),
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

  // Ã¢â€â‚¬Ã¢â€â‚¬ Market picture Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

  // ── The Mind pass ───────────────────────────────────────────────────────
  // Runs only when the caller supplied `ctx.mind`, and placed here so the
  // `market` picture it reads as breadth is already built. Everything it needs is
  // already computed by this scan, so it adds no upstream call and no extra
  // latency — it is arithmetic over data the board is already displaying.
  //
  // Failure is contained on purpose: a throw here must not take the board down
  // with it, because the board predates the Mind layer and is still the primary
  // surface. A Mind failure means "no Mind numbers", which the UI renders as
  // nothing rather than as a number.
  let mindPass: ReturnType<typeof runMindPass> | null = null;
  if (ctx.mind) {
    try {
      const allRows = [...bullRows, ...bearRows];
      const candlesBySymbol = new Map<string, Candle[]>();
      for (const s of scanned) candlesBySymbol.set(`${s.base}USDT`, s.candles);
      for (const r of allRows) if (!candlesBySymbol.has(r.pair)) candlesBySymbol.set(r.pair, []);

      mindPass = runMindPass({
        rows: allRows,
        candlesBySymbol,
        market: {
          ...ctx.mind.market,
          // Filled here rather than in `enrichContext` because `s.vol` is only
          // computed inside `runScan`, and this is the first place the whole
          // universe's volatility is available. Median, so one 200%-ATR alt
          // does not define the market's energy level.
          atrPercentile: medianAtrPercentile(scanned),
        },
        asOf: ctx.now,
        marketPicture: market,
        sectors,
        baseRate: ctx.mind.baseRate,
      });

      for (const r of allRows) {
        const key = idFor(r.base, r.side);
        r.mind = mindPass.byId.get(key) ?? null;
        r.mindFeatures = mindPass.featuresById.get(key) ?? null;
      }
    } catch (err) {
      mindPass = null;
      for (const r of [...bullRows, ...bearRows]) {
        r.mind = null;
        r.mindFeatures = null;
      }
      console.warn(`[mind] pass skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
    // The spec's `data_health` block, published rather than applied silently.
    // A gate whose verdict nobody can see cannot be audited, and the reason a
    // signal is `NO TRADE` has to travel with it.
    dataHealth: ctx.health ?? null,
    // Built from the FULL scanned universe, not from the boards. The boards
    // hold at most BOARD_SIZE per side, so charting those would show the
    // extremes twice and imply breadth that does not exist.
    butterfly: buildButterfly(scanned),
    // Same population as `butterfly`, with tickers and strength, so the depth
    // curve's buckets and its denominator both come from the universe rather
    // than the capped board rows.
    universeRows: scanned.map((s) => ({
      ticker: s.displayTicker || s.base,
      changePct: round2(s.changePct),
      strength: s.strength,
    })),
    // Present only when the Mind pass ran. A scan without `ctx.mind` returns a
    // board byte-identical to the pre-Mind board, `mind` field absent.
    ...(mindPass
      ? {
          mind: {
            regime: mindPass.regime,
            regimeEvidence: mindPass.regimeVerdict.evidence,
            base: {
              rate: mindPass.base.rate,
              samples: mindPass.base.samples,
              source: mindPass.base.source,
            },
          },
        }
      : {}),
  };
}

/**
 * Median ATR percentile across the scanned universe, or null when nothing
 * measured one. Null is the honest answer when no asset produced a volatility
 * context, and the classifier then reports volatility as "not measured" rather
 * than assuming normal.
 */
function medianAtrPercentile(items: Scanned[]): number | null {
  const xs = items
    .map((s) => s.vol?.atrPercentile)
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (xs.length === 0) return null;
  const sorted = xs.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
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
//
// Skipped entirely in mock mode. The persisted board is LIVE data from a
// previous session, so loading it would put real numbers on a screen that is
// explicitly labelled MOCK DATA â€” which is the exact confusion the label exists
// to prevent. Caught by the mock boot proof, which showed a board of live-only
// symbols that had no fixture at all.
(function hydrateScanCache() {
  if (process.env.ORDERFLOW_MOCK === '1') return;
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
 * STALE-WHILE-REVALIDATE: if any board is already held â€” fresh OR stale â€” it is
 * returned immediately and a refresh is kicked off in the background. A real
 * board a minute old is far better than a spinner, so only the very first
 * request ever waits on a live scan, and after the first run even that case is
 * covered by the persisted board.
 */
export async function getScan(forceContext?: Partial<ScanContext>): Promise<ScanResult> {
  const cached = scanCache?.current ?? null;

  // Fix 1 â€” a banned primary host means we serve the last good board and send
  // nothing. Attempting a scan anyway would burn a guaranteed 418 per symbol,
  // which is how a single scan turns a 429 into a multi-day block.
  const banNote = banNotice();
  if (banNote && cached) return { ...cached, stale: true, reason: banNote };

  if (cached && !forceContext) {
    // A scan that ran while the spot socket had not ticked yet is not a valid
    // cached verdict once price is flowing. Without this, the boot board stayed
    // "price unavailable / NO TRADE" for a full TTL after the stream opened.
    const missedLivePrice =
      cached.dataHealth?.price_stream === 'unavailable'
      && priceStreamAgeMs(Date.now()) !== null;
    if (missedLivePrice) {
      if (!banNote) void refreshScan().catch(() => undefined);
      return {
        ...cached,
        stale: true,
        reason: 'Price stream came online after this scan; refreshing the board.',
      };
    }
    if (Date.now() - cached.updatedAt < SCAN_TTL_MS) return cached;
    // Stale: hand it back now, refresh behind the scenes.
    if (!banNote) void refreshScan().catch(() => undefined);
    return banNote ? { ...cached, stale: true, reason: banNote } : cached;
  }

  // If we have nothing in memory, try one more read from disk (cold start edge
  // case where hydration raced or the process was started in an unusual order).
  // This guarantees the UI never shows a blank board on restart when a valid
  // cached board exists on disk.
  if (!cached) {
    const persisted = loadPersistedScan();
    if (persisted) {
      // Hold the board in a local as well as in the cache: `scanCache` is a
      // module-level `let`, so the assignment below would be widened back to
      // `ScanCache | null` after the `refreshScan()` call, and `ScanResult` has
      // no optional fields to fall back on.
      const board: ScanResult = {
        ...persisted,
        stale: true,
        reason: 'Showing the last saved board while a fresh scan runs.',
      };
      scanCache = { current: board, previousRanks: new Map(), context: null };
      if (!forceContext) {
        if (!banNote) void refreshScan().catch(() => undefined);
        return banNote ? { ...board, stale: true, reason: banNote } : board;
      }
    }
  }

  return refreshScan(forceContext);
}

/**
 * Human-readable ban state for the board's `reason` field, or null when the
 * primary market-data host is usable. Rendered in the UI as a banner.
 */
export function banNotice(): string | null {
  const host = hostOf(NETWORK.BINANCE_SPOT_HOST);
  if (!bans.isBanned(host)) return null;
  const until = bans.bannedUntil(host);
  const untilIst = until ? formatIst(until) : 'unknown';
  const left = Math.max(0, Math.ceil(bans.remainingMs(host) / 1000));
  return (
    `BANNED until ${untilIst} IST (${left}s remaining) â€” showing the last saved board, marked STALE. ` +
    'No requests are being sent to this host.'
  );
}

/**
 * Always run a fresh scan, bypassing the cache entirely. Used on a 5-minute
 * candle close and by the live verification tools, where a persisted or cached
 * board is not acceptable â€” they need the market as it is now.
 */
export function forceScan(): Promise<ScanResult> {
  return refreshScan();
}

/**
 * The actual scan. Single-flight: concurrent callers share one run.
 *
 * `inFlight` is set SYNCHRONOUSLY, before the first await. Otherwise the warm
 * scan, `/api/scan` and `/api/attribution` â€” which all fire within moments of a
 * cold start â€” each slip past the guard while `enrichContext` is still awaiting,
 * and the process runs several full scans at once. That both slows the first
 * load and bursts the exchange rate limit.
 */
async function refreshScan(forceContext?: Partial<ScanContext>): Promise<ScanResult> {
  if (inFlight) return inFlight;

  // Fix 1 â€” never start a scan that cannot possibly succeed. See banNotice().
  const banNote = banNotice();
  if (banNote && scanCache?.current) {
    return { ...scanCache.current, stale: true, reason: banNote };
  }

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
 * components, so an empty map here silently degrades every grade â€” the board
 * still renders, but the Flow and Pos columns go empty and two of the seven
 * components score zero. That is why this is populated here rather than left
 * to the route handler.
 */
/**
 * Supplies the ledger's observed win rate for the Mind layer's probability
 * anchor.
 *
 * A seam rather than a direct ledger read, for one reason: the scanner must stay
 * importable without `node:sqlite`, or every scan test would need the database
 * alias and the whole engine would be untestable in isolation.
 *
 * `index.ts` installs the real provider at boot. With no provider installed the
 * anchor falls back to the model's prior blend, which is the safe direction —
 * "we do not know the base rate yet", not "the base rate is zero".
 */
type MindBaseRateProvider = () => { observedWinRate: number | null; resolvedSamples: number };
let mindBaseRateProvider: MindBaseRateProvider | null = null;

export function setMindBaseRateProvider(fn: MindBaseRateProvider | null): void {
  mindBaseRateProvider = fn;
}

/**
 * A fetch that reports its own failure instead of dissolving into a value that
 * looks like data. Part XV.
 *
 * The old pattern was `fetchAllNews().catch(() => [])`. An empty array is a
 * perfectly plausible news state, so the outage became indistinguishable from
 * "no headlines" and `newsScore()` paid it 5/10 — the same as a genuinely quiet
 * asset. The market then graded an A-pick with the feed dead. This wrapper keeps
 * the failure as a first-class value so `assessDataHealth` can see it.
 */
interface Fetched<T> {
  ok: boolean;
  value: T;
  error: string | null;
  /** When the fetch completed, for freshness. */
  at: number;
}

async function watched<T>(
  what: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<Fetched<T>> {
  try {
    const value = await fn();
    // Stamped on COMPLETION, not on start. The scan's `now` is captured before
    // this runs, so a start-time stamp makes `now - at` negative — and a negative
    // age correctly reads as `unavailable`, which closed the gate on a healthy
    // calendar. Freshness means "how old is the datum I now hold", and that is
    // the moment it arrived.
    return { ok: true, value, error: null, at: Date.now() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[scan] ${what} unavailable: ${message}`);
    return { ok: false, value: fallback, error: message, at: Date.now() };
  }
}

async function enrichContext(ctx: ScanContext): Promise<ScanContext> {
  const [derivsF, newsF, btcK, ethK, btcDominance, altseason, calF, macro] = await Promise.all([
    watched(
      'derivatives',
      () => buildDerivatives(),
      { rows: [], asOf: Date.now(), source: null, unavailable: 'derivatives unavailable' } as Awaited<
        ReturnType<typeof buildDerivatives>
      >,
    ),
    watched('news', () => fetchAllNews(), [] as RawArticle[]),
    watched('btc 5m klines', () => fetchKlines('BTCUSDT', '5m', 300), [] as Candle[]),
    watched('eth 5m klines', () => fetchKlines('ETHUSDT', '5m', 300), [] as Candle[]),
    globalMarket().then((m) => m?.btcDominance ?? null).catch(() => null),
    altseasonIndex().catch(() => null),
    // The calendar MUST be present. When it is not, the blackout is treated as
    // CLOSED rather than clear — see `blackedOut` below.
    watched('macro calendar', () => eventCalendar(ctx.now), {
      events: [] as MarketEvent[],
      updatedAt: ctx.now,
      sources: [],
      nextBlackout: null,
    } as Awaited<ReturnType<typeof eventCalendar>>),
    // The macro panel for the Mind layer's regime and sentiment features. Falls
    // back to null, which leaves those features unmeasured rather than zero.
    macroState().catch(() => null),
  ]);

  const derivs = derivsF.value;
  const newsItems = newsF.value;
  const cal = calF.value;

  const derivatives = new Map<string, DerivRow>();
  for (const row of derivs.rows) derivatives.set(row.symbol, row);

  const btcChange = changeOver(btcK.value, 288);
  const ethChange = changeOver(ethK.value, 288);

  // ── The data-integrity gate (Part XV) ───────────────────────────────────
  // Each stream reports its own age and its own failure. Nothing here invents a
  // value, and an outage is never allowed to read as a measurement.
  // The scan's `now` is captured before these fetches begin, so a completion stamp
  // can be a hair later than `ctx.now` and the difference can come out negative.
  // A negative age is meaningless and would read as `unavailable`, closing the
  // gate on a feed that just answered — so the age is clamped at zero here rather
  // than teaching `classifyStream` to forgive it.
  const ageSince = (at: number): number => Math.max(0, ctx.now - at);

  const health = assessDataHealth({
    asOf: ctx.now,
    price: { ageMs: priceStreamAgeMs(ctx.now) },
    derivatives: {
      ageMs: ageSince(derivsF.at),
      unavailable: derivs.unavailable ?? (derivsF.error ? derivsF.error : null),
    },
    news: { ageMs: ageSince(newsF.at), unavailable: newsF.error },
    calendar: { ageMs: ageSince(calF.at), unavailable: calF.error },
    mock: isMockTransport(),
  });

  return {
    ...ctx,
    derivatives,
    news: buildFeed(newsItems, ctx.now),
    btcCandles: btcK.value,
    ethCandles: ethK.value.length ? ethK.value : null,
    btcDominance,
    altseasonIndex: altseason,
    regime: assessRegime(derivs.rows, ctx.breadthHint ?? 0.5),
    events: cal.events,
    // The blackout is `true` on an unavailable calendar, not merely on a hit.
    // The old code asked "did we find a blackout?" and an outage answered no —
    // so the exact failure the calendar exists to prevent was the one it caused.
    blackedOut: !calF.ok || blackoutReason(cal.events, ctx.now) !== null,
    blackoutReason: !calF.ok
      ? `macro calendar unavailable (${calF.error ?? 'no calendar'}) — blackout unknown, so it is treated as closed`
      : blackoutReason(cal.events, ctx.now),
    health,
    mind: {
      market: {
        btcChangePct: btcChange,
        btcCandles: btcK.value,
        // NOT YET PLUMBED. Liquidation velocity needs the live
        // `LiquidationTracker`, which is constructed by `index.ts` and does not
        // travel in the scan context. Null is the honest value and it degrades
        // safely: the classifier reports "no liquidation feed", refuses to claim
        // a cascade, and its `high-vol-cascade` branch simply does not fire.
        // Inventing a zero here would make the cascade veto look armed.
        liqVelocityFrac: null,
        // A dominance *level* is available; a shift needs two readings over time,
        // which the scan does not retain. Null until something stores the prior.
        btcDominanceShiftPp: null,
        oiChange1h: derivatives.get('BTCUSDT')?.oiChange.h1 ?? null,
        macroBlackoutMin: minutesToNextBlackout(cal.events, ctx.now),
        fearGreed: macro?.fearGreed?.value ?? null,
        // No history is retained for Fear & Greed, so its z-score stays unmeasured.
        fearGreedHistory: [],
        stablecoinFloatUsd: macro?.stablecoins?.totalUsd ?? null,
        ethBtcChangePct:
          btcChange !== null && ethChange !== null ? ethChange - btcChange : null,
        atrPercentile: null,
      },
      baseRate:
    ctx.mind?.baseRate ??
    (mindBaseRateProvider ? mindBaseRateProvider() : { observedWinRate: null, resolvedSamples: 0 }),
    },
  };
}

/** Fractional change over the last `periods` closed candles, or null. */
function changeOver(candles: Candle[], periods: number): number | null {
  const closed = candles.filter((c) => c.closed);
  if (closed.length <= periods) return null;
  const a = closed[closed.length - 1 - periods].c;
  if (!(a > 0)) return null;
  return (closed[closed.length - 1].c - a) / a;
}

/**
 * Signed minutes to the next tier-1 release: positive before it, negative once
 * the event is inside the window. Null when the calendar is unavailable.
 *
 * **Past events are excluded outright.** The first version of this took the event
 * with the smallest *absolute* distance, which selected a release that had
 * already happened 2.7 days earlier and reported the market as being inside a
 * macro blackout because of it — vetoing every signal on the board. A blackout
 * window that has closed is closed; only an event still ahead of us can be
 * imminent.
 *
 * Null is NOT "no blackout". The classifier reports a null calendar as "blackout
 * cannot be ruled out" and the veto stays armed, which is the safe direction for
 * a schedule — the alternative is a missing feed silently disarming the only veto
 * that stands between a coin and a CPI print.
 */
/**
 * Minutes to the nearest tier-1 blackout boundary. **Negative means a blackout
 * is already open.**
 *
 * Two failure modes were fixed here, both found by the Part XV audit:
 *
 * 1. This originally accepted any future event and ignored the past entirely,
 *    so a release from 2.7 days ago blacked out every signal for ever.
 * 2. Fixing that with `if (mins <= 0) continue` over-corrected: it also dropped
 *    an event that fired 10 minutes ago and whose window is STILL OPEN. The
 *    correct bound is `-VETO_BLACKOUT_MIN`, not `0`.
 *
 * So an event counts while `mins <= +VETO_BLACKOUT_MIN` and
 * `mins >= -VETO_BLACKOUT_MIN`. Anything older is genuinely past.
 */
function minutesToNextBlackout(events: MarketEvent[], now: number): number | null {
  let nearest: number | null = null;
  for (const e of events) {
    if (e.blackout !== true) continue;
    const mins = (e.t - now) / 60_000;
    // Still relevant if it is approaching, OR if its window has not closed yet.
    if (mins > MIND.VETO_BLACKOUT_MIN) continue;
    if (mins < -MIND.VETO_BLACKOUT_MIN) continue;
    if (nearest === null || Math.abs(mins) < Math.abs(nearest)) nearest = mins;
  }
  return nearest;
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
  const all = await geckoMarkets().catch(() => []);
  const markets = all.slice(0, 50);
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
