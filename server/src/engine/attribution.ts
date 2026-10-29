import type { Attribution, AttributionEntry, NewsItem, Candle } from '../../../shared/types.js';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function logReturns(candles: Candle[], periods: number): number[] {
  const out: number[] = [];
  for (let i = periods; i < candles.length; i++) {
    const a = candles[i - periods].c;
    const b = candles[i].c;
    if (a > 0) out.push(Math.log(b / a));
  }
  return out;
}

function logVolumes(candles: Candle[], periods: number): number[] {
  const out: number[] = [];
  for (let i = periods; i < candles.length; i++) {
    if (candles[i].v > 0) out.push(Math.log(candles[i].v));
  }
  return out;
}

export interface AttributionOptions {
  horizonMinutes: number;
  /** Rolling beta of the asset against BTC, used for the expected return. */
  btcBeta?: number;
  btcReturnPct?: number;
}

/**
 * Explain a move by attributing it to news.
 *
 * The approach: compute the abnormal return (raw move minus what BTC's move
 * would imply), gate on whether the move is statistically significant, then
 * distribute the abnormal return across recent news by weighted NIS x
 * direction. Coverage tells the trader whether there is a news story at all
 * or whether it was flow/liquidation driven.
 */
export function attribute(
  symbol: string,
  name: string,
  candles: Candle[],
  news: NewsItem[],
  opts: AttributionOptions,
): Attribution | null {
  /**
   * Closed candles only, enforced here rather than at the caller.
   *
   * Every other consumer of this repo filters `c.closed` at its own boundary
   * (`orderblock.ts`, `timeframes.ts`, `conviction.ts`, `worker.ts`,
   * `backfill.ts`). This function did not, and both call sites pass the raw
   * `fetchKlines` array — so the still-forming 5m bar was inside `lastPrice`,
   * `basePrice`, `rawReturnPct`, `moveZ` and `volZ`. A partially-formed bar is
   * not a price the market reached; a move measured against one is not a move
   * that happened, and the 2.5-sigma gate then judges fiction.
   */
  const closed = candles.filter((c) => c.closed);
  const periods = Math.max(1, Math.round(opts.horizonMinutes / 5));
  if (closed.length < periods + 25) return null;

  const closes = closed.map((c) => c.c);
  const lastPrice = closes[closes.length - 1];
  const at = closed.length - 1 - periods;
  if (at < 1) return null;

  const basePrice = closes[at];
  if (basePrice <= 0) return null;

  const rawReturnPct = ((lastPrice - basePrice) / basePrice) * 100;

  // Expected return: BTC beta times the BTC move, with a small drift term.
  const beta = opts.btcBeta ?? 1;
  const expectedReturnPct = beta * (opts.btcReturnPct ?? 0);
  const abnormalReturnPct = rawReturnPct - expectedReturnPct;

  // Z-scores against the asset's own recent history of this-horizon moves.
  const histReturns = logReturns(closed.slice(0, at + 1), periods).map((r) => r * 100);
  const sd = stdev(histReturns) || 1;
  const moveZ = abnormalReturnPct / sd;

  const histVolumes = logVolumes(closed.slice(0, at + 1), periods);
  const vMean = mean(histVolumes);
  const vSd = stdev(histVolumes) || 1;
  const curVol = closed.slice(at + 1).reduce((a, c) => a + c.v, 0);
  const volZ = curVol > 0 ? (Math.log(curVol) - vMean) / vSd : 0;

  const significant = (Math.abs(moveZ) >= 2.5 && volZ >= 2) || Math.abs(moveZ) >= 3.5;

  const now = Date.now();
  const windowStart = now - opts.horizonMinutes * 60_000 - 120 * 60_000;

  const candidates = news.filter((n) => {
    if (n.publishedAt < windowStart || n.publishedAt > now) return false;
    // Commentary about price that already happened explains nothing.
    if (n.routine) return false;
    if (n.direction === 0) return false;
    return n.assets.includes(symbol) || n.jurisdiction === 'GLOBAL' || n.categories.includes('MACRO');
  });

  // Attribution weight: NIS decayed by how long ago it landed.
  const entries: AttributionEntry[] = candidates.map((n) => {
    const ageMin = Math.max(1, (now - n.publishedAt) / 60_000);
    const recency = Math.exp(-ageMin / 180);
    const assetMatch = n.assets.includes(symbol) ? 1 : n.categories.includes('MACRO') ? 0.55 : 0.3;
    return {
      newsId: n.id,
      headline: n.headline,
      nis: n.nis,
      direction: n.direction,
      directionScore: n.nis * recency * assetMatch * n.direction,
      share: 0,
    };
  });

  const totalWeight = entries.reduce((a, e) => a + Math.abs(e.directionScore), 0);
  if (totalWeight > 0) {
    for (const e of entries) e.share = clamp(e.directionScore / totalWeight, -1, 1);
  }

  const explainedPts = entries.reduce((a, e) => a + e.directionScore, 0);

  // Convert the summed NIS points into a percent-of-move estimate.
  const scale = 0.35;
  const explainedPct = clamp(explainedPts * scale, -25, 25);
  const rawCoverage = Math.abs(abnormalReturnPct) > 0.01
    ? clamp(Math.abs(explainedPct) / Math.abs(abnormalReturnPct), 0, 1)
    : 0;

  // Coverage is only meaningful when the move cleared the significance gate.
  // On a 0.3% move any headline would nominally "explain" it, so we report the
  // raw figure but the band is what the trader should read.
  const coverage = significant ? rawCoverage : 0;

  const band: Attribution['band'] =
    !significant || rawCoverage < 0.35 ? 'NO_CLEAR_DRIVER'
      : rawCoverage < 0.65 ? 'PARTIALLY_ATTRIBUTED'
        : 'DRIVEN_BY_NEWS';

  const reversalRisk = Math.max(
    0,
    ...entries.filter((e) => e.share > 0.05).map((e) => {
      const n = news.find((x) => x.id === e.newsId);
      return n?.reversalRisk ?? 0.3;
    }),
    0.3,
  );

  return {
    symbol,
    name,
    price: lastPrice,
    priceChangePct: Math.round((closed.length > 1
      ? ((lastPrice - closed[closed.length - 2].c) / closed[closed.length - 2].c) * 100
      : 0) * 100) / 100,
    rawReturnPct: Math.round(rawReturnPct * 100) / 100,
    expectedReturnPct: Math.round(expectedReturnPct * 100) / 100,
    abnormalReturnPct: Math.round(abnormalReturnPct * 100) / 100,
    moveZ: Math.round(moveZ * 100) / 100,
    volZ: Math.round(volZ * 100) / 100,
    significant,
    coverage: Math.round(coverage * 100) / 100,
    rawCoverage: Math.round(rawCoverage * 100) / 100,
    band,
    reversalRisk: Math.round(reversalRisk * 100) / 100,
    entries: entries
      .sort((a, b) => Math.abs(b.directionScore) - Math.abs(a.directionScore))
      .slice(0, 6),
    windowMinutes: opts.horizonMinutes,
    asOf: now,
    meta: {
      asOf: now,
      source: 'binance-klines',
      stale: false,
      derivation:
        'abnormal return vs BTC beta, gated on the asset\'s own return history; ' +
        'closed candles only; the 0.35 explained-return scale is hand-tuned and uncalibrated',
    },
  };
}

/** Rolling beta of an asset against BTC, fitted on log returns. */
export function rollingBeta(assetCloses: number[], btcCloses: number[], periods: number): number {
  const n = Math.min(assetCloses.length, btcCloses.length);
  if (n < periods + 25) return 1;
  const a: number[] = [];
  const b: number[] = [];
  for (let i = periods; i < n; i++) {
    const pb = btcCloses[i - periods];
    const pa = assetCloses[i - periods];
    if (pb > 0 && pa > 0) {
      b.push(Math.log(btcCloses[i] / pb));
      a.push(Math.log(assetCloses[i] / pa));
    }
  }
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < a.length; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    varB += (b[i] - mb) ** 2;
  }
  return varB > 0 ? Math.round((cov / varB) * 100) / 100 : 1;
}
