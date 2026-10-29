import { fetchJson } from '../lib/http.js';
import { fetchExchangeSymbols } from './binance.js';
import { NETWORK } from '../config.js';
import { UNIVERSE_BY_BASE } from './universe.js';
import { allCoinIdentities } from '../ledger/store.js';
import { stripMultiplier } from './coinIdentity.js';

/**
 * The exchange-symbol index — EVERY tradeable symbol, not just the board.
 *
 * The diagnostic's search only knew the ~190 hand-maintained universe entries,
 * so a coin that trades on Binance but is not on the board was unsearchable: the
 * user typed its ticker and got "No matches". That is the opposite of what a
 * search box is for.
 *
 * This index is built from the venue's own `exchangeInfo` for BOTH markets:
 *
 *   - spot   `/api/v3/exchangeInfo?permissions=SPOT` (via the shared cached call)
 *   - perp   `${BINANCE_FUT_HOST}/fapi/v1/exchangeInfo`, filtered to PERPETUAL
 *
 * and refreshed every 6 hours. It is metadata only — a name, a sector and the
 * symbol pair. Live prices are attached by the route from the tick stream, never
 * invented here.
 *
 * Names come from the universe file first (the only source with a sector), then
 * from CoinGecko identities cached in SQLite. A symbol with neither keeps its
 * own ticker as the name and sector "Other" — never a guess.
 *
 * Perp renames (`1000PEPE`) are handled by `stripMultiplier`, so the display
 * ticker is the asset, while `pair` stays the exact traded symbol.
 */

const REFRESH_MS = 6 * 3600_000;

export interface IndexedSymbol {
  base: string;
  displayTicker: string;
  /** The exact symbol to subscribe/fetch, e.g. `1000PEPEUSDT`. */
  pair: string;
  quote: string;
  kind: 'spot' | 'perp';
  name: string;
  sector: string;
}

let cache: { at: number; entries: IndexedSymbol[] } | null = null;
let inflight: Promise<IndexedSymbol[]> | null = null;

/** Last built index, for synchronous callers. Null until the first build. */
export function cachedSymbolIndex(): IndexedSymbol[] | null {
  return cache?.entries ?? null;
}

export async function symbolIndex(force = false): Promise<IndexedSymbol[]> {
  if (!force && cache && Date.now() - cache.at < REFRESH_MS) return cache.entries;
  if (inflight) return inflight;

  inflight = build()
    .then((entries) => {
      cache = { at: Date.now(), entries };
      const spot = entries.filter((e) => e.kind === 'spot').length;
      console.log(
        `[search] symbol index: ${entries.length} entries (${spot} spot, ${entries.length - spot} perp), refreshes every ${REFRESH_MS / 3600_000}h`,
      );
      return entries;
    })
    .catch((err: Error) => {
      if (cache) return cache.entries;
      throw err;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

async function build(): Promise<IndexedSymbol[]> {
  const meta = new Map<string, { name: string; sector: string }>();
  for (const [base, u] of UNIVERSE_BY_BASE) meta.set(base, { name: u.name, sector: u.sector });
  for (const c of allCoinIdentities()) {
    if (!meta.has(c.base)) meta.set(c.base, { name: c.displayName, sector: 'Other' });
  }

  const out = new Map<string, IndexedSymbol>();
  // Prefer the quote a trader actually uses, so "DOT" resolves to DOTUSDT
  // rather than DOTBTC/DOTEUR/DOTTRY. At most two entries per base survive:
  // the best spot leg and the perp.
  const QUOTE_RANK: Record<string, number> = { USDT: 0, USDC: 1, FDUSD: 2, BTC: 3, ETH: 4 };
  const rank = (q: string): number => QUOTE_RANK[q] ?? 9;
  const push = (base: string, quote: string, pair: string, kind: 'spot' | 'perp'): void => {
    if (!base || !quote) return;
    const key = `${base}:${kind}`;
    const existing = out.get(key);
    if (existing && rank(existing.quote) <= rank(quote)) return;
    const m = meta.get(base);
    out.set(key, {
      base,
      displayTicker: stripMultiplier(base),
      pair,
      quote,
      kind,
      name: m?.name ?? base,
      sector: m?.sector ?? 'Other',
    });
  };

  const [spot, perp] = await Promise.all([
    fetchExchangeSymbols().catch(() => [] as { base: string; quote: string; symbol: string }[]),
    fetchJson<{ symbols: { symbol: string; baseAsset: string; quoteAsset: string; status: string; contractType: string }[] }>(
      `${NETWORK.BINANCE_FUT_HOST}/fapi/v1/exchangeInfo`,
      { label: 'binance futures exchangeInfo', retries: 1, purpose: 'nonessential' },
    ).catch(() => null),
  ]);

  for (const s of spot) push(s.base, s.quote, s.symbol, 'spot');

  if (perp) {
    for (const s of perp.symbols) {
      if (s.status === 'TRADING' && s.contractType === 'PERPETUAL') {
        push(s.baseAsset, s.quoteAsset, s.symbol, 'perp');
      }
    }
  }

  return [...out.values()];
}
