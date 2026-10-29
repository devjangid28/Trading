/**
 * Universe search — ranking.
 *
 * Pure: takes the static universe entries and a query, returns ranked hits.
 * The route layer attaches live prices afterwards; ranking never needs them,
 * and unit tests never need a socket or a database.
 */

export interface SearchEntry {
  base: string;
  /** Ticker as displayed (`1000PEPE` shows as `PEPE`). */
  displayTicker: string;
  name: string;
  sector: string;
  /** Exact traded symbol, carried through ranking for the route/UI. */
  pair?: string;
  quote?: string;
  /** Which market this symbol belongs to. */
  kind?: 'spot' | 'perp';
}

export interface RankedHit extends SearchEntry {
  /** Larger is better; the route slices on this. */
  score: number;
  /** Which field matched, for the "why this result" footnote. */
  matchedOn: 'base' | 'ticker' | 'name';
}

/**
 * Score a query against one entry.
 *
 * Order matters: an exact symbol beats a prefix, a prefix beats a substring,
 * and a substring of the NAME is worth less than a substring of the SYMBOL —
 * "pepe" typed by a trader most likely means PEPE the token, not a coin whose
 * name merely contains the letters. Single-character name substrings are
 * ignored, because "a" would otherwise match half the board.
 */
export function searchEntries(query: string, entries: SearchEntry[], limit = 12): RankedHit[] {
  const q = query.trim().toUpperCase().replace(/USDT$/g, '');
  if (!q) return [];

  const ranked: RankedHit[] = [];
  for (const e of entries) {
    const base = e.base.toUpperCase();
    const ticker = e.displayTicker.toUpperCase();
    const name = e.name.toUpperCase();

    let score: number;
    let matchedOn: RankedHit['matchedOn'];
    if (base === q) {
      score = 1000; matchedOn = 'base';
    } else if (ticker === q) {
      score = 990; matchedOn = 'ticker';
    } else if (base.startsWith(q)) {
      score = 800; matchedOn = 'base';
    } else if (ticker.startsWith(q)) {
      score = 780; matchedOn = 'ticker';
    } else if (name.startsWith(q)) {
      score = 700; matchedOn = 'name';
    } else if (base.includes(q)) {
      score = 600; matchedOn = 'base';
    } else if (q.length >= 2 && name.includes(q)) {
      score = 500; matchedOn = 'name';
    } else {
      continue;
    }

    ranked.push({ ...e, score, matchedOn });
  }

  ranked.sort((a, b) =>
    b.score - a.score ||
    (a.matchedOn !== b.matchedOn ? (a.matchedOn === 'base' ? -1 : 1) : 0) ||
    // Prefer the spot market: it is what the board and the popup price track,
    // so the first hit is the one the user can actually act on.
    (a.kind === b.kind ? 0 : a.kind === 'spot' ? -1 : 1) ||
    a.base.localeCompare(b.base),
  );
  return ranked.slice(0, limit);
}