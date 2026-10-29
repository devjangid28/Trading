import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  coinIdentity, upsertCoinIdentity, logoPath, logoDir, saveLogoMeta, getLogoMeta,
} from '../ledger/store.js';
import { geckoMarkets } from './coingecko.js';

/**
 * Coin identity: the real ticker, the real name, and a locally-served logo.
 *
 * WHY THIS EXISTS
 *
 * The home board used to render a two-letter monogram (`r.base.slice(0, 2)`),
 * which turned STRK into "ST" and KAIA into "KA" â€” losing the single most
 * identifying piece of information on the row. A ticker is short by design; a
 * truncation of it is not.
 *
 * RESOLUTION ORDER â€” deliberately conservative, because inventing a name is
 * worse than admitting we do not have one:
 *
 *   1. The hand-maintained universe. Authoritative for everything we trade, and
 *      it is the only source that carries a sector.
 *   2. CoinGecko `/coins/list`, cached in SQLite and refreshed at most daily.
 *   3. Nothing. The row shows the ticker alone with a "name unavailable"
 *      tooltip. Never a guess.
 *
 * AMBIGUOUS TICKERS
 *
 * A symbol like `BTC` can map to hundreds of low-cap coins on an aggregator.
 * When more than one candidate exists the highest market-cap match wins, which
 * is why `/coins/markets` (which carries market cap) is consulted ahead of
 * `/coins/list` (which does not).
 *
 * PERP RENAMES
 *
 * Exchanges prefix leveraged tokens with the multiplier (`1000PEPE`, `1000SHIB`,
 * `10000LUNA`). Those are trading symbols, not asset identities: the display
 * ticker drops the prefix and the trading symbol is kept separately. See
 * `stripMultiplier`.
 */

const REFRESH_INTERVAL_MS = 24 * 3600_000;
let lastAttempt = 0;

export interface CoinIdentity {
  base: string;
  /** What to show as the ticker. `1000PEPE` displays as `PEPE`. */
  displayTicker: string;
  /** The symbol actually traded on the venue. Kept separate from the display. */
  tradingSymbol: string;
  displayName: string;
  sector: string;
  /** Local path under /static/logos, or null when no logo is available. */
  logoUrl: string | null;
  /** Where displayName came from â€” surfaced so a wrong name is traceable. */
  source: 'universe' | 'coingecko' | 'unknown';
}

/** `1000PEPE` -> `PEPE`, but `PEPE` stays `PEPE` and `1INCH` stays `1INCH`. */
export function stripMultiplier(symbol: string): string {
  const m = /^(1000000000000|100000000000|1000000000|100000000|10000000|1000000|100000|10000|1000|100)(?=[A-Z0-9]{2,})/.exec(symbol);
  return m ? symbol.slice(m[0].length) : symbol;
}

/** Deterministic accent colour from a ticker, for the monogram fallback. */
export function monogramColor(base: string): string {
  let h = 2166136261;
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 62% 52%)`;
}

/**
 * Up to 4 letters, always a prefix of the real ticker.
 *
 * A monogram is a FALLBACK for a missing logo, never a stand-in for the
 * ticker: it uses up to four characters of the actual symbol, so a row never
 * shows a two-letter version of the coin's name.
 */
export function monogramFor(base: string): string {
  return base.slice(0, 4);
}

/** Font size that keeps a 4-letter monogram inside its tile. */
export function monogramFontSize(text: string): number {
  if (text.length <= 2) return 20;
  if (text.length === 3) return 16;
  return 12;
}

const UNIVERSE_OVERRIDE = new Map<string, string>();
export function registerIdentity(base: string, name: string, sector: string, logoUrl: string | null): void {
  UNIVERSE_OVERRIDE.set(base, name);
  void sector;
  void logoUrl;
}

/**
 * Resolve one symbol. Synchronous by design: the board renders from a scan, and
 * an identity lookup must never be the thing that makes a row late.
 */
export function resolveIdentity(base: string, universeName: string, sector: string): CoinIdentity {
  const displayTicker = stripMultiplier(base);
  const cached = coinIdentity(base);

  return {
    base,
    displayTicker,
    tradingSymbol: base,
    displayName: universeName || cached?.displayName || '',
    sector,
    logoUrl: cached?.logoUrl ?? null,
    source: universeName ? 'universe' : cached ? 'coingecko' : 'unknown',
  };
}

export function cachedIdentities(): Record<string, { displayName: string; logoUrl: string | null }> {
  const out: Record<string, { displayName: string; logoUrl: string | null }> = {};
  for (const b of ['BTC', 'ETH', 'SOL']) {
    const c = coinIdentity(b);
    if (c) out[b] = { displayName: c.displayName, logoUrl: c.logoUrl };
  }
  return out;
}

/**
 * Refresh the identity cache from CoinGecko.
 *
 * Rate-limited to one attempt per day, tolerant of failure (the board falls
 * back to the universe), and routed through the ban-aware limiter like
 * everything else â€” a 429 here must not escalate into an IP ban.
 */
export async function refreshCoinIdentities(now = Date.now()): Promise<{
  ok: boolean;
  inserted: number;
  logos: number;
  reason: string;
}> {
  if (now - lastAttempt < REFRESH_INTERVAL_MS) {
    return { ok: true, inserted: 0, logos: 0, reason: 'already refreshed within 24h' };
  }
  lastAttempt = now;

  // `/coins/markets` carries market_cap, which is what disambiguates a symbol
  // that maps to many coins. The cache is shared with the scanner's altseason
  // call, so this refresh costs at most one upstream request.
  const markets = await geckoMarkets().catch(() => []);

  if (!markets.length) {
    return {
      ok: false, inserted: 0, logos: 0,
      reason: 'CoinGecko /coins/markets returned nothing (rate limit or outage). Rows fall back to the universe file, then to the ticker alone.',
    };
  }

  let inserted = 0;
  let logos = 0;

  for (const r of markets) {
    const symbol = r.symbol.toUpperCase();
    if (!symbol || !r.name) continue;
    const displayTicker = stripMultiplier(symbol);
    upsertCoinIdentity({
      base: symbol,
      displayName: r.name,
      displayTicker,
      logoUrl: null,
      source: 'coingecko',
      marketCap: r.market_cap ?? 0,
      updatedAt: now,
    });
    inserted++;

    // Logos are downloaded once and served locally, so the browser never
    // hotlinks an aggregator and we are never exposed to its rate limit.
    if (r.image) {
      const existing = getLogoMeta(r.id);
      if (!existing) {
        const local = await downloadLogo(r.id, r.image);
        if (local) {
          saveLogoMeta({ coinId: r.id, symbol: displayTicker, file: local });
          upsertCoinIdentity({
            base: symbol, displayName: r.name, displayTicker,
            logoUrl: local, source: 'coingecko', marketCap: r.market_cap ?? 0, updatedAt: now,
          });
          logos++;
        }
      }
    }
  }

  return { ok: true, inserted, logos, reason: `${inserted} identities, ${logos} logos from CoinGecko` };
}

/**
 * Fetch one logo into the local logo directory.
 *
 * Failures are silent and non-fatal: a missing logo degrades to a monogram,
 * which is a perfectly good outcome and must never fail a scan.
 */
async function downloadLogo(coinId: string, url: string): Promise<string | null> {
  const safe = coinId.replace(/[^a-z0-9._-]/gi, '_');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 400_000) return null;

    const file = `${safe}.${extFor(url)}`;
    const dir = logoDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, file), buf);
    return logoPath(safe, `.${extFor(url)}`);
  } catch {
    return null;
  }
}

function extFor(url: string): string {
  const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(url);
  const ext = m?.[1]?.toLowerCase();
  return ext && ['png', 'svg', 'webp', 'jpg', 'jpeg'].includes(ext) ? ext : 'png';
}
