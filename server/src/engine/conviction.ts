import type {
  Candle, ChecklistTick, Conviction, ConvictionComponents, DerivRow, NewsItem,
  PickRule, Setup, VolatilityContext, MarketEvent,
} from '../../../shared/types';
import type { Grade, SizeAdvice } from '../config.js';
import { CONVICTION, VETO } from '../config.js';
import { fundingCrowdedAgainst, quadrantScore } from './derivatives.js';
import { cvdDivergence } from '../live/marketState.js';
import type { Unlock } from '../../../shared/types';
import { isUnavailable } from '../../../shared/types';

/**
 * Phase 4 â€” conviction.
 *
 * Pure function: same inputs always give the same score. That is what makes
 * the ledger meaningful â€” a signal frozen today can be re-scored identically
 * next month from its stored snapshot.
 *
 * IMPORTANT: every weight in CONVICTION.WEIGHTS is [TUNED], not fitted.
 * They are defensible starting points. They are NOT derived from outcomes.
 * `npm run fit-weights` proposes replacements once the ledger has 200+
 * resolved signals, and never applies them automatically.
 */

export interface ConvictionInput {
  symbol: string;
  side: 'bullish' | 'bearish';
  price: number;
  setup: Setup | null;
  strength: number;
  strengthPercentile: number;
  volumeUsd: number;
  choppiness: number;
  vwap: number | null;
  candles: Candle[];
  deriv: DerivRow | null;
  vol: VolatilityContext | null;
  sectorAvgChange: number | null;
  breadth: 'bullish' | 'bearish' | 'two-way';
  news: NewsItem[];
  macroRegimeScore: number;
  tradability: { bidUsd: number; askUsd: number; spreadBps: number } | null;
  events: MarketEvent[];
  now: number;
  unlocks: Unlock[];
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
/**
 * Component scores. Each returns `null` when its required input is absent -
 * NOT zero. Zero means "the data says this is bad"; null means "we do not
 * know", and conflating them is what made the board look healthy while two of
 * seven components silently scored zero.
 */
type Scored = { score: number | null; reasons: string[] };

/** Structure (25): fresh zone, proof, HTF agreement, and distance to it. */
function structureScore(i: ConvictionInput): Scored {
  const s = i.setup;
  if (!s) return { score: null, reasons: ['no valid order block'] };
  const reasons: string[] = [];
  let pts = 0;
  const max = CONVICTION.WEIGHTS.structure;

  const retestWeight: Record<string, number> = {
    fresh: 1.0, approaching: 0.9, 'in-zone': 0.85, 'retested-held': 0.6, violated: 0, none: 0,
  };
  pts += max * 0.35 * (retestWeight[s.retest] ?? 0);
  if (s.retest === 'fresh') reasons.push('zone never retested');
  if (s.retest === 'approaching') reasons.push('price within 1 ATR of the zone');
  if (s.retest === 'retested-held') reasons.push('zone already retested once');
  if (s.retest === 'violated') reasons.push('zone violated');

  if (s.fvg) {
    pts += max * 0.2;
    reasons.push('fair-value gap confirms the move was real');
  } else if (s.displacement >= 1) {
    pts += max * 0.12;
    reasons.push(`displacement ${s.displacement.toFixed(2)}x average range`);
  }

  pts += max * 0.2 * (s.htf.scoreAdj / CONVICTION.HTF_ALIGNED_BONUS);
  if (s.htf.aligned) reasons.push('5m zone sits inside a higher-timeframe zone');
  if (s.htf.conflict) {
    pts -= max * 0.15;
    reasons.push('a fresh opposite higher-timeframe zone is active');
  }

  const ad = Math.abs(s.distanceAtr);
  if (ad <= CONVICTION.DISTANCE_READY_ATR) {
    pts += max * 0.25;
    reasons.push(`${ad.toFixed(1)} ATR from the zone`);
  } else {
    pts -= Math.min(max * 0.25, (ad - CONVICTION.DISTANCE_READY_ATR) * max * 0.04);
    reasons.push(`${ad.toFixed(1)} ATR away - wait for the zone`);
  }

  return { score: clamp(pts, 0, max), reasons };
}

/** Order flow (20): CVD, taker ratio, OI/price quadrant. Needs derivatives. */
function orderFlowScore(i: ConvictionInput): Scored {
  const max = CONVICTION.WEIGHTS.orderFlow;
  const d = i.deriv;
  if (!d) return { score: null, reasons: ['no derivatives snapshot'] };

  const reasons: string[] = [];
  let pts = 0;
  const candles = i.candles.filter((c) => c.closed);
  const divergence = candles.length >= 24 ? cvdDivergence(candles) : false;
  const wantUp = i.side === 'bullish';

  if (divergence) {
    if (wantUp) reasons.push('price high without CVD confirmation');
    else { pts += max * 0.2; reasons.push('CVD divergence supports the short'); }
  } else {
    pts += max * 0.25;
  }

  const slopePositive = d.cvdSlope > 0;
  if (slopePositive === wantUp) {
    pts += max * 0.25;
    reasons.push(`CVD slope ${slopePositive ? 'positive' : 'negative'}`);
  }

  if (d.takerRatio === null || !Number.isFinite(d.takerRatio)) {
    return { score: null, reasons: ['no taker ratio'] };
  }
  const takerBuyHeavy = d.takerRatio > 0.52;
  const takerSellHeavy = d.takerRatio < 0.48;
  if ((wantUp && takerBuyHeavy) || (!wantUp && takerSellHeavy)) {
    pts += max * 0.2;
    reasons.push(`taker ${wantUp ? 'buy' : 'sell'} heavy`);
  }

  pts += max * 0.3 * quadrantScore(d.quadrant, i.side);
  if (d.quadrant === 'short-cover') reasons.push('move is short covering - weaker than new longs');
  if (d.quadrant === 'new-longs' && wantUp) reasons.push('new longs building');
  if (d.quadrant === 'new-shorts' && !wantUp) reasons.push('new shorts building');

  return { score: clamp(pts, 0, max), reasons };
}

/** Momentum and efficiency (15). Needs a real strength percentile. */
function momentumScore(i: ConvictionInput): Scored {
  const max = CONVICTION.WEIGHTS.momentum;
  if (!Number.isFinite(i.strengthPercentile)) {
    return { score: null, reasons: ['no strength percentile'] };
  }
  const reasons: string[] = [];
  let pts = max * 0.6 * (i.strengthPercentile / 100);
  if (i.strengthPercentile >= 90) {
    reasons.push(`strength in the top ${(100 - i.strengthPercentile).toFixed(0)}% of the board`);
  }
  if (i.choppiness > 70) {
    pts *= 0.5;
    reasons.push(`choppiness ${i.choppiness.toFixed(0)} - the move is not clean`);
  } else if (i.choppiness < 40) {
    reasons.push(`clean trend (choppiness ${i.choppiness.toFixed(0)})`);
  }
  return { score: clamp(pts, 0, max), reasons };
}

/** Positioning (15): funding, L/S divergence, cascades. Needs derivatives. */
function positioningScore(i: ConvictionInput): Scored {
  const max = CONVICTION.WEIGHTS.positioning;
  const d = i.deriv;
  if (!d) return { score: null, reasons: ['no derivatives snapshot'] };

  const reasons: string[] = [];
  let pts = max * 0.3;

  if (fundingCrowdedAgainst(d.fundingLabel, i.side)) {
    pts -= max * 0.5;
    reasons.push(`funding ${d.fundingLabel.toLowerCase().replace('_', ' ')} - already positioned our way`);
  } else if (d.fundingLabel === 'NEUTRAL') {
    reasons.push('funding neutral');
  } else if (d.fundingLabel === 'SQUEEZE_FUEL') {
    pts += max * 0.3;
    reasons.push('negative funding with rising OI - squeeze fuel');
  } else {
    const opposite = i.side === 'bullish' ? 'CROWDED_SHORT' : 'CROWDED_LONG';
    if (d.fundingLabel === opposite) {
      pts += max * 0.3;
      reasons.push(`funding crowded the other way - ${opposite.toLowerCase().replace('_', ' ')}`);
    }
  }

  /**
   * `fundingZ` is null until a funding history is collected. It was a
   * hardcoded 0, so `Math.abs(0) > 2.5` was never true and this penalty had
   * never fired in production — silently, because nothing recorded that the
   * input was absent. A missing input is now skipped *and said out loud*. The
   * score is unchanged: a null skips exactly as a 0 did, so the frozen
   * `[TUNED]` weights are not disturbed.
   */
  if (d.fundingZ === null) {
    reasons.push('funding z-score not computed (no funding history) - stretch penalty not applied');
  } else if (Math.abs(d.fundingZ) > 2.5) {
    pts -= max * 0.2;
    reasons.push(`funding z-score ${d.fundingZ.toFixed(1)} - stretched`);
  }

  if (d.lsDivergence !== null && Math.abs(d.lsDivergence) > 0.15) {
    const retailLong = d.longShortAccountRatio !== null && d.longShortAccountRatio > 1;
    if (i.side === 'bearish' && retailLong) {
      pts += max * 0.2;
      reasons.push('retail is long while top traders are not - contrarian');
    } else if (i.side === 'bullish' && !retailLong) {
      pts += max * 0.2;
      reasons.push('retail is flat/short while top traders are long');
    } else {
      reasons.push('long/short accounts disagree - check which side you are on');
    }
  }

  /**
   * Board rows carry no liquidation feed, so this used to read a hardcoded
   * zero bucket whose `cascade` flag was permanently false — the penalty had
   * never fired and the reason was invisible. Now the absence is explicit and
   * recorded. The score is unchanged, for the same reason as above.
   */
  if (isUnavailable(d.liq)) {
    reasons.push('no liquidation feed on this path - cascade penalty not applied');
  } else if (d.liq.cascade) {
    const adverse = i.side === 'bullish' ? d.liq.longM5 : d.liq.shortM5;
    if (adverse > 0) {
      pts -= max * 0.4;
      reasons.push('liquidation cascade hitting our side');
    }
  }

  return { score: clamp(pts, 0, max), reasons };
}

/**
 * News and events (10). "No relevant headlines" is a REAL state, not a missing
 * one - an empty news list means the asset is quiet, which is information.
 * This component is therefore never missing.
 */
function newsScore(i: ConvictionInput): Scored {
  const max = CONVICTION.WEIGHTS.newsEvents;
  const reasons: string[] = [];
  if (!i.news.length) return { score: max * 0.5, reasons: ['no relevant headlines'] };

  let net = 0;
  for (const n of i.news) {
    const recency = Math.pow(2, -((i.now - n.publishedAt) / (60 * 60_000)));
    net += n.nis * n.direction * recency;
  }
  const wantUp = i.side === 'bullish';
  const aligned = wantUp ? net > 0 : net < 0;

  const opposingCritical = i.news.find(
    (n) => n.severityClass === 'CRITICAL' && n.direction !== 0 && (wantUp ? n.direction < 0 : n.direction > 0),
  );
  if (opposingCritical) {
    return { score: 0, reasons: [`critical opposing story: ${opposingCritical.headline.slice(0, 60)}`] };
  }

  const magnitude = Math.min(1, Math.abs(net) / 400);
  const pts = max * (aligned ? 0.4 + 0.6 * magnitude : 0.4 * (1 - magnitude));
  if (aligned && magnitude > 0.3) reasons.push('news flow agrees with this side');
  return { score: clamp(pts, 0, max), reasons };
}

/**
 * Tradability (5).
 *
 * The REQUIRED input is 24h volume, which the scanner always has. Order-book
 * depth is a REFINEMENT, not a requirement — depth is popup-only by design
 * (one REST call per asset), so requiring it here made every board coin miss a
 * component and cap the whole board at grade C.
 *
 * The separate depth/spread VETO still fires when a depth snapshot IS present.
 */
function tradabilityScore(i: ConvictionInput): Scored {
  const max = CONVICTION.WEIGHTS.tradability;
  if (!Number.isFinite(i.volumeUsd) || i.volumeUsd <= 0) {
    return { score: null, reasons: ['no 24h volume'] };
  }

  const reasons: string[] = [];
  let pts = max * 0.5;
  if (i.volumeUsd > 100_000_000) {
    pts = max;
    reasons.push('deep 24h volume');
  } else if (i.volumeUsd > 20_000_000) {
    pts = max * 0.75;
    reasons.push('adequate 24h volume');
  } else {
    reasons.push(`thin 24h volume ($${(i.volumeUsd / 1e6).toFixed(0)}M)`);
  }

  // Refinement when we happen to have a book.
  const t = i.tradability;
  if (t) {
    const total = t.bidUsd + t.askUsd;
    if (total < VETO.MIN_DEPTH_USD) {
      pts *= 0.5;
      reasons.push('order book thin to exit');
    } else if (t.spreadBps <= 2) {
      pts = Math.min(max, pts * 1.1);
    }
  }
  return { score: clamp(pts, 0, max), reasons };
}

/** Macro regime (10). Derived from derivatives breadth, so missing without them. */
function macroRegimeScore(i: ConvictionInput): Scored {
  if (!i.deriv) return { score: null, reasons: ['regime needs derivatives breadth'] };
  if (!Number.isFinite(i.macroRegimeScore)) return { score: null, reasons: ['no macro regime score'] };
  return { score: clamp(i.macroRegimeScore, 0, 1) * CONVICTION.WEIGHTS.macroRegime, reasons: [] };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export function evaluateVetoes(i: ConvictionInput): string[] {
  const vetoes: string[] = [];

  // Macro blackout.
  for (const e of i.events) {
    if (!e.blackout) continue;
    const delta = i.now - e.t;
    if (Math.abs(delta) <= VETO.MACRO_BLACKOUT_MIN * 60_000) {
      vetoes.push(`inside ${VETO.MACRO_BLACKOUT_MIN}m blackout around ${e.title}`);
    }
  }

  // Event risk on size â€” a coin that has already moved an extreme amount
  // today is usually reacting to news, not setting up.
  const first = i.candles.find((c) => c.closed);
  const lastC = i.candles.at(-1);
  if (first && lastC && first.c > 0) {
    const dayMovePct = Math.abs(((lastC.c - first.c) / first.c) * 100);
    if (dayMovePct >= 14) vetoes.push(`already moved ${dayMovePct.toFixed(1)}% today â€” event risk`);
  }

  // Hack / depeg / delisting on this asset.
  const windowStart = i.now - VETO.MIN_HACK_WINDOW_H * 3600_000;
  const badNews = i.news.find(
    (n) => n.publishedAt >= windowStart &&
      (n.tags.includes('HACK_EXCHANGE_MAJOR') || n.tags.includes('DEPEG_MAJOR') ||
        n.tags.includes('DELISTING_MAJOR_EXCHANGE') || n.tags.includes('REDEMPTION_SUSPENDED')),
  );
  if (badNews) vetoes.push(`${badNews.tags[0]?.toLowerCase().replace(/_/g, ' ')} within ${VETO.MIN_HACK_WINDOW_H}h`);

  // Material unlock inside the look-ahead window, when going long.
  if (i.side === 'bullish') {
    const horizon = i.now + VETO.UNLOCK_LOOKAHEAD_H * 3600_000;
    for (const u of i.unlocks) {
      if (u.token !== i.symbol) continue;
      if (u.pct < VETO.UNLOCK_MATERIAL_PCT) continue;
      const t = Date.parse(u.date);
      if (Number.isFinite(t) && t >= i.now && t <= horizon) {
        vetoes.push(`${u.pct}% unlock${u.cliff ? ' (cliff)' : ''} within ${VETO.UNLOCK_LOOKAHEAD_H}h`);
      }
    }
  }

  // Spread or depth below tradable minimum.
  if (i.tradability) {
    if (i.tradability.bidUsd + i.tradability.askUsd < VETO.MIN_DEPTH_USD) {
      vetoes.push('order book depth below tradable minimum');
    }
    if (i.tradability.spreadBps > VETO.MAX_SPREAD_BPS) {
      vetoes.push(`spread ${i.tradability.spreadBps.toFixed(1)}bps above limit`);
    }
  }

  // Funding crowded our way AND OI falling â€” longs unwinding is worse than
  // new longs piling in.
  const d = i.deriv;
  if (d && fundingCrowdedAgainst(d.fundingLabel, i.side) && d.oiChange.h1 < 0) {
    vetoes.push('funding crowded our way while OI falls â€” positions unwinding');
  }

  return vetoes;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export function buildChecklist(i: ConvictionInput): ChecklistTick[] {
  const s = i.setup;
  const d = i.deriv;
  const wantUp = i.side === 'bullish';
  const out: ChecklistTick[] = [];

  out.push({
    key: 'zone-fresh',
    label: 'Zone fresh',
    ok: !!s && (s.retest === 'fresh' || s.retest === 'approaching' || s.retest === 'in-zone'),
    reason: s ? s.retest : 'no zone',
  });

  out.push({
    key: 'htf-aligned',
    label: 'HTF aligned',
    ok: !!s?.htf.aligned && !s.htf.conflict,
    reason: s ? (s.htf.aligned ? `aligned with ${s.htf.trend1h}/${s.htf.trend4h}` : s.htf.conflict ? 'conflicting higher timeframe' : 'no higher-timeframe agreement') : 'no zone',
  });

  out.push({
    key: 'vwap-side',
    label: 'VWAP side',
    ok: i.vwap !== null && ((wantUp && i.price > i.vwap) || (!wantUp && i.price < i.vwap)),
    reason: i.vwap === null ? 'no VWAP' : `${wantUp ? 'above' : 'below'} VWAP ${i.price > i.vwap ? 'above' : 'below'}`,
  });

  out.push({
    key: 'sector-flow',
    label: 'Sector flow',
    ok: i.sectorAvgChange !== null && (wantUp ? i.sectorAvgChange >= 0 : i.sectorAvgChange <= 0),
    reason: i.sectorAvgChange === null ? 'no sector data' : `sector ${fmtPct(i.sectorAvgChange)}`,
  });

  out.push({
    key: 'breadth-agrees',
    label: 'Breadth agrees',
    ok: i.breadth === i.side,
    reason: i.breadth === 'two-way' ? 'two-way day' : `breadth ${i.breadth}`,
  });

  out.push({
    key: 'order-flow',
    label: 'Order flow agrees',
    ok: !!d && quadrantScore(d.quadrant, i.side) >= 0.7,
    reason: d ? d.quadrantLabel : 'no derivatives data',
  });

  out.push({
    key: 'positioning-not-crowded',
    label: 'Positioning not crowded',
    ok: !d || !fundingCrowdedAgainst(d.fundingLabel, i.side),
    reason: d ? d.fundingLabel.toLowerCase().replace(/_/g, ' ') : 'no derivatives data',
  });

  const securityVeto = i.news.some(
    (n) => i.now - n.publishedAt < VETO.MIN_HACK_WINDOW_H * 3600_000 &&
      (n.tags.includes('HACK_EXCHANGE_MAJOR') || n.tags.includes('DEPEG_MAJOR')),
  );
  out.push({
    key: 'no-event-veto',
    label: 'No event veto',
    ok: !securityVeto,
    reason: securityVeto ? 'security event in the last 6h' : 'clear',
  });

  return out;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export function gradeFor(
  score: number,
  checklistScore: number,
  hasVeto: boolean,
  hasMissing = false,
): Grade {
  if (hasVeto) return 'NO TRADE';
  const G = CONVICTION.GRADES;
  // A coin with any missing component is capped at C. Grading it on a partial
  // score would be comparing a 60-point ceiling against a full 100-point scale.
  if (hasMissing) {
    return score >= G.C.minScore && checklistScore >= G.C.minChecklist ? 'C' : 'Pass';
  }
  if (score >= G.A.minScore && checklistScore >= G.A.minChecklist) return 'A';
  if (score >= G.B.minScore && checklistScore >= G.B.minChecklist) return 'B';
  if (score >= G.C.minScore && checklistScore >= G.C.minChecklist) return 'C';
  return 'Pass';
}

function fmtPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export function scoreConviction(i: ConvictionInput): Conviction {
  const vetoes = evaluateVetoes(i);

  const results = {
    structure: structureScore(i),
    orderFlow: orderFlowScore(i),
    momentum: momentumScore(i),
    positioning: positioningScore(i),
    newsEvents: newsScore(i),
    macroRegime: macroRegimeScore(i),
    tradability: tradabilityScore(i),
  };

  // A null stays null all the way through. It is never coerced to zero.
  const components: ConvictionComponents = {
    structure: nullIfMissing(results.structure),
    orderFlow: nullIfMissing(results.orderFlow),
    momentum: nullIfMissing(results.momentum),
    positioning: nullIfMissing(results.positioning),
    newsEvents: nullIfMissing(results.newsEvents),
    macroRegime: nullIfMissing(results.macroRegime),
    tradability: nullIfMissing(results.tradability),
  };

  const missing = Object.entries(components)
    .filter(([, v]) => v === null)
    .map(([k]) => k);

  const present = Object.values(components).filter((v): v is number => v !== null);
  const maxPossiblePresent = present.length
    ? Object.keys(components).reduce((a, k) => a + (MAX_WEIGHT[k] ?? 0), 0)
    : 0;
  const raw = present.reduce((a, b) => a + b, 0);

  // When components are missing the raw sum is not comparable to a full-coverage
  // score, so it is capped rather than silently penalised twice (once by the
  // missing sum, once by an implicit "that component is bad").
  const scoreIncomplete = missing.length > 0;
  const score = round1(clamp(
    scoreIncomplete ? Math.min(raw, CONVICTION.MAX_SCORE_WITH_MISSING) : raw,
    0, 100,
  ));
  void maxPossiblePresent;

  const checklist = buildChecklist(i);
  const checklistScore = checklist.filter((c) => c.ok).length;
  const grade = gradeFor(score, checklistScore, vetoes.length > 0, missing.length > 0);

  return {
    score,
    grade,
    side: i.side,
    components,
    missing,
    scoreIncomplete,
    vetoes,
    checklist,
    checklistScore,
    rule: ruleFor(grade, vetoes, i),
    isPick: false,
  };
}

function nullIfMissing(s: Scored): number | null {
  return s.score === null ? null : round1(s.score);
}

const MAX_WEIGHT: Record<string, number> = {
  structure: CONVICTION.WEIGHTS.structure,
  orderFlow: CONVICTION.WEIGHTS.orderFlow,
  momentum: CONVICTION.WEIGHTS.momentum,
  positioning: CONVICTION.WEIGHTS.positioning,
  newsEvents: CONVICTION.WEIGHTS.newsEvents,
  macroRegime: CONVICTION.WEIGHTS.macroRegime,
  tradability: CONVICTION.WEIGHTS.tradability,
};

/** The RULE chip â€” why this is or is not a pick, in OrderBlock's style. */
export function ruleFor(grade: Grade, vetoes: string[], i: ConvictionInput): PickRule {
  if (vetoes.length) return 'NOT_PICKED_VETO';
  if (grade === 'NO TRADE') return 'NOT_PICKED_NO_TRADE';
  if (grade === 'Pass' || grade === 'C') return 'NOT_PICKED_LOW_GRADE';
  if (grade === 'A' || grade === 'B') {
    // No real R:R means there is nothing to aim at.
    if (!i.setup || !i.setup.targets.length) return 'NOT_PICKED_NO_LIQUIDITY';
    return 'PICK';
  }
  return 'NOT_PICKED_LOW_GRADE';
}

/**
 * Assign the picks with the sector cap. Grade A/B only, top 3 per side,
 * max 2 from any one sector â€” the same discipline OrderBlock ships.
 */
export function assignPicks<T extends { sector: string; conviction: Conviction | null }>(
  rows: T[],
): T[] {
  const bySector = new Map<string, number>();
  let picked = 0;

  for (const row of rows) {
    const c = row.conviction;
    if (!c) continue;

    if (picked >= CONVICTION.PICKS_PER_SIDE) {
      c.rule = 'NOT_PICKED_OUTSIDE_TOP_3';
      c.isPick = false;
      continue;
    }
    if (c.rule !== 'PICK') {
      c.isPick = false;
      continue;
    }
    const used = bySector.get(row.sector) ?? 0;
    if (used >= CONVICTION.MAX_PER_SECTOR) {
      c.rule = 'NOT_PICKED_SECTOR_CAP';
      c.isPick = false;
      continue;
    }
    bySector.set(row.sector, used + 1);
    c.isPick = true;
    c.rule = 'PICK';
    picked++;
  }
  return rows;
}

export function sizeAdviceFor(
  regimeScore: number,
  blackedOut: boolean,
  leverageRisk: boolean,
): SizeAdvice {
  if (blackedOut || regimeScore < 0.3 || leverageRisk) return 'stand-aside';
  if (regimeScore < 0.6) return 'reduced';
  return 'full';
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
