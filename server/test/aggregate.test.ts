import { describe, it, expect, beforeEach } from 'vitest';
import { buildAggregate, recordTick, __resetAggregate } from '../src/live/aggregate.js';

/**
 * The invariant the diagnostic turned into a bug: on one screen the breadth
 * chips, the depth curve and the "of N" caption used three different
 * denominators. The aggregate exists so every live number shares ONE
 * denominator — the universe size — and its three buckets always sum to it.
 */

function entry(base: string, sector: string, changePct: number, volumeUsd = 10_000_000) {
  return {
    base,
    pair: `${base}USDT`,
    sector,
    ticker: { lastPrice: 100, priceChangePercent: changePct, quoteVolume: volumeUsd },
  };
}

beforeEach(() => __resetAggregate());

describe('buildAggregate', () => {
  it('always partitions the universe: up + down + flat === n', () => {
    const entries = [
      entry('A', 'DeFi', 3),
      entry('B', 'DeFi', -2),
      entry('C', 'Other', 0),
      entry('D', 'Other', 0.5),
    ];
    const agg = buildAggregate(entries, 1);
    expect(agg.n).toBe(4);
    expect(agg.up + agg.down + agg.flat).toBe(entries.length);
    expect(agg.up).toBe(2);
    expect(agg.down).toBe(1);
    expect(agg.flat).toBe(1);
  });

  it('prefers a live tick over the 24h REST change, and counts coverage', () => {
    const entries = [entry('DOT', 'Interoperability', -5)];
    recordTick('DOTUSDT', 42, 2.5);
    const agg = buildAggregate(entries);
    expect(agg.up).toBe(1);
    expect(agg.down).toBe(0);
    expect(agg.seen).toBe(1);
  });

  it('keeps the denominator at the universe size before ticks arrive', () => {
    const entries = [entry('A', 'Other', 1), entry('B', 'Other', -1), entry('C', 'Other', 0)];
    const agg = buildAggregate(entries);
    expect(agg.n).toBe(3);
    expect(agg.up + agg.down + agg.flat).toBe(3);
    expect(agg.seen).toBe(0);
  });

  it('buckets sectors by their members and sorts strongest first', () => {
    const agg = buildAggregate([
      entry('A', 'DeFi', 4),
      entry('B', 'DeFi', 2),
      entry('C', 'Other', -3),
    ]);
    expect(agg.sectors[0].sector).toBe('DeFi');
    expect(agg.sectors[0].avgChange).toBe(3);
    expect(agg.sectors[0].n).toBe(2);
    expect(agg.sectors[1].sector).toBe('Other');
    expect(agg.sectors[1].avgChange).toBe(-3);
  });

  it('lists movers above the volume floor, largest absolute move first', () => {
    const agg = buildAggregate([
      entry('LIQUID', 'Other', 5, 10_000_000),
      entry('WILD', 'Other', -40, 10_000_000),
      entry('TINY', 'Other', 90, 100_000), // below the movers floor
    ]);
    expect(agg.movers.map((m) => m.base)).toEqual(['WILD', 'LIQUID']);
  });

  it('reports BTC and ETH from their live ticks', () => {
    recordTick('BTCUSDT', 83_000, -1.5);
    recordTick('ETHUSDT', 3_000, 0.5);
    const agg = buildAggregate([entry('BTC', 'Store of value', -1.5), entry('ETH', 'Smart contract L1', 0.5)]);
    expect(agg.btc).toEqual({ price: 83_000, changePct: -1.5 });
    expect(agg.eth).toEqual({ price: 3_000, changePct: 0.5 });
  });

  it('uses the sector "Other" for coins without metadata', () => {
    const agg = buildAggregate([entry('ZZZ', 'Other', 2)]);
    expect(agg.sectors.some((s) => s.sector === 'Other')).toBe(true);
  });
});
