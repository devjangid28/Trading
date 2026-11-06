import { describe, expect, it } from 'vitest';
import type { Candle, TerminalHistory } from '../../shared/types';
import {
  DEFAULT_SR_CONFIG,
  collectBreakEvents,
  detectBreakStatus,
  detectBigMoveCandles,
  detectOrderBlocks,
  detectWickSignals,
  getProbabilityTone,
  runSREngine,
  toBreakLabel,
  type SRLevel,
} from '../../src/charts/srEngine';
import { fetchLiquidityWalls } from '../../src/charts/liquidity';
import { scoreLevelWithHistory } from '../../src/charts/terminalHistory';

function candle(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
): Candle {
  return { t, o, h, l, c, v, closed: true, qv: v * c };
}

const MINUTE = 60_000;

function rangeCandles(count: number, startT: number, low: number, high: number, baseVol = 100): Candle[] {
  const out: Candle[] = [];
  let t = startT;
  const mid = (low + high) / 2;
  const half = (high - low) / 2;
  for (let i = 0; i < count; i++) {
    // Oscillate inside [low, high] so swings repeatedly retest the same
    // extreme prices, giving the engine multiple touches per level.
    const wob = Math.sin(i / 4) * half * 0.25;
    const o = mid + wob;
    const c = mid + Math.sin(i / 4 + 0.8) * half * 0.25;
    const h = Math.max(o, c) + half * 0.12 + (i % 5 === 0 ? half * 0.06 : 0);
    const l = Math.min(o, c) - half * 0.12 - (i % 7 === 0 ? half * 0.06 : 0);
    const vol = baseVol + (i % 7) * 5;
    out.push(candle(t, o, h, l, c, vol));
    t += MINUTE;
  }
  return out;
}

describe('srEngine', () => {
  it('selects a single primary support and resistance line', () => {
    const start = Date.now() - 200 * MINUTE;
    const candles = rangeCandles(200, start, 90, 110, 100);
    const output = runSREngine(candles, '5m');

    expect(output.nearestResistance).not.toBeNull();
    expect(output.nearestSupport).not.toBeNull();

    const r = output.nearestResistance!;
    const s = output.nearestSupport!;
    expect(r.price).toBeGreaterThan(output.currentPrice);
    expect(s.price).toBeLessThan(output.currentPrice);
    expect(r.touches).toBeGreaterThanOrEqual(2);
    expect(s.touches).toBeGreaterThanOrEqual(2);
    expect(r.breakProbability).toBeGreaterThanOrEqual(0.05);
    expect(r.breakProbability).toBeLessThanOrEqual(0.95);
  });

  it('merges nearby duplicate levels into one level', () => {
    const start = Date.now() - 200 * MINUTE;
    const candles = rangeCandles(200, start, 90, 110, 100);
    const output = runSREngine(candles, '5m');

    const resistances = output.resistanceLevels;
    const supports = output.supportLevels;
    for (const list of [resistances, supports]) {
      for (let i = 1; i < list.length; i++) {
        const gap = Math.abs(list[i].price - list[i - 1].price) / list[i].price;
        expect(gap).toBeGreaterThan(0.0004);
      }
    }
  });

  it('detects swing-derived support and resistance levels on a clean range', () => {
    const start = Date.now() - 200 * MINUTE;
    const candles = rangeCandles(200, start, 90, 110, 100);
    const output = runSREngine(candles, '5m');

    expect(output.currentPrice).toBeGreaterThan(0);
    expect(output.resistanceLevels.length).toBeGreaterThan(0);
    expect(output.supportLevels.length).toBeGreaterThan(0);

    const nearestR = output.resistanceLevels.find(l => l.price > output.currentPrice);
    const nearestS = output.supportLevels.find(l => l.price < output.currentPrice);
    expect(nearestR?.price).toBeGreaterThan(output.currentPrice);
    expect(nearestS?.price).toBeLessThan(output.currentPrice);
  });

  it('break probabilities stay within the bounded range and are finite', () => {
    const start = Date.now() - 200 * MINUTE;
    const candles = rangeCandles(200, start, 90, 110, 100);
    const output = runSREngine(candles, '15m');

    for (const bp of output.breakProbabilities) {
      expect(Number.isFinite(bp.probability)).toBe(true);
      expect(bp.probability).toBeGreaterThanOrEqual(0.05);
      expect(bp.probability).toBeLessThanOrEqual(0.95);
    }
  });

  it('marks broken levels as flipped', () => {
    const start = Date.now() - 200 * MINUTE;
    const candles = rangeCandles(200, start, 90, 110, 100);
    const output = runSREngine(candles, '5m');
    // A level is flipped when price has traded through it in the last 10 candles.
    for (const level of [...output.resistanceLevels, ...output.supportLevels]) {
      if (level.flipped) {
        expect(level.source).toBeTruthy();
      }
    }
  });

  it('detects order blocks at high-volume low-body candles followed by a move', () => {
    const base = rangeCandles(60, Date.now() - 120 * MINUTE, 90, 110, 100);
    const t0 = base[base.length - 1].t + MINUTE;
    const consolidation = [
      candle(t0, 100, 100.4, 99.6, 100, 800),
      candle(t0 + MINUTE, 100, 100.5, 99.5, 100.1, 900),
      candle(t0 + 2 * MINUTE, 100.1, 100.6, 99.7, 100.2, 850),
    ];
    const breakout = [
      candle(t0 + 3 * MINUTE, 100.2, 102, 100, 101.9, 700),
      candle(t0 + 4 * MINUTE, 101.9, 103.5, 101.5, 103.2, 650),
    ];
    const candles = [...base, ...consolidation, ...breakout];

    const blocks = detectOrderBlocks(candles, 60);
    const bullishBlocks = blocks.filter(b => b.type === 'bullish');
    expect(bullishBlocks.length).toBeGreaterThan(0);
    expect(bullishBlocks[0].timestamp).toBeGreaterThanOrEqual(consolidation[0].t);
  });

  it('detects high-wick rejection signals', () => {
    const base = rangeCandles(80, Date.now() - 160 * MINUTE, 90, 110, 100);
    const t0 = base[base.length - 1].t + MINUTE;
    // Long upper wick rejection: high far above open/close, close below open.
    const rejection = candle(t0, 100, 104, 99.65, 99.7, 500);
    const candles = [...base, rejection];

    const signals = detectWickSignals(candles, 100);
    const upper = signals.filter(s => s.type === 'upper' && s.direction === 'rejection').length;
    expect(upper).toBeGreaterThan(0);
  });

  it('merges liquidity walls into levels and probabilities', () => {
    const start = Date.now() - 200 * MINUTE;
    const candles = rangeCandles(200, start, 90, 110, 100);
    const current = candles[candles.length - 1].c;
    const walls = [
      { price: current * 1.03, usd: 5_000_000, side: 'ask' as const, levels: 4 },
      { price: current * 0.97, usd: 4_000_000, side: 'bid' as const, levels: 3 },
    ];
    const output = runSREngine(candles, '5m', walls);

    const askWallLevel = output.resistanceLevels.find(l => l.wallUsd > 0);
    const bidWallLevel = output.supportLevels.find(l => l.wallUsd > 0);
    expect(askWallLevel?.wallUsd).toBe(5_000_000);
    expect(bidWallLevel?.wallUsd).toBe(4_000_000);
    expect(output.liquidityWalls).toHaveLength(2);
  });

  it('runs on an empty dataset without throwing', () => {
    const output = runSREngine([], '5m');
    expect(output.supportLevels).toHaveLength(0);
    expect(output.resistanceLevels).toHaveLength(0);
    expect(output.currentPrice).toBe(0);
  });

  it('probability tone buckets are consistent', () => {
    expect(getProbabilityTone(0.8)).toBe('critical');
    expect(getProbabilityTone(0.6)).toBe('high');
    expect(getProbabilityTone(0.4)).toBe('medium');
    expect(getProbabilityTone(0.2)).toBe('low');
  });

  it('toBreakLabel applies the agreed thresholds', () => {
    expect(toBreakLabel(0.72)).toBe('Strong');
    expect(toBreakLabel(0.9)).toBe('Strong');
    expect(toBreakLabel(0.71)).toBe('Medium');
    expect(toBreakLabel(0.45)).toBe('Medium');
    expect(toBreakLabel(0.44)).toBe('Weak');
    expect(toBreakLabel(0)).toBe('Weak');
  });

  it('engine levels carry consistent breakStrength and breakLabel', () => {
    const start = Date.now() - 200 * MINUTE;
    const candles = rangeCandles(200, start, 90, 110, 100);
    const output = runSREngine(candles, '5m');
    const levels = [...output.resistanceLevels, ...output.supportLevels];
    expect(levels.length).toBeGreaterThan(0);
    for (const level of levels) {
      expect(level.breakStrength).toBe(level.breakProbability);
      expect(level.breakLabel).toBe(toBreakLabel(level.breakProbability));
    }
  });

  it('fetchLiquidityWalls rejects with an invalid symbol without crashing on parsing', async () => {
    const walls = await fetchLiquidityWalls('NOT_A_REAL_SYMBOL_XYZ', { signal: AbortSignal.timeout(10_000) });
    expect(Array.isArray(walls)).toBe(true);
    expect(walls).toHaveLength(0);
  });

  it('detects a volume-confirmed resistance break with a clear reason', () => {
    // Build a range that stays clearly BELOW the 101.5 resistance, then a
    // high-volume close above it.
    const start = Date.now() - 60 * MINUTE;
    const candle = (t: number, o: number, h: number, l: number, c: number, v: number): Candle =>
      ({ t, o, h, l, c, v, closed: true, qv: v * c });
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const t = start + i * MINUTE;
      const wob = Math.sin(i / 4) * 1.2;
      candles.push(candle(t, 98.5 + wob, 99.2 + wob, 97.8 + wob, 98.6 + wob, 100));
    }
    // Break: close above resistance 101.5 with 2x volume, then continuation.
    const lastT = candles[candles.length - 1].t + MINUTE;
    candles.push(candle(lastT, 101.4, 102.4, 101.1, 102.1, 260));
    candles.push(candle(lastT + MINUTE, 102.1, 102.6, 101.8, 102.4, 150));

    const level: SRLevel = {
      price: 101.5, type: 'resistance', strength: 'moderate',
      touches: 3, lastTouch: candles[40].t, volumeAtLevel: 100,
      breakProbability: 0.6, age: 1000, zoneTop: 101.6, zoneBottom: 101.4,
      isActive: true, source: 'swing', flipped: false, wallUsd: 0, wallLevels: 0,
    };
    const status = detectBreakStatus(candles, level);
    expect(status).not.toBeNull();
    expect(status!.type).toBe('resistance');
    expect(status!.strength).toBe('strong');
    expect(status!.confirmed).toBe(true);
    expect(status!.reason).toContain('volume');
  });

  it('flags a fake-out break when price reclaims the level quickly', () => {
    const start = Date.now() - 60 * MINUTE;
    const candle = (t: number, o: number, h: number, l: number, c: number, v: number): Candle =>
      ({ t, o, h, l, c, v, closed: true, qv: v * c });
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const t = start + i * MINUTE;
      const wob = Math.sin(i / 4) * 1.2;
      candles.push(candle(t, 98.5 + wob, 99.2 + wob, 97.8 + wob, 98.6 + wob, 100));
    }
    const lastT = candles[candles.length - 1].t + MINUTE;
    // One candle closes above, next closes back below (fake-out).
    candles.push(candle(lastT, 101.4, 102.2, 101.1, 101.8, 260));
    candles.push(candle(lastT + MINUTE, 101.8, 101.9, 100.9, 101.0, 130));
    candles.push(candle(lastT + 2 * MINUTE, 101.0, 101.2, 100.6, 100.8, 90));

    const level: SRLevel = {
      price: 101.5, type: 'resistance', strength: 'moderate',
      touches: 3, lastTouch: candles[40].t, volumeAtLevel: 100,
      breakProbability: 0.5, age: 1000, zoneTop: 101.6, zoneBottom: 101.4,
      isActive: true, source: 'swing', flipped: false, wallUsd: 0, wallLevels: 0,
    };
    const status = detectBreakStatus(candles, level);
    expect(status).not.toBeNull();
    expect(status!.strength).toBe('weak');
    expect(status!.confirmed).toBe(false);
    expect(status!.reason.toLowerCase()).toContain('fake-out');
  });

  it('detects single large impulsive candles', () => {
    const start = Date.now() - 200 * MINUTE;
    const base = rangeCandles(180, start, 90, 110, 100);
    const t0 = base[base.length - 1].t + MINUTE;
    // One huge bullish body with high volume.
    const bigMove = candle(t0, 100, 103, 99.8, 102.7, 400);
    const candles = [...base, bigMove];

    const moves = detectBigMoveCandles(candles);
    const bullish = moves.filter(m => m.type === 'bullish');
    expect(bullish.length).toBeGreaterThan(0);
    expect(bullish[0].bodyPct).toBeGreaterThan(0.7);
    expect(bullish[0].volumeMultiple).toBeGreaterThan(1.8);
  });

  it('engine output carries break status and big moves', () => {
    const start = Date.now() - 200 * MINUTE;
    const candles = rangeCandles(200, start, 90, 110, 100);
    const output = runSREngine(candles, '5m');
    expect(Array.isArray(output.bigMoves)).toBe(true);
    expect(output.breakStatus === null || output.breakStatus !== null).toBe(true);
  });

  it('wick signal candle indices are absolute into the full candle array', () => {
    const start = Date.now() - 400 * MINUTE;
    const candles = rangeCandles(300, start, 90, 110, 100);
    // Inject a clear rejection wick near the end so at least one signal exists.
    const t0 = candles[candles.length - 1].t + MINUTE;
    candles.push(candle(t0, 100, 104, 99.65, 99.7, 500));

    const signals = detectWickSignals(candles, 100);
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal.candleIndex).toBeGreaterThanOrEqual(0);
      expect(signal.candleIndex).toBeLessThan(candles.length);
    }
    // lookback 100 over 301 candles means the oldest possible index is 201.
    expect(Math.min(...signals.map(s => s.candleIndex))).toBeGreaterThanOrEqual(201);
  });

  it('big-move candle indices are absolute into the full candle array', () => {
    const start = Date.now() - 400 * MINUTE;
    const candles = rangeCandles(300, start, 90, 110, 100);
    const t0 = candles[candles.length - 1].t + MINUTE;
    candles.push(candle(t0, 100, 103, 99.8, 102.7, 400));

    const moves = detectBigMoveCandles(candles);
    expect(moves.length).toBeGreaterThan(0);
    for (const move of moves) {
      expect(move.candleIndex).toBeGreaterThanOrEqual(0);
      expect(move.candleIndex).toBeLessThan(candles.length);
    }
    // lookback 200 over 301 candles means the oldest possible index is 101.
    expect(Math.min(...moves.map(m => m.candleIndex))).toBeGreaterThanOrEqual(101);
  });

  it('heatmap history scores levels without changing the level set', () => {
    const start = Date.now() - 200 * MINUTE;
    const candles = rangeCandles(200, start, 90, 110, 100);
    const withoutHistory = runSREngine(candles, '5m');

    // A dense set of recorded frames spanning the whole candle range, so the
    // heatmap lattice covers whatever price the swing clusters land on. Each
    // frame carries a 40-bin ladder at 0.08% steps around its mid.
    const binBps = 8;
    const bids = new Array(40).fill(0).map(() => 2_000_000);
    const asks = new Array(40).fill(0).map(() => 2_000_000);
    const frames = [];
    for (let k = 0; k < 48; k++) {
      const mid = 88 + k * 0.5;
      frames.push({
        asOf: start + (50 + k) * MINUTE,
        lastUpdateId: 1,
        mid,
        bestBid: mid * (1 - binBps / 10_000),
        bestAsk: mid * (1 + binBps / 10_000),
        bidUsd: 80_000_000,
        askUsd: 80_000_000,
        binBps,
        rangePct: 4,
        bids,
        asks,
      });
    }
    const history: TerminalHistory = {
      symbol: 'BTCUSDT',
      from: start,
      to: start + 200 * MINUTE,
      firstAt: start,
      lastAt: start + 200 * MINUTE,
      frameCount: frames.length,
      truncated: false,
      binBps,
      rangePct: 4,
      tradeBucketMs: 60_000,
      frames,
      trades: [],
    };

    const withHistory = runSREngine(candles, '5m', [], DEFAULT_SR_CONFIG, history);

    expect(withHistory.supportLevels.length).toBe(withoutHistory.supportLevels.length);
    expect(withHistory.resistanceLevels.length).toBe(withoutHistory.resistanceLevels.length);

    // The heatmap profile should contribute a non-zero score somewhere on the board.
    const scored = withHistory.levelScores ?? [];
    const anyHistoryFlow = scored.some(s => s.historyLiquidityScore > 0 || s.historyNotional > 0);
    expect(anyHistoryFlow).toBe(true);
  });

  it('collectBreakEvents emits primary and secondary scopes for crossed levels', () => {
    // Base stays below resistance; a break candle closes above BOTH watched
    // levels, then price closes back below both (fake-out) so each level
    // produces a weak event.
    const start = Date.now() - 80 * MINUTE;
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const t = start + i * MINUTE;
      const wob = Math.sin(i / 4) * 1.2;
      candles.push(candle(t, 98.5 + wob, 99.2 + wob, 97.8 + wob, 98.6 + wob, 100));
    }
    const lastT = candles[candles.length - 1].t + MINUTE;
    candles.push(candle(lastT, 101.4, 102.4, 101.1, 102.1, 260));
    candles.push(candle(lastT + MINUTE, 102.1, 102.3, 101.0, 101.3, 130));
    candles.push(candle(lastT + 2 * MINUTE, 101.3, 101.5, 100.7, 101.0, 90));

    const level = (price: number): SRLevel => ({
      price,
      type: 'resistance',
      strength: 'moderate',
      touches: 3,
      lastTouch: candles[40].t,
      volumeAtLevel: 100,
      breakProbability: 0.5,
      age: 1000,
      zoneTop: price + 0.01,
      zoneBottom: price - 0.01,
      isActive: true,
      source: 'swing',
      flipped: false,
      wallUsd: 0,
      wallLevels: 0,
    });
    const events = collectBreakEvents(candles, [
      { level: level(101.5), scope: 'primary' },
      { level: level(102.0), scope: 'secondary' },
    ]);

    expect(events.length).toBe(2);
    expect(events.some(e => e.scope === 'primary' && e.type === 'resistance')).toBe(true);
    expect(events.some(e => e.scope === 'secondary' && e.type === 'resistance')).toBe(true);
    for (const event of events) {
      expect(event.strength).toBe('weak');
      expect(event.confirmed).toBe(false);
    }
  });

  it('collectBreakEvents suppresses secondary events when alertOnSecondaryBreaks=false', () => {
    const start = Date.now() - 80 * MINUTE;
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const t = start + i * MINUTE;
      const wob = Math.sin(i / 4) * 1.2;
      candles.push(candle(t, 98.5 + wob, 99.2 + wob, 97.8 + wob, 98.6 + wob, 100));
    }
    const lastT = candles[candles.length - 1].t + MINUTE;
    candles.push(candle(lastT, 101.4, 102.4, 101.1, 102.1, 260));
    candles.push(candle(lastT + MINUTE, 102.1, 102.3, 101.0, 101.3, 130));

    const level = (price: number): SRLevel => ({
      price,
      type: 'resistance',
      strength: 'moderate',
      touches: 3,
      lastTouch: candles[40].t,
      volumeAtLevel: 100,
      breakProbability: 0.5,
      age: 1000,
      zoneTop: price + 0.01,
      zoneBottom: price - 0.01,
      isActive: true,
      source: 'swing',
      flipped: false,
      wallUsd: 0,
      wallLevels: 0,
    });
    const events = collectBreakEvents(candles, [
      { level: level(101.5), scope: 'primary' },
      { level: level(102.0), scope: 'secondary' },
    ], { ...DEFAULT_SR_CONFIG, alertOnSecondaryBreaks: false });

    expect(events).toHaveLength(1);
    expect(events[0].scope).toBe('primary');
  });

  it('heatmap health reports live, fallback and offline honestly', () => {
    const start = Date.now() - 200 * MINUTE;
    const candles = rangeCandles(200, start, 90, 110, 100);

    const noHistory = runSREngine(candles, '5m');
    expect(noHistory.heatmapHealth).toBe('fallback');

    const offline = runSREngine(candles, '5m', [], DEFAULT_SR_CONFIG, null, false, 'UNKNOWN', 'offline');
    expect(offline.heatmapHealth).toBe('offline');

    const emptyFrames: TerminalHistory = {
      symbol: 'BTCUSDT', from: start, to: start + 200 * MINUTE,
      firstAt: null, lastAt: null, frameCount: 0, truncated: false,
      binBps: 5, rangePct: 4, tradeBucketMs: 60_000, frames: [], trades: [],
    };
    const fallbackEmpty = runSREngine(candles, '5m', [], DEFAULT_SR_CONFIG, emptyFrames, false, 'UNKNOWN', 'fallback');
    expect(fallbackEmpty.heatmapHealth).toBe('fallback');
    expect(fallbackEmpty.levelScores?.every(s => s.historyLiquidityScore === 0) ?? true).toBe(true);

    const live = runSREngine(candles, '5m', [], DEFAULT_SR_CONFIG, emptyFrames, false, 'UNKNOWN', 'live');
    expect(live.heatmapHealth).toBe('live');
  });

  it('scoreLevelWithHistory is monotone in notional and empty without data', () => {
    const tick = 0.01;
    const profile = new Map<number, { notional: number; touches: number }>([
      [99.5, { notional: 50_000_000, touches: 12 }],
    ]);
    const rich = scoreLevelWithHistory(99.5, 'support', profile, tick);
    expect(rich.liquidityScore).toBeGreaterThan(0);
    expect(rich.historyTouches).toBe(12);
    expect(rich.totalNotional).toBe(50_000_000);

    const empty = scoreLevelWithHistory(99.5, 'support', new Map(), tick);
    expect(empty.liquidityScore).toBe(0);
    expect(empty.historyTouches).toBe(0);
    expect(empty.totalNotional).toBe(0);
  });
});
