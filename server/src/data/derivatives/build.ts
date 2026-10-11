import { LIVE, REFRESH } from '../../config.js';
import { cached } from '../../lib/cache.js';
import type { Candle, DerivRow, LiqBuckets } from '../../../../shared/types';
import { binanceFutures, bybitSnapshot, hyperliquidSnapshot, spotDepth } from './providers.js';
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

export async function buildDerivatives(
  live?: LiveSource,
): Promise<{ rows: DerivRow[]; asOf: number; unavailable: string | null }> {
  const now = Date.now();
  const pairs = UNIVERSE
    .filter((u) => !EXCLUDE_FROM_BOARD.has(u.base))
    .map((u) => `${u.base}USDT`);

  const [raw, hyper, bybit] = await Promise.all([
    binanceFutures.snapshot(pairs).catch(() => []),
    hyperliquidSnapshot().catch(() => []),
    bybitSnapshot(pairs).catch(() => new Map()),
  ]);

  if (!raw.length) {
    return {
      rows: [],
      asOf: now,
      unavailable: 'Binance futures unreachable. Derivatives data is unavailable.',
    };
  }

  /**
   * One row per perp. Pulled in parallel batches rather than one symbol at a
   * time: a serial loop over ~56 perps, each doing three network calls, is the
   * single slowest step before the board can be ranked.
   */
  const buildRow = async (r: (typeof raw)[number]): Promise<DerivRow | null> => {
    const [oiHist, ls, candles] = await Promise.all([
      binanceFutures.oiHistory(r.symbol, '5m', 120).catch(() => ({ symbol: r.symbol, points: [] })),
      binanceFutures.longShort?.(r.symbol, '5m').catch(() => null) ?? Promise.resolve(null),
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
      fundingZ: 0,
      fundingIntervalH: r.fundingIntervalH,
      fundingLabel: label,
      openInterest: r.openInterest,
      oiUsd: Math.round(r.openInterest * r.markPrice),
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
      liq: live
        ? live.liqTally(r.symbol)
        : { m5: 0, h1: 0, d1: 0, longM5: 0, shortM5: 0, longH1: 0, shortH1: 0, cascade: false, isSample: true },
      depth: null,
      crossVenue: crossVenue(r.symbol, f8h, r.openInterest * r.markPrice, hyper, bybit),
      meta: { asOf: now, source: 'binance-futures', stale: false },
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
  return { rows, asOf: now, unavailable: null };
}

function round2(v: number): number { return Math.round(v * 100) / 100; }
function round3(v: number): number { return Math.round(v * 1000) / 1000; }
function round4(v: number): number { return Math.round(v * 10000) / 10000; }

export { spotDepth, REFRESH, LIVE, cached, quadrantScore };
export type { DerivRow };
