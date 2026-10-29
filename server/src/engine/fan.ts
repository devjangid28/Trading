import { fetchKlines } from '../data/binance.js';
import { currentUniverse } from '../data/universeBuilder.js';
import { resolveIdentity } from '../data/coinIdentity.js';
import { EXCLUDE_FROM_BOARD } from '../data/universe.js';
import { fixtureSymbols } from '../mock/dataset.js';
import { isMockActive } from '../mock/transport.js';
import { FAN } from '../config.js';
import type { Candle, FanAsset, FanPayload } from '../../../shared/types.js';

/**
 * The Order Block fan payload.
 *
 * One request serves the whole 24h fan: a 15m candle series for every liquid
 * pair in the scanned universe, reduced to cumulative % change so all threads
 * share an origin. The window and interval are fixed in config so a thread's
 * end value is comparable to the card's % label.
 *
 * The series is real or absent. A symbol with no candles is counted in
 * `missing` and left out — it is never padded with zeros or a guess, which
 * would draw a fabricated flat line on the chart (house rule 2).
 */

let cache: { at: number; payload: FanPayload } | null = null;
let inFlight: Promise<FanPayload> | null = null;

/** Cumulative % change over the last `FAN.POINTS` closes, oldest first. */
function seriesFrom(candles: Candle[]): number[] {
  const closes = candles.map((c) => c.c).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 2) return [];
  const win = closes.slice(-FAN.POINTS);
  const base = win[0];
  return win.map((c) => ((c - base) / base) * 100);
}

async function buildFan(): Promise<FanPayload> {
  const universe = currentUniverse();
  if (!universe) throw new Error('universe not ready');

  // Mirror the scanner's board filter exactly: no stablecoins/leveraged tokens,
  // and in mock mode only the symbols the fixture set can actually serve. A
  // fan that fans out to symbols the replay transport refuses would log a
  // refusal per symbol on every refresh.
  const mockOk = fixtureSymbols();
  const entries = universe.entries.filter(
    (e) => !EXCLUDE_FROM_BOARD.has(e.base) && (mockOk ? mockOk.has(e.pair) : true),
  );

  const assets: FanAsset[] = [];
  let missing = 0;
  let from = Infinity;
  let to = -Infinity;

  for (let i = 0; i < entries.length; i += FAN.CONCURRENCY) {
    const batch = entries.slice(i, i + FAN.CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (e) => ({ e, candles: await fetchKlines(e.pair, FAN.INTERVAL, FAN.POINTS) })),
    );
    for (const r of results) {
      if (r.status !== 'fulfilled') {
        missing++;
        continue;
      }
      const { e, candles } = r.value;
      const series = seriesFrom(candles);
      if (series.length < 2) {
        missing++;
        continue;
      }
      const identity = resolveIdentity(e.base, e.hasMetadata ? e.name : '', e.sector);
      const tickerChange = e.ticker.priceChangePercent;
      const win = candles.slice(-FAN.POINTS);
      from = Math.min(from, win[0].t);
      to = Math.max(to, win[win.length - 1].t);
      assets.push({
        base: e.base,
        pair: e.pair,
        displayTicker: identity.displayTicker,
        name: e.name,
        sector: e.sector,
        price: e.ticker.lastPrice || candles[candles.length - 1].c,
        changePct: Number.isFinite(tickerChange) ? tickerChange : series[series.length - 1],
        volumeUsd: Math.round(e.ticker.quoteVolume) || 0,
        series,
      });
    }
  }

  // Best first, so rank 1 is the strongest mover of the 24h window.
  assets.sort((a, b) => b.changePct - a.changePct);

  return {
    updatedAt: Date.now(),
    interval: FAN.INTERVAL,
    points: FAN.POINTS,
    from: Number.isFinite(from) ? from : Date.now() - 24 * 3600_000,
    to: Number.isFinite(to) ? to : Date.now(),
    assets,
    missing,
    mock: isMockActive(),
  };
}

/** Cached entry point — concurrent callers share one build. */
export function getFan(): Promise<FanPayload> {
  if (cache && Date.now() - cache.at < FAN.TTL_MS) return Promise.resolve(cache.payload);
  if (inFlight) return inFlight;
  inFlight = buildFan()
    .then((payload) => {
      cache = { at: Date.now(), payload };
      return payload;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Test seam — clears the cache so a spec can force a rebuild. */
export function resetFanCache(): void {
  cache = null;
}
