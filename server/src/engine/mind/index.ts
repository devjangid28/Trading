/**
 * The Mind layer — public surface.
 *
 * Four pure modules, one barrel. Nothing here imports the database, the network
 * or the clock, so every function can be unit-tested with literals:
 *
 *   features.ts    frozen, point-in-time-correct feature vectors
 *   regime.ts      six regimes, with the evidence that produced them
 *   confluence.ts  calibrated probability, net expected R, hard vetoes
 *   calibrate.ts   Brier against the base rate, reliability, honest R
 *   rank.ts        board ranking by Kelly-inspired edge
 *   attribution.ts catalyst features, split out to keep features.ts honest
 *
 * The design rule, and the reason for the split: **no scorer may reach past
 * `asOf`.** See `features.ts` for why that is structural rather than a
 * convention.
 */

export {
  buildFeatureVector,
  featureCoverage,
  measured,
  absent,
  num,
  newsAsOf,
  sliceAsOf,
  FEATURE_LOOKBACK_CANDLES,
  type FeatureInputs,
} from './features.js';

export { deriveAttributionFeatures, type AttributionFeatureSource } from './attribution.js';

export {
  classifyRegime,
  regimeInputsFrom,
  type RegimeInputs,
  type RegimeEvidence,
  type RegimeVerdict,
} from './regime.js';

export {
  expectedR,
  hardVetoes,
  kellyRank,
  logit,
  logistic,
  resolveBaseRate,
  scoreCandidate,
  toMindSignal,
  type BaseRate,
  type ExpectedR,
  type GroupScore,
  type ScoreInput,
  type ScoreOutput,
  type VetoContext,
} from './confluence.js';

export {
  brierBaseRate,
  brierDecomposition,
  brierScore,
  buildCalibrationReport,
  calibrationFootnote,
  honestRMultiple,
  isWin,
  reliabilityDiagram,
  WINS,
} from './calibrate.js';

export { rankCandidates, idFor, type Candidate, type RankedBoard } from './rank.js';

export {
  runMindPass,
  boardRegime,
  boardLevelRegimeInputs,
  buildMindHealth,
  attachMindToRows,
  type MindScanInput,
  type MindScanResult,
  type MarketContext,
} from './scan.js';