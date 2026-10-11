import { fetchExchangeSymbols, fetchTickers } from '../server/src/data/binance.js';
import { UNIVERSE } from '../server/src/data/universe.js';

const [syms, tickers] = await Promise.all([fetchExchangeSymbols(), fetchTickers()]);
const usdt = new Set(syms.filter((s) => s.quote === 'USDT').map((s) => s.base));
const tv = new Map<string, number>();
for (const t of tickers) {
  const base = t.symbol.replace(/USDT$/, '');
  if (!tv.has(base)) tv.set(base, t.quoteVolume);
}

console.log('universe size:', UNIVERSE.length);
const missing: string[] = [];
const thin: string[] = [];
for (const u of UNIVERSE) {
  if (!usdt.has(u.base)) missing.push(u.base);
  else if ((tv.get(u.base) ?? 0) < 1_000_000) thin.push(`${u.base}=$${((tv.get(u.base) ?? 0) / 1e6).toFixed(1)}M`);
}
console.log('\nNOT on Binance USDT spot:', missing.join(', ') || 'none');
console.log('\nUnder $1M 24h volume:', thin.join(', ') || 'none');

console.log('\n--- top USDT pairs by quote volume (candidates to add) ---');
const rows = tickers
  .filter((t) => t.symbol.endsWith('USDT') && t.quoteVolume > 20_000_000)
  .sort((a, b) => b.quoteVolume - a.quoteVolume)
  .slice(0, 60);
console.log(rows.map((t) => t.symbol.replace(/USDT$/, '')).join(' '));
