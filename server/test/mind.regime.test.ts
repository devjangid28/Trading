import { describe, it, expect } from 'vitest';
import { classifyRegime, regimeInputsFrom, type RegimeInputs } from '../src/engine/mind/index.js';
import { MIND } from '../src/config.js';
import type { Measured } from '../../shared/types';

const FIVE_MIN = 5 * 60_000;
const measured = (value: number): Measured => ({ value, at: 0 });
const absent = (): Measured => ({ value: null, at: null });

/** A market that is clearly trending up, so trend assertions are not vacuous. */
function trendingBull(): RegimeInputs {
  return {
    breadthRatio: 0.82,
    btcChangePct: 0.03,
    medianAbsChangePct: 0.02,
    liqVelocityFrac: 0.0005,
    btcDominanceShiftPp: 0.1,
    atrPercentile: 60,
    oiChange1h: 0.01,
    macroBlackoutMin: 400,
    assetChangePct: 0.04,
  };
}

describe('regime precedence — the most restrictive state wins', () => {
  it('macro blackout beats an otherwise obvious uptrend', () => {
    const v = classifyRegime({ ...trendingBull(), macroBlackoutMin: 10 });
    expect(v.regime).toBe('macro-blackout');
    expect(v.directional).toBe(false);
    expect(v.evidence[0].reading).toMatch(/tier-1 release in 10 min/);
  });

  it('a blackout already in progress is described as such', () => {
    const v = classifyRegime({ ...trendingBull(), macroBlackoutMin: -5 });
    expect(v.regime).toBe('macro-blackout');
    expect(v.evidence[0].reading).toMatch(/in progress/);
  });

  it('liquidation cascade beats a trend signal', () => {
    const v = classifyRegime({
      ...trendingBull(),
      liqVelocityFrac: MIND.REGIME_LIQ_CASCADE_USD * 2,
    });
    expect(v.regime).toBe('high-vol-cascade');
    expect(v.directional).toBe(false);
  });

  it('blackout still beats a cascade — a scheduled event is not a tape condition', () => {
    const v = classifyRegime({
      ...trendingBull(),
      macroBlackoutMin: 0,
      liqVelocityFrac: MIND.REGIME_LIQ_CASCADE_USD * 5,
    });
    expect(v.regime).toBe('macro-blackout');
  });
});

describe('trending states need participation, not just a price move', () => {
  it('BTC moving with one-sided breadth reads as trending-bull', () => {
    const v = classifyRegime(trendingBull());
    expect(v.regime).toBe('trending-bull');
    expect(v.directional).toBe(true);
  });

  it('a falling market with bearish breadth reads as trending-bear', () => {
    const v = classifyRegime({
      ...trendingBull(),
      breadthRatio: 0.15,
      btcChangePct: -0.03,
    });
    expect(v.regime).toBe('trending-bear');
  });

  it('BTC moving alone with mixed breadth does NOT read as a trend', () => {
    // 55% bullish is not one-sided, so a single asset ripping is not a trend.
    const v = classifyRegime({ ...trendingBull(), breadthRatio: 0.55 });
    expect(v.regime).not.toBe('trending-bull');
    expect(v.regime).not.toBe('trending-bear');
  });

  it('breadth one-sided but BTC flat does NOT read as a trend', () => {
    const v = classifyRegime({ ...trendingBull(), btcChangePct: 0.001 });
    expect(v.regime).not.toBe('trending-bull');
  });

  it('breadth contradicting the BTC direction does not read as trending-bull', () => {
    // BTC up sharply while only 10% of the board is bullish: the board is not
    // confirming, so calling it a bull trend would be a lie.
    const v = classifyRegime({
      ...trendingBull(),
      btcChangePct: 0.04,
      breadthRatio: 0.1,
    });
    expect(v.regime).not.toBe('trending-bull');
  });

  it('the contradiction is recorded in the evidence rather than hidden', () => {
    const v = classifyRegime({
      ...trendingBull(),
      btcChangePct: 0.04,
      breadthRatio: 0.1,
    });
    expect(v.evidence.some((e) => e.input === 'breadth vs BTC')).toBe(true);
    expect(v.evidence.find((e) => e.input === 'breadth vs BTC')!.reading).toMatch(/contradicts/);
  });
});

describe('range and quiet', () => {
  it('low energy with no BTC thrust reads as range', () => {
    const v = classifyRegime({
      ...trendingBull(),
      btcChangePct: 0.002,
      medianAbsChangePct: 0.004,
      breadthRatio: 0.5,
    });
    expect(v.regime).toBe('range');
    expect(v.directional).toBe(false);
  });

  it('nothing measured defaults to quiet and asserts no direction', () => {
    const v = classifyRegime({
      breadthRatio: null,
      btcChangePct: null,
      medianAbsChangePct: null,
      liqVelocityFrac: null,
      btcDominanceShiftPp: null,
      atrPercentile: null,
      oiChange1h: null,
      macroBlackoutMin: null,
      assetChangePct: null,
    });
    expect(v.regime).toBe('quiet');
    expect(v.directional).toBe(false);
  });

  it('missing breadth narrows the claim instead of defaulting bullish', () => {
    const v = classifyRegime({ ...trendingBull(), breadthRatio: null });
    expect(v.regime).not.toBe('trending-bull');
    expect(v.evidence.find((e) => e.input === 'breadthRatio')!.reading).toMatch(/not measured/);
  });
});

describe('evidence is always present and explains itself', () => {
  it('every verdict carries evidence for the inputs it consulted', () => {
    const v = classifyRegime(trendingBull());
    expect(v.evidence.length).toBeGreaterThan(4);
    for (const e of v.evidence) {
      expect(typeof e.reading).toBe('string');
      expect(e.reading.length).toBeGreaterThan(0);
    }
  });

  it('an unmeasured input says so rather than showing a number', () => {
    const v = classifyRegime({ ...trendingBull(), liqVelocityFrac: null });
    const liq = v.evidence.find((e) => e.input === 'liqVelocityFrac')!;
    expect(liq.value).toBeNull();
    expect(liq.reading).toMatch(/no liquidation feed/);
  });

  it('a large dominance rotation is reported without becoming its own regime', () => {
    const v = classifyRegime({
      ...trendingBull(),
      btcChangePct: 0.001,
      medianAbsChangePct: 0.03,
      breadthRatio: 0.5,
      btcDominanceShiftPp: 1.4,
    });
    const dom = v.evidence.find((e) => e.input === 'btcDominanceShiftPp')!;
    expect(dom.reading).toMatch(/rotated/);
  });
});

describe('regimeInputsFrom', () => {
  it('reads breadth and ATR off the feature vector and passes the rest through', () => {
    const features = {
      regime: { breadthRatio: measured(0.7) },
      context: { atrPercentile: absent() },
    };
    const inputs = regimeInputsFrom(features, {
      btcChangePct: 0.02,
      medianAbsChangePct: 0.01,
      liqVelocityFrac: 0.001,
      btcDominanceShiftPp: 0.1,
      oiChange1h: 0.005,
      macroBlackoutMin: 300,
      assetChangePct: 0.03,
    });
    expect(inputs.breadthRatio).toBe(0.7);
    expect(inputs.atrPercentile).toBeNull();
    expect(inputs.btcChangePct).toBe(0.02);
    expect(inputs.macroBlackoutMin).toBe(300);
  });
});

describe('is deterministic', () => {
  it('the same inputs always give the same verdict', () => {
    const a = classifyRegime(trendingBull());
    const b = classifyRegime(trendingBull());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('FIVE_MIN exists so the window maths in the fixtures stay honest', () => {
    expect(FIVE_MIN).toBe(300_000);
  });
});