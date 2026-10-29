import { LIVE, REFRESH } from '../../config.js';
import { cached } from '../../lib/cache.js';
import type { Candle, DerivRow, LiqBuckets } from '../../../../shared/types';
import { binanceFutures, bybitFutures, bybitSnapshot, hyperliquidSnapshot, spotDepth } from './providers.js';
import { UNIVERSE, EXCLUDE_FROM_BOARD } from '../universe.js';
import { cvd, cvdDivergence } from '../../live/marketState.js';
import { crossVenue, fundingLabel, normaliseFunding, oiChanges, oiQuadrant, QUADRANT_LABEL, quadrantScore, lsDivergence, basisPct } from '../../engine/derivatives.js';
import { fetchKlines } from '../binance.js';

/**
 * Builds the DerivRow for every tracked perp. Called on a 30s timer and
 * pushed to the browser over SSE.
 *
 * Every field carries `meta.asOf` so the UI can mark the panel LIVE,
 * DELAYED or STALE rather than silently showing stale numbers.
 */
export interface LiveSource {
  candles(symbol: string): Promise<Candle[]>;
  liqTally(symbol: string): LiqBuckets;
}

export interface DerivativesResult {
  rows: DerivRow[];
  asOf: number;
  source: 'binance-futures' | 'bybit-linear' | null;
  unavailable: string | null;
}

export async function buildDerivatives(
  live?: LiveSource,
): Promise<DerivativesResult> {
  const now = Date.now();
  const pairs = UNIVERSE
    .filter((u) => !EXCLUDE_FROM_BOARD.has(u.base))
    .map((u) => `${u.base}USDT`);

  const [binanceRaw, hyper, bybit] = await Promise.all([
    binanceFutures.snapshot(pairs).catch(() => []),
    hyperliquidSnapshot().catch(() => []),
    bybitSnapshot(pairs).catch(() => new Map()),
  ]);

  const source: DerivativesResult['source'] = binanceRaw.length
    ? 'binance-futures'
    : 'bybit-linear';
  const raw = binanceRaw.length
    ? binanceRaw
    : await bybitFutures.snapshot(pairs).catch(() => []);

  if (!raw.length) {
    return {
      rows: [],
      asOf: now,
      source: null,
      unavailable:
        'Binance futures and Bybit linear are both unreachable. Derivatives data is unavailable.',
    };
  }

  const provider = source === 'binance-futures' ? binanceFutures : bybitFutures;

  /**
   * One row per perp. Pulled in parallel batches rather than one symbol at a
   * time: a serial loop over ~56 perps, each doing three network calls, is the
   * single slowest step before the board can be ranked.
   */
  const buildRow = async (r: (typeof raw)[number]): Promise<DerivRow | null> => {
    const [oiHist, ls, candles] = await Promise.all([
      provider.oiHistory(r.venueSymbol ?? r.symbol, '5m', 120)
        .catch(() => ({ symbol: r.venueSymbol ?? r.symbol, points: [] })),
      provider.longShort?.(r.venueSymbol ?? r.symbol, '5m').catch(() => null) ?? Promise.resolve(null),
      fetchKlines(r.symbol, '5m', 60).catch(() => []),
    ]);

    const closed = candles.filter((c) => c.closed);
    const changes = oiChanges(oiHist.points);
    const oiRising = changes.h1 > 0.5;
    const f8h = normaliseFunding(r.fundingRate, r.fundingIntervalH);
    const label = fundingLabel(f8h, oiRising);
    const c = cvd(closed);

    const quadrant = oiQuadrant(
      closed.length > 12
        ? ((closed[closed.length - 1].c - closed[closed.length - 13].c) / closed[closed.length - 13].c) * 100
        : 0,
      changes.h1,
    );

    return {
      symbol: r.symbol,
      funding8h: Math.round(f8h * 1e8) / 1e8,
      /**
       * Null, not zero.
       *
       * `fundingZScore()` exists and works, but it needs a funding history that
       * nothing collects. The field was hardcoded to `0`, and the UI rendered it
       * as "z=0.00" inside a tooltip reading "<label> · z=0.00 · interval 8h" -
       * a placeholder presented as a computed statistic. Until history is
       * collected this stays null and the UI shows a dash.
       */
      fundingZ: null,
      fundingIntervalH: r.fundingIntervalH,
      fundingLabel: label,
      openInterest: r.openInterest,
      oiUsd: Math.round(r.oiUsd ?? r.openInterest * r.markPrice),
      oiChange: {
        m5: round2(changes.m5), h1: round2(changes.h1),
        h4: round2(changes.h4), d1: round2(changes.d1),
      },
      quadrant,
      quadrantLabel: QUADRANT_LABEL[quadrant],
      markPrice: r.markPrice,
      indexPrice: r.indexPrice,
      basisPct: (() => {
        const b = basisPct(r.markPrice, r.indexPrice);
        return b === null ? null : round2(b);
      })(),
      longShortAccountRatio: ls?.accountRatio.length ? round3(ls.accountRatio[ls.accountRatio.length - 1].ratio) : null,
      topTraderPositionRatio: ls?.topPositionRatio.length ? round3(ls.topPositionRatio[ls.topPositionRatio.length - 1].ratio) : null,
      lsDivergence: ls
        ? (() => {
            const d = lsDivergence(
              ls.accountRatio.length ? ls.accountRatio[ls.accountRatio.length - 1].ratio : null,
              ls.topPositionRatio.length ? ls.topPositionRatio[ls.topPositionRatio.length - 1].ratio : null,
            );
            return d !== null ? round3(d) : null;
          })()
        : null,
      cvd: round2(c.value),
      cvdSlope: round4(c.slope),
      takerRatio: ls?.takerRatio.length ? round3(ls.takerRatio[ls.takerRatio.length - 1].ratio) : round3(c.takerRatio),
      cvdDivergence: closed.length >= 24 ? cvdDivergence(closed) : false,
      /**
       * Liquidations, or the reason there are none.
       *
       * The board path calls `buildDerivatives()` without a live source, so this
       * used to emit an all-zero bucket object tagged `isSample: true` under a
       * `binance-futures` meta. A zero reads as "no liquidations happened"; it
       * actually meant "no liquidation feed is attached here". Both the number
       * and the provenance were wrong, and the repo's own rule says a zero is a
       * lie. So: unavailable, with the reason attached.
       */
      liq: live
        ? live.liqTally(r.symbol)
        : {
            available: false,
            reason:
              'No liquidation feed is attached: the Binance forceOrder socket is not open, ' +
              'so no prints were sampled. This is not a zero.',
            lastGoodAt: null,
          },
      depth: null,
      crossVenue: crossVenue(
        r.symbol,
        f8h,
        r.oiUsd ?? r.openInterest * r.markPrice,
        hyper,
        source === 'binance-futures' ? bybit : new Map(),
        source,
      ),
      /**
       * `stale` was a hardcoded `false` on every row even though
       * `LIVE.DELAYED_AFTER_MS` exists precisely to decide it, and no server
       * code read it. It is now a real measurement: how long the upstream
       * snapshot took to arrive relative to the threshold the client also uses,
       * so the two cannot disagree.
       *
       * `source` names the venue that actually supplied funding, OI, basis and
       * ratios. CVD is the exception, so `derivation` names it: `fetchKlines`
       * hits the SPOT host, and CVD is computed from that series' taker-buy
       * notional. That is a price-action proxy, not a futures trade tape, and
       * an unlabelled proxy is indistinguishable from a measurement.
       */
      meta: {
        asOf: now,
        source,
        ageMs: Date.now() - now,
        stale: Date.now() - now >= LIVE.DELAYED_AFTER_MS,
        derivation: 'cvd from spot kline taker-buy notional (proxy, not a trade tape)',
      },
    };
  };

  const rows: DerivRow[] = [];
  const CONC = 8;
  for (let i = 0; i < raw.length; i += CONC) {
    const results = await Promise.allSettled(raw.slice(i, i + CONC).map(buildRow));
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value) rows.push(res.value);
    }
  }

  rows.sort((a, b) => Math.abs(b.funding8h) - Math.abs(a.funding8h));
  return { rows, asOf: now, source, unavailable: null };
}

function round2(v: number): number { return Math.round(v * 100) / 100; }
function round3(v: number): number { return Math.round(v * 1000) / 1000; }
function round4(v: number): number { return Math.round(v * 10000) / 10000; }

export { spotDepth, REFRESH, LIVE, cached, quadrantScore };
export type { DerivRow };
