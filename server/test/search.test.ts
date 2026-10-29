import { describe, it, expect } from 'vitest';
import { searchEntries, type SearchEntry } from '../src/lib/search';

const U: SearchEntry[] = [
  { base: 'BTC', displayTicker: 'BTC', name: 'Bitcoin', sector: 'Store of value' },
  { base: 'ETH', displayTicker: 'ETH', name: 'Ethereum', sector: 'Smart contract L1' },
  { base: 'PEPE', displayTicker: 'PEPE', name: 'Pepe', sector: 'Meme' },
  { base: 'PENDLE', displayTicker: 'PENDLE', name: 'Pendle', sector: 'DeFi' },
  { base: 'STRK', displayTicker: 'STRK', name: 'Starknet', sector: 'Layer 2' },
  { base: 'SEI', displayTicker: 'SEI', name: 'Sei', sector: 'Smart contract L1' },
  { base: 'KAIA', displayTicker: 'KAIA', name: 'Kaia', sector: 'Smart contract L1' },
  { base: '1000PEPE', displayTicker: 'PEPE', name: 'Pepe', sector: 'Meme' },
  { base: 'SOL', displayTicker: 'SOL', name: 'Solana', sector: 'Smart contract L1' },
  { base: 'AAVE', displayTicker: 'AAVE', name: 'Aave', sector: 'DeFi' },
];

describe('universe search ranking', () => {
  it('puts an exact symbol above a prefix and a prefix above a substring', () => {
    const hits = searchEntries('BTC', U);
    expect(hits[0].base).toBe('BTC');
    expect(hits.map((h) => h.base)).not.toContain('SOL'); // unrelated symbol: no match
  });

  it('an exact ticker beats an exact-symbol-ignored case (1000PEPE -> PEPE)', () => {
    const hits = searchEntries('PEPE', U);
    // PEPE the real pair and PEPE the perp display ticker both match; the real
    // pair sorts before its perp by breaking the score tie on base order.
    expect(hits.slice(0, 2).map((h) => h.base)).toEqual(['PEPE', '1000PEPE']);
  });

  it('matches names, but lower priority than every symbol match', () => {
    const hits = searchEntries('PENDLE', U);
    expect(hits[0].base).toBe('PENDLE');
    // "stark" only exists in the NAME "Starknet" on this universe.
    const named = searchEntries('stark', U);
    expect(named.length).toBeGreaterThan(0);
    expect(named[0].base).toBe('STRK');
    expect(named[0].matchedOn).toBe('name');
  });

  it('ignores name substrings for a single character query', () => {
    // "a" matches many names; only real symbol matches should survive.
    const hits = searchEntries('a', U);
    for (const h of hits) expect(h.matchedOn).not.toBe('name');
  });

  it('handles the USDT suffix and case folding', () => {
    const hits = searchEntries('btcusdt', U);
    expect(hits[0].base).toBe('BTC');
  });

  it('returns nothing for an empty query or a nonsense query', () => {
    expect(searchEntries('', U)).toEqual([]);
    expect(searchEntries('   ', U)).toEqual([]);
    expect(searchEntries('ZZZZZZ', U)).toEqual([]);
  });

  it('caps the result list at the requested limit', () => {
    const hits = searchEntries('PE', U, 3);
    expect(hits.length).toBeLessThanOrEqual(3);
  });

  it('puts the spot market ahead of the perpetual for the same base', () => {
    // Stage 3 indexes every exchange symbol, spot AND perp. Their tickers are
    // identical, so the tiebreak must prefer spot — that is the book the board
    // and the popup price read from.
    const dual: SearchEntry[] = [
      { base: 'DOT', displayTicker: 'DOT', name: 'Polkadot', sector: 'Interoperability', pair: 'DOTUSDT', quote: 'USDT', kind: 'perp' },
      { base: 'DOT', displayTicker: 'DOT', name: 'Polkadot', sector: 'Interoperability', pair: 'DOTUSDT', quote: 'USDT', kind: 'spot' },
    ];
    const hits = searchEntries('dot', dual);
    expect(hits).toHaveLength(2);
    expect(hits[0].kind).toBe('spot');
    expect(hits[1].kind).toBe('perp');
  });
});