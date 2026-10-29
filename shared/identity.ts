/**
 * Coin identity helpers shared by the server and the browser.
 *
 * These live in `shared/` so there is exactly ONE definition of how a ticker
 * becomes a display ticker, a monogram and a colour. The old bug — a board row
 * showing "ST" for STRK — was possible precisely because nothing stopped the
 * UI from shortening a ticker: it was free to call `slice(0, 2)` and the type
 * system had no opinion.
 */

/**
 * Leveraged tokens are prefixed with their multiplier by exchanges:
 * `1000PEPE`, `10000LUNA`, `1MBABYDOGE`. That prefix is part of the TRADING
 * SYMBOL, not the asset's identity, so it is dropped for display while
 * `base` keeps the tradable form.
 */
export function stripMultiplier(symbol: string): string {
  const m = /^(1000000000000|100000000000|1000000000|100000000|10000000|1000000|100000|10000|1000|100)(?=[A-Z0-9]{2,})/.exec(symbol);
  return m ? symbol.slice(m[0].length) : symbol;
}

/**
 * Monogram text: up to FOUR characters of the real ticker.
 *
 * Four, not two, and never a slice of the NAME. "STR" identifies a coin; "ST"
 * identifies nothing.
 */
export function monogramFor(base: string): string {
  return base.slice(0, 4);
}

/** Font size that keeps a monogram inside its tile without overflowing. */
export function monogramFontSize(text: string): number {
  if (text.length <= 2) return 20;
  if (text.length === 3) return 16;
  return 12;
}

/** Deterministic accent colour from a ticker, used for the monogram tile. */
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
 * Guard used by the UI and by the layout tests.
 *
 * A rendered "ticker" that is a two-letter prefix of a longer real symbol is
 * the exact defect this rebuild exists to remove, so it gets a predicate
 * rather than an eyeball check.
 */
export function looksTruncated(rendered: string, realTicker: string): boolean {
  const r = rendered.trim().toUpperCase();
  const t = realTicker.trim().toUpperCase();
  return t.length > 2 && r !== t && t.startsWith(r);
}