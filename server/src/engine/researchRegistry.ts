/**
 * The research registry — Phase XVI step 3.
 *
 * The engine's philosophy, stated as code: **books, papers, trading lore and
 * vendor methodologies are hypotheses, not rules.**
 *
 * Every one of those ideas can produce a measurable, repeatable, cost-honest
 * edge, or it cannot. The question is never "is this a famous concept?" — it is
 * "does this produce an edge in THIS market, in THIS regime, AFTER fees and
 * slippage?"
 *
 * So this file contains NO trading logic. It contains declarations: what the
 * claim is, what measurable feature would express it, what we expect, how it
 * would be tested, and — critically — that its current status is `proposed`.
 *
 * **Everything in `IMPLEMENTED` is `proposed` or `testing`. Nothing is
 * `accepted`.** That is the truthful state: at 7 Mind-tagged resolved signals no
 * hypothesis in this file has been tested to a standard that would justify
 * changing a weight. Marking any of them `accepted` would be the exact failure
 * mode Phase XVI exists to prevent.
 *
 * The registry is data, deliberately. It is imported by the report scripts and
 * the UI, and it has no side effects, so it cannot influence a decision by being
 * merely loaded.
 */

import { LEDGER } from '../config.js';

export type SourceType =
  | 'book'
  | 'paper'
  | 'exchange-docs'
  | 'market-data'
  | 'practitioner'
  | 'internal-experiment';

export type ResearchStatus =
  | 'proposed'
  | 'testing'
  | 'accepted'
  | 'rejected'
  | 'inconclusive'
  | 'deprecated';

export type Direction = 'bullish' | 'bearish' | 'conditional' | 'regime-dependent';

export interface ResearchEvidence {
  /** Result on the data used to develop the idea. Never a headline. */
  in_sample: EvidenceCell;
  /** Result on data never used to develop it. */
  out_of_sample: EvidenceCell;
  /** Result from expanding-window forward testing. */
  walk_forward: EvidenceCell;
  /** The same result after fees, funding and slippage. */
  cost_adjusted: EvidenceCell;
  /** Per-regime results. An edge in one regime is not an edge. */
  regime_breakdown: Record<string, EvidenceCell>;
}

export interface EvidenceCell {
  /** Null whenever the cell has not been measured. Never 0 as a stand-in. */
  samples: number | null;
  netExpectancyR: number | null;
  brierSkill: number | null;
  verdict: 'not-run' | 'pending' | 'pass' | 'fail' | 'inconclusive';
  /** Which sample floor governed this cell. */
  floor: number;
}

const NOT_RUN = (floor: number): EvidenceCell => ({
  samples: null,
  netExpectancyR: null,
  brierSkill: null,
  verdict: 'not-run',
  floor,
});

export interface ResearchEntry {
  id: string;
  title: string;
  source: string;
  source_type: SourceType;
  claim: string;
  market: 'crypto' | 'indian-equity' | 'both';
  hypothesis: string;
  feature_or_rule: string;
  expected_effect: string;
  direction: Direction;
  test_design: string;
  minimum_sample_size: number;
  status: ResearchStatus;
  evidence: ResearchEvidence;
  decision: string;
  decision_date: string | null;
  rollback: string;
}

/**
 * The floor for accepting ANY weight change.
 *
 * `LEDGER.FIT_MIN_SIGNALS = 200` is the engine's existing figure. Phase XVI
 * additionally requires a per-GRADE floor before the A>B>C ordering can be
 * claimed, which is why this registry never asserts an ordering.
 */
export const MIN_SAMPLE_FOR_ACCEPTANCE = LEDGER.FIT_MIN_SIGNALS;

/** Per-grade floor, separate from the overall one. A grade with 12 samples is not a rate. */
export const MIN_SAMPLE_PER_GRADE = LEDGER.FIT_MIN_SIGNALS;

function pending(floor = MIN_SAMPLE_FOR_ACCEPTANCE): EvidenceCell {
  return { ...NOT_RUN(floor), verdict: 'pending' };
}

function emptyEvidence(): ResearchEvidence {
  return {
    in_sample: pending(),
    out_of_sample: pending(),
    walk_forward: pending(),
    cost_adjusted: pending(),
    regime_breakdown: {
      'trend-up': pending(),
      'trend-down': pending(),
      range: pending(),
      'high-volatility-expansion': pending(),
      'risk-off': pending(),
    },
  };
}

function entry(e: Omit<ResearchEntry, 'evidence' | 'decision' | 'decision_date' | 'rollback' | 'status'> & {
  status?: ResearchStatus;
}): ResearchEntry {
  return {
    ...e,
    status: e.status ?? 'proposed',
    evidence: emptyEvidence(),
    decision: 'No decision. Not yet tested to a standard that would justify changing a weight.',
    decision_date: null,
    rollback:
      'Nothing to roll back — this hypothesis has not been promoted to a rule, so no live behaviour depends on it.',
  };
}

/**
 * The candidate tracks from the brief, formalised.
 *
 * `implementedAs` is deliberately NOT here: several of these ideas ARE partly in
 * the engine (order blocks, displacement, VWAP context, funding crowding), which
 * is exactly why they need registry entries — an idea that shipped without one is
 * an untracked rule, and that is how a thesis becomes folklore. Those are marked
 * `status: 'testing'` with the existing behaviour named, so the dependency is
 * visible.
 */
export const RESEARCH_REGISTRY: ResearchEntry[] = [
  entry({
    id: 'RES-001',
    title: 'Order blocks and displacement',
    source: 'Order-block / ICT literature; also the engine\'s own Phase 1 detector',
    source_type: 'book',
    claim: 'A zone formed before a strong directional move is more likely to be retested and to produce continuation in the direction of that move.',
    market: 'both',
    hypothesis:
      'Zones with measured displacement above the local ATR, that have NOT yet been violated, produce higher net expectancy than zones without displacement.',
    feature_or_rule: 'setup.displacementX, setup.retest, setup.fvg — all already frozen in the FeatureVector',
    expected_effect: 'Positive net expectancy, concentrated in trending regimes and absent in ranges',
    direction: 'conditional',
    test_design:
      'Walk-forward on frozen records. Group by displacement bucket × retest state. Compare net expectancy against the pooled base rate, cost-adjusted, per regime.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
    status: 'testing',
  }),
  entry({
    id: 'RES-002',
    title: 'Fair-value gaps as continuation vs exhaustion evidence',
    source: 'Order-flow practitioner literature',
    source_type: 'practitioner',
    claim: 'An unfilled FVG after a displacement tends to act as continuation support, but a deeply nested FVG may instead mark exhaustion.',
    market: 'crypto',
    hypothesis:
      'FVGs NOT nested inside a higher-timeframe zone behave as continuation; nested FVGs do not.',
    feature_or_rule: 'structure.fvg and structure.fvgInsideHtfOb — the second is currently honest null because Setup.fvg carries no price bounds',
    expected_effect: 'Continuation effect positive when unnested; neutral or negative when nested',
    direction: 'conditional',
    test_design:
      'Requires fvgInsideHtfOb to be measurable first, which needs price bounds on the FVG. Until then this hypothesis is NOT TESTABLE — recorded so the gap is explicit.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
  }),
  entry({
    id: 'RES-003',
    title: 'Liquidity sweeps and stop-run reversals',
    source: 'ICT / Wyckoff practitioner literature',
    source_type: 'practitioner',
    claim: 'A sweep of an equal high or low followed by a close back inside the prior range marks exhaustion.',
    market: 'both',
    hypothesis:
      'Setups whose retest state is `violated` — price took the level and closed back — outperform those that never swept it.',
    feature_or_rule: 'setup.retest === violated, structure.liqPoolDistFrac, previous[] (equal highs/lows)',
    expected_effect: 'Higher win rate on sweep setups, but lower R:R because entry is worse',
    direction: 'bullish',
    test_design: 'Group by setupType tag `sweep-reversal`. Compare net expectancy, not win rate alone — a worse entry must pay for itself.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
    status: 'testing',
  }),
  entry({
    id: 'RES-004',
    title: 'Equal highs and lows as liquidity pools',
    source: 'ICT / market-structure literature',
    source_type: 'practitioner',
    claim: 'Repeatedly tested highs collect resting stops, so a run at an equal high is more likely to be violent.',
    market: 'crypto',
    hypothesis:
      'Targets placed at equal highs/lows are reached more often than targets placed at arbitrary round numbers.',
    feature_or_rule: 'setup.targets[].kind === liquidity, structure.liqPoolDistFrac',
    expected_effect: 'Higher target-hit rate at liquidity pools',
    direction: 'conditional',
    test_design: 'Compare target-hit rate by target kind, per regime.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
  }),
  entry({
    id: 'RES-005',
    title: 'VWAP mean reversion vs trend continuation',
    source: 'Intraday trading practice; exchange market-data documentation',
    source_type: 'market-data',
    claim: 'VWAP acts as support in trends and as a mean-reversion level in ranges.',
    market: 'crypto',
    hypothesis:
      'A bullish setup ABOVE session VWAP outperforms the same setup below it in trending regimes, and the relationship INVERTS in ranges.',
    feature_or_rule: 'structure.vwapDistFrac and vwapSide — both frozen',
    expected_effect: 'Sign flip by regime. A regime-blind VWAP rule should therefore FAIL out of sample, which is itself the test.',
    direction: 'regime-dependent',
    test_design:
      'This is the registry\'s flagship REGIME-DEPENDENCE test. Any positive in-sample result that does not flip by regime is a red flag, not a confirmation.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
    status: 'testing',
  }),
  entry({
    id: 'RES-006',
    title: 'Funding extremes and squeeze risk',
    source: 'Perpetual-swap market mechanics; exchange documentation',
    source_type: 'exchange-docs',
    claim: 'Extreme positive funding marks a crowded long and precedes a squeeze against it.',
    market: 'crypto',
    hypothesis:
      'Funding beyond the crowded threshold, with OI RISING, precedes adverse moves for the crowded side more often than base rate.',
    feature_or_rule: 'positioning.fundingZ, positioning.crowdedAgainst, deriv.fundingLabel',
    expected_effect: 'Negative expectancy for the crowded side; drives the `funding-crowded-against` veto',
    direction: 'bearish',
    test_design:
      'Note the direction was CORRECTED once already (bug #28): the engine\'s convention is that positive funding is crowded AGAINST a short. Any test written against the wrong sign would have confirmed the error rather than catching it.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
    status: 'testing',
  }),
  entry({
    id: 'RES-007',
    title: 'OI expansion vs OI contraction',
    source: 'Futures market-structure practice',
    source_type: 'practitioner',
    claim: 'Rising OI with rising price is new longs; rising price with falling OI is short covering.',
    market: 'crypto',
    hypothesis: 'The OI quadrant predicts continuation vs exhaustion.',
    feature_or_rule: 'deriv.oiChange, deriv.quadrant',
    expected_effect: 'New-long quadrants continue; short-cover quadrants exhaust',
    direction: 'conditional',
    test_design: 'Group by quadrant; expect different signs, so a pooled test will hide the effect.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
  }),
  entry({
    id: 'RES-008',
    title: 'CVD divergence',
    source: 'Order-flow practice',
    source_type: 'practitioner',
    claim: 'Price making a new high without CVD confirmation is a divergence.',
    market: 'crypto',
    hypothesis: 'cvdDivergence marks reversals more reliably than it marks continuations.',
    feature_or_rule: 'deriv.cvdDivergence, positioning.cvdSlope',
    expected_effect: 'Negative expectancy on divergence-flagged continuation setups',
    direction: 'bearish',
    test_design:
      'CAVEAT: `deriv.cvd` is DERIVED from kline taker-buy notional, not from a trade tape. It is a price-action proxy. Any result here must be reported with that caveat or it overstates the evidence.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
  }),
  entry({
    id: 'RES-009',
    title: 'Liquidation cascades',
    source: 'Market microstructure research; exchange liquidation streams',
    source_type: 'paper',
    claim: 'Large liquidation notional relative to volume marks forced, non-informative flow.',
    market: 'crypto',
    hypothesis: 'A cascade regime reduces the value of discretionary setups and should reduce size, not reverse direction.',
    feature_or_rule: 'regime high-vol-cascade; liquidationProximityFrac. NOTE: liqVelocityFrac is currently always null in production.',
    expected_effect: 'Reduced expectancy, not directional edge',
    direction: 'regime-dependent',
    test_design: 'Per-regime expectancy. Requires liqVelocityFrac to be wired first.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
  }),
  entry({
    id: 'RES-010',
    title: 'Stablecoin supply expansion',
    source: 'Crypto market research; on-chain analytics vendors',
    source_type: 'paper',
    claim: 'Rising stablecoin float precedes risk-on flows.',
    market: 'crypto',
    hypothesis: 'Stablecoin float growth over 30d leads positive returns at a 1-4 week horizon.',
    feature_or_rule: 'regime.stablecoinFloatUsd — measured as a LEVEL. A CHANGE needs two readings, which the scan does not retain.',
    expected_effect: 'Positive drift at weeks-scale horizon',
    direction: 'bullish',
    test_design:
      'NOT TESTABLE at the engine\'s horizon: the signal expiry is 24h and the claimed effect is weeks-scale. Recorded so the mismatch is explicit rather than quietly tested at the wrong horizon.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
  }),
  entry({
    id: 'RES-011',
    title: 'ETF-flow persistence',
    source: 'Institutional flow research',
    source_type: 'paper',
    claim: 'Persistent ETF inflows precede sustained spot demand.',
    market: 'crypto',
    hypothesis: 'Multi-day inflow streaks add predictive value beyond a single day.',
    feature_or_rule: 'NONE. `macro.etfFlows` is currently ALWAYS the Unavailable object because the upstream source 403s.',
    expected_effect: 'Unknown — not measurable with free data at present',
    direction: 'bullish',
    test_design: 'BLOCKED on data availability, not on method. Recorded so the absence is a known gap rather than a silent omission.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
    status: 'inconclusive',
  }),
  entry({
    id: 'RES-012',
    title: 'CPI/FOMC surprise effects',
    source: 'Macro research; BLS release schedule',
    source_type: 'paper',
    claim: 'Surprise relative to consensus, not the release itself, moves markets.',
    market: 'both',
    hypothesis: 'Surprise magnitude predicts the first-hour response more than the event classification does.',
    feature_or_rule: 'Macro blackout is implemented. SURPRISE is NOT MEASURED — there is no consensus feed in the free data set.',
    expected_effect: 'Directional first-hour move, then reversal',
    direction: 'conditional',
    test_design:
      'The blackout veto is a RISK control and is justified without this hypothesis. The surprise claim itself is untestable without consensus data.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
  }),
  entry({
    id: 'RES-013',
    title: 'Post-FOMC reversal behaviour',
    source: 'Macro trading lore',
    source_type: 'practitioner',
    claim: 'The initial move after a rate decision reverses.',
    market: 'both',
    hypothesis: 'Sign of the 0-1h move predicts the sign of the 1-24h move.',
    feature_or_rule: 'Macro blackout window; would need intraday event-window candles.',
    expected_effect: 'Negative correlation between first-hour and next-day returns',
    direction: 'conditional',
    test_design: 'Event study around tier-1 timestamps. Requires candle history spanning the event, which the 1-week store cannot currently supply.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
  }),
  entry({
    id: 'RES-014',
    title: 'News novelty and corroboration',
    source: 'The vendor methodologies surveyed in Phase 0; news-impact research',
    source_type: 'practitioner',
    claim: 'Novel, corroborated news moves markets; repeated commentary does not.',
    market: 'both',
    hypothesis: 'Novelty-adjusted NIS predicts attribution coverage better than raw NIS.',
    feature_or_rule: 'NewsItem.routine, catalyst.routineDominates, catalyst.attributionCoveragePct — the `routine-commentary` veto is built on this.',
    expected_effect: 'Routine commentary attributed to a large share of a move predicts exhaustion',
    direction: 'conditional',
    test_design: 'Correlate routineDominates against abnormal return AFTER removing BTC beta.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
    status: 'testing',
  }),
  entry({
    id: 'RES-015',
    title: 'Abnormal-return attribution',
    source: 'Event-study methodology',
    source_type: 'paper',
    claim: 'A news item explains a move only to the extent it beats what BTC beta predicted.',
    market: 'both',
    hypothesis: 'Removing the BTC-beta component makes attribution coverage a better predictor than raw return.',
    feature_or_rule: 'catalyst.attributionCoveragePct, news.abnormalReturnPct, news.btcBeta',
    expected_effect: 'Attribution quality improves; direction unchanged',
    direction: 'conditional',
    test_design: 'The 2.5σ significance gate is documented and deliberately NOT loosened to make results look better.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
    status: 'testing',
  }),
  entry({
    id: 'RES-016',
    title: 'Volatility compression before expansion',
    source: 'Market-structure literature',
    source_type: 'book',
    claim: 'Compressed volatility precedes expansion.',
    market: 'both',
    hypothesis: 'ATR percentile below a threshold predicts a larger next-window move in either direction.',
    feature_or_rule: 'context.atrPercentile — measured and frozen',
    expected_effect: 'Larger absolute moves; DIRECTION is not predicted, so this belongs in sizing, not in side selection',
    direction: 'regime-dependent',
    test_design:
      'Test on absolute forward return, not signed. A signed test will find nothing, because the hypothesis does not claim a direction.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
  }),
  entry({
    id: 'RES-017',
    title: 'Sector leadership and breadth confirmation',
    source: 'Cross-sectional equity research; crypto sector flow practice',
    source_type: 'paper',
    claim: 'Assets in a leading sector, with confirming breadth, outperform.',
    market: 'both',
    hypothesis: 'A setup whose sector leads and whose side matches market breadth has higher expectancy.',
    feature_or_rule: 'sector, sectors[].leading, breadthBias, FeatureRecord.breadth',
    expected_effect: 'Positive expectancy concentrated in trending regimes',
    direction: 'conditional',
    test_design: 'Group by (sector leading × breadth direction). Expect an INTERACTION, so a pooled marginal will understate it.',
    minimum_sample_size: MIN_SAMPLE_FOR_ACCEPTANCE,
    status: 'testing',
  }),
];

/**
 * Constants migrated from config, each carrying the research rationale.
 *
 * This is the bridge Phase XVI asks for: a `[TUNED]` tag in config says "hand-
 * chosen", which is not a rationale. Here each gets a reason AND a place to record
 * the evidence that would confirm or kill it.
 */
export interface ConstantProvenance {
  id: string;
  value: number | string | boolean;
  /** Where the number lives in config, so this list cannot drift from the code. */
  configPath: string;
  provenance: 'PROBED' | 'TUNED' | 'FITTED' | 'RESEARCHED' | 'EXPERIMENTAL';
  /** The reason for the value. NOT just a restatement of the number. */
  source: string;
  /** Which registry entry, when the constant comes from a research idea. */
  researchId: string | null;
  /** A test that pins it. */
  test: string;
  /** What to restore if this proves wrong. */
  rollback: string;
}

export const CONSTANT_PROVENANCE: ConstantProvenance[] = [
  {
    id: 'MIND.ALIGNED_LOG_ODDS',
    value: 1.6,
    configPath: 'config.MIND.ALIGNED_LOG_ODDS',
    provenance: 'TUNED',
    source:
      'With an observed base rate near 0.535 this puts a perfectly aligned setup near p=0.85 and an opposed one near 0.19. Deliberately narrow: a wide swing on unfitted weights is how a research tool starts printing numbers it cannot support.',
    researchId: null,
    test: 'server/test/mind.confluence.test.ts',
    rollback: 'The intercept is anchored to the ledger base rate, so a bad swing degrades toward the base rate rather than breaking the model.',
  },
  {
    id: 'MIND.BASE_RATE_PRIOR_BLEND',
    value: 0.5,
    configPath: 'config.MIND.BASE_RATE_PRIOR_BLEND',
    provenance: 'TUNED',
    source:
      'Below the sample floor the observed rate is treated as unknown and the model leans on 0.5. It does not invent a rate.',
    researchId: null,
    test: 'server/test/mind.confluence.test.ts',
    rollback: 'Set to 0 to trust the observed rate at any sample size — worse while the ledger is thin.',
  },
  {
    id: 'MIND.KELLY_FRACTION',
    value: 0.25,
    configPath: 'config.MIND.KELLY_FRACTION',
    provenance: 'RESEARCHED',
    source:
      'Fractional Kelly. Half-Kelly retains roughly 75% of growth at about half the drawdown; in simulation quarter-Kelly cut the chance of a 40% drawdown from 99.2% to 3.7% at a 36% true win rate. CRITICAL CAVEAT: fractional Kelly does not rescue a model with no edge — it loses more slowly. It may not be used to justify a weak model.',
    researchId: null,
    test: 'server/test/mind.rank.test.ts',
    rollback: 'Lower it. Raising it toward 1 is only defensible once calibration has PROVEN the edge, which has not happened.',
  },
  {
    id: 'LEDGER.AMBIGUITY',
    value: 'STOP_FIRST',
    configPath: 'config.LEDGER.AMBIGUITY',
    provenance: 'RESEARCHED',
    source:
      'One candle spanning both the stop and a target has an unknowable internal order, so the worst case is taken. A policy, not a measurement — which is why it is now stored on every outcome row.',
    researchId: null,
    test: 'server/test/ledger.test.ts',
    rollback: 'TARGET_FIRST is implemented and wired. Changing it requires re-resolving the historical ledger, so it is not a casual edit.',
  },
  {
    id: 'STRUCTURE.EVENT_RISK_PCT',
    value: 14,
    configPath: 'config.STRUCTURE.EVENT_RISK_PCT',
    provenance: 'PROBED',
    source: 'A 14% day is roughly 3x the median crypto daily range. Measured, not assumed.',
    researchId: 'RES-012',
    test: 'server/test/conviction.test.ts',
    rollback: 'Restore 14. Raising it to make signals pass would suppress exactly the event-risk cases the veto exists for.',
  },
  {
    id: 'HEALTH.BLOCK_ON_CALENDAR_UNAVAILABLE',
    value: true,
    configPath: 'config.HEALTH.BLOCK_ON_CALENDAR_UNAVAILABLE',
    provenance: 'TUNED',
    source:
      'An unavailable calendar cannot clear a blackout. Unknown is not clear: an empty calendar is indistinguishable from "no events today", so an outage would otherwise print A-grade picks through CPI.',
    researchId: 'RES-012',
    test: 'server/test/dataHealth.test.ts',
    rollback: 'Flipping this to false re-opens the exact failure. Do not do it to make a test pass.',
  },
];

/** Registry summary for the report and the UI. */
export function registrySummary(): {
  total: number;
  byStatus: Record<ResearchStatus, number>;
  accepted: number;
  /** Entries that are blocked on data rather than on method. */
  blockedOnData: string[];
} {
  const byStatus = {} as Record<ResearchStatus, number>;
  for (const e of RESEARCH_REGISTRY) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
  return {
    total: RESEARCH_REGISTRY.length,
    byStatus,
    accepted: byStatus.accepted ?? 0,
    blockedOnData: RESEARCH_REGISTRY.filter((e) =>
      /NOT TESTABLE|BLOCKED on data/.test(e.test_design),
    ).map((e) => e.id),
  };
}
