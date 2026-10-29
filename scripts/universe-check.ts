import { fetchExchangeSymbols, fetchTickers } from '../server/src/data/binance.js';
import { selectUniverse } from '../server/src/data/universeBuilder.js';
import {
  MIN_UNIVERSE_VOLUME_USD, UNIVERSE_MAX_PAIRS,
} from '../server/src/config.js';

/**
 * Stage 1 evidence: the live universe the scanner will use.
 *
 * Prints the candidate counts at each volume threshold, the final capped list,
 * and every exclusion with its reason. Run with `npm run check:universe`.
 */

const [symbols, tickers] = await Promise.all([fetchExchangeSymbols(), fetchTickers()]);

const resolution = selectUniverse({
  symbols,
  tickers,
  minVolumeUsd: MIN_UNIVERSE_VOLUME_USD,
  maxPairs: UNIVERSE_MAX_PAIRS,
});

console.log(`exchangeInfo symbols: ${symbols.length} (status TRADING, quoted pairs)`);
console.log(`24h tickers: ${tickers.length}`);
console.log('');
console.log('candidate pairs by 24h quote volume:');
for (const [label, count] of Object.entries(resolution.volumeCounts)) {
  console.log(`  ${label.padStart(5)} : ${count}`);
}
console.log('');
console.log(`final universe: ${resolution.entries.length} pairs (floor $${(MIN_UNIVERSE_VOLUME_USD / 1e6).toFixed(1)}M, cap ${UNIVERSE_MAX_PAIRS})`);
console.log(resolution.entries.map((e) => e.base).join(' '));
console.log('');
console.log(`excluded: ${resolution.excluded.length}`);
const byReason = new Map<string, number>();
for (const e of resolution.excluded) {
  // Volume-floor reasons carry the exact dollar figure, which would make one
  // bucket per pair. Collapse them to one labelled category.
  const key = e.reason.startsWith('24h quote volume') ? 'below volume floor' : e.reason;
  byReason.set(key, (byReason.get(key) ?? 0) + 1);
}
for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${reason}`);
}
console.log('');
console.log('spot checks (must be present): DOT NEAR UNI AAVE FIL ICP');
const bases = new Set(resolution.entries.map((e) => e.base));
const want = ['DOT', 'NEAR', 'UNI', 'AAVE', 'FIL', 'ICP', 'LINK', 'ATOM'];
for (const b of want) {
  const e = resolution.entries.find((x) => x.base === b);
  console.log(`  ${e ? 'OK    ' : 'MISSING'} ${b} ${e ? `-> ${e.pair} $${(e.ticker.quoteVolume / 1e6).toFixed(1)}M` : ''}`);
}
