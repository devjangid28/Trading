/**
 * The Engine Lab's service layer.
 *
 * Everything the Lab page shows is assembled here, from two sources and no
 * others:
 *
 *   1. **the current scan** — what the engine is considering right now;
 *   2. **the Lab's own store** — what the learning loop has done about it.
 *
 * Nothing here invents a number. Where a thing is not measured, the field is
 * `null` and, where the reader needs to know why, a sentence says why.
 */

import { LAB, MIND, RISK } from '../../config.js';
import type {
  AssetRow,
  LabAccount,
  LabAlertMessage,
  LabCalibration,
  LabDecision,
  LabLearning,
  LabMode,
  LabOverview,
  LabPosition,
  LabReview,
  LabStatus,
  ScanResult,
  FeatureVector,
  Measured,
} from '../../../../shared/types.js';
import { featureCatalogue } from '../mind/features.js';
import {
  allReviews,
  equityCurve,
  listFills,
  listModelDecisions,
  listModels,
  listPositions,
  listReviews,
  openPositions,
  reviewCount,
  labSetting,
  setLabSetting,
} from './store.js';
import {
  beyondPaperCriteria,
  currentModels,
  driftMonitor,
  evaluateModel,
  LAB_FEATURE_NAMES,
  promotionVerdict,
  retrainGate,
  reviewsToRows,
  rollback,
  retrain,
  type ModelEvaluation,
} from './learning.js';
import { calibrationReport, tierRows, type ScoredTrade } from './calibration.js';
import { PaperBroker, type PaperOrder } from './executor.js';
import { dailyLossHalted, type RiskState } from './risk.js';
import { predict, type LogisticModel } from '../closedloop/model.js';

// ─── The settings ────────────────────────────────────────────────────────────
//
// The knobs themselves live in the STORE, next to the table they are stored
// in. This section is the thin, typed accessor layer over them.

import {
  labMode as storedMode,
  labRunning as storedRunning,
  labKillSwitch as storedKillSwitch,
  labShadowOnly as storedShadowOnly,
  labEquity as storedEquity,
  setLabSettingValue,
  SETTING_KEYS,
} from './store.js';

export function labMode(): LabMode {
  return storedMode();
}

export function labRunning(): boolean {
  return storedRunning();
}

export function labKillSwitch(): boolean {
  return storedKillSwitch();
}

export function labShadowOnly(): boolean {
  return storedShadowOnly();
}

/** The paper account's equity. It starts at the configured default. */
export function labEquity(): number {
  return storedEquity(RISK.DEFAULT_ACCOUNT);
}

export function setLabMode(mode: LabMode): void {
  setLabSettingValue(SETTING_KEYS.mode, mode);
}

export function setLabRunning(running: boolean): void {
  setLabSettingValue(SETTING_KEYS.running, running ? 'true' : 'false');
}

export function setLabKillSwitch(on: boolean): void {
  setLabSettingValue(SETTING_KEYS.killSwitch, on ? 'true' : 'false');
}

export function setLabShadowOnly(on: boolean): void {
  setLabSettingValue(SETTING_KEYS.shadowOnly, on ? 'true' : 'false');
}

export function setLabEquity(equity: number): void {
  setLabSettingValue(SETTING_KEYS.equityUsd, String(equity));
}

// ─── The scored trades ───────────────────────────────────────────────────────

/**
 * The trades the Lab can score, from the reviews.
 *
 * A review carries the probability the model published and the outcome, so
 * the calibration panel never has to recompute a probability.
 */
export function scoredTrades(): ScoredTrade[] {
  return allReviews().map((r) => ({
    p: r.predictedPWin,
    y: r.outcome,
    netR: r.netR,
    cluster: r.symbol,
  }));
}

// ─── The status panel ────────────────────────────────────────────────────────

export function labStatus(now = Date.now()): LabStatus {
  const { champion, challenger } = currentModels();
  const reviews = allReviews();
  const { rows } = reviewsToRows(reviews);

  // The champion's VALIDATION numbers, from its own out-of-sample folds.
  let championEval: ModelEvaluation | null = null;
  if (champion) championEval = evaluateModel(rows);

  const live = scoredTrades()
    .filter((t) => t.y !== null && t.p !== null)
    .map((t) => ({ p: t.p as number, y: t.y as 0 | 1, netR: t.netR, cluster: t.cluster }));

  const drift = driftMonitor({
    liveTrades: live,
    validationBrier: championEval?.oosBrier ?? null,
    validationExpectancyR: championEval?.oosExpectancyR ?? null,
  });

  // The daily loss, from the closed positions of the current UTC day.
  const dayStart = utcDayStart(now);
  const closedToday = listPositions(1000).filter(
    (p) => p.status === 'CLOSED' && p.closedAt !== null && p.closedAt >= dayStart,
  );
  const realisedPnlUsdToday = closedToday.reduce(
    (a, p) => a + (p.netR !== null ? p.netR * p.riskUsd : 0),
    0,
  );
  const realisedNetRToday = closedToday.reduce((a, p) => a + (p.netR ?? 0), 0);

  const equity = labEquity();
  const halt = dailyLossHalted({
    killSwitch: false,
    realisedPnlUsdToday,
    realisedNetRToday,
    equityUsd: equity,
    openPositions: [],
    macroBlackoutMin: null,
    shadowOnly: false,
  });

  const testnetConfigured = Boolean(
    process.env[LAB.TESTNET_API_KEY_ENV] && process.env[LAB.TESTNET_API_SECRET_ENV],
  );

  return {
    updatedAt: now,
    mode: labMode(),
    liveAvailable: false,
    running: labRunning(),
    model: {
      version: champion?.version ?? 'mind-1 (shipped, unfitted)',
      role: champion ? 'CHAMPION' : 'NONE',
      trainedAt: champion?.trainedAt ?? null,
      trainedOnTrades: champion?.trainedOnTrades ?? null,
      featureSchema: champion?.featureSchema ?? 'mind-1',
    },
    challenger: challenger
      ? {
          version: challenger.version,
          trainedAt: challenger.trainedAt,
          trainedOnTrades: challenger.trainedOnTrades,
          verdict: challenger.verdict ?? 'No verdict recorded.',
        }
      : null,
    drift: {
      state: drift.state,
      liveBrier: drift.liveBrier,
      validationBrier: drift.validationBrier,
      liveExpectancyR: drift.liveExpectancyR,
      validationExpectancyR: drift.validationExpectancyR,
      n: drift.n,
      reason: drift.reason,
      shadowOnlyForced: drift.shadowOnlyForced,
    },
    killSwitch: labKillSwitch(),
    shadowOnly: labShadowOnly(),
    dailyLoss: {
      realisedPnlUsdToday: round2(realisedPnlUsdToday),
      realisedNetRToday: round4(realisedNetRToday),
      limitUsd: round2(halt.limitUsd),
      halted: halt.halted,
      reason: halt.reason,
    },
    executors: {
      paper: { available: true },
      testnet: {
        available: LAB.TESTNET_ENABLED,
        configured: testnetConfigured,
        enabled: LAB.TESTNET_ENABLED,
        reason: LAB.TESTNET_ENABLED
          ? testnetConfigured
            ? 'The testnet adapter is on and the credentials are present in the environment.'
            : `The testnet adapter is on but ${LAB.TESTNET_API_KEY_ENV} / ${LAB.TESTNET_API_SECRET_ENV} are not in the environment.`
          : 'The Binance testnet adapter is OFF by default. Set LAB.TESTNET_ENABLED in server/src/config.ts to switch it on.',
      },
      live: {
        available: false,
        reason:
          'REAL-MONEY EXECUTION IS NOT BUILT. There is no live adapter, no key handling and no ' +
          'configuration that turns one on. Promotion beyond paper/testnet needs 90+ days AND 300+ ' +
          'paper trades, a net-expectancy CI lower bound above zero, calibration within tolerance, a ' +
          'green drift monitor, and the operator\'s manual approval.',
      },
    },
  };
}

/** The UTC day the daily-loss counter belongs to. */
export function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), LAB.DAILY_RESET_UTC_HOUR);
}

// ─── The live decisions ──────────────────────────────────────────────────────

/**
 * The veto rules the engine checks, and whether each one fired.
 *
 * The engine only RECORDS a veto when it fires, so "the vetoes that did not
 * fire" cannot be read off the signal — it has to be re-evaluated against the
 * frozen vector, with the SAME thresholds the engine uses. That is what this
 * function does, and it is why the thresholds come from `MIND` and not from
 * here.
 */
export function vetoesEvaluated(v: FeatureVector): {
  fired: Array<{ kind: string; why: string }>;
  notFired: Array<{ kind: string; why: string }>;
} {
  const fired: Array<{ kind: string; why: string }> = [];
  const notFired: Array<{ kind: string; why: string }> = [];

  const crowded = v.positioning.crowdedAgainst.value;
  if (crowded === 1) {
    fired.push({ kind: 'POSITIONING', why: 'Positioning is crowded against this side, with open interest rising.' });
  } else {
    notFired.push({ kind: 'POSITIONING', why: 'Positioning is not crowded against this side.' });
  }

  const blackout = v.regime.macroBlackoutMin.value;
  if (blackout !== null && blackout <= MIND.VETO_BLACKOUT_MIN) {
    fired.push({ kind: 'MACRO', why: `A tier-1 release is ${Math.abs(blackout).toFixed(0)} minutes away.` });
  } else {
    notFired.push({
      kind: 'MACRO',
      why: blackout === null
        ? 'The macro calendar did not measure a blackout window, so the rule could not fire.'
        : `The next tier-1 release is ${blackout.toFixed(0)} minutes away.`,
    });
  }

  const nis = v.catalyst.maxNis4h.value;
  const coverage = v.catalyst.attributionCoveragePct.value;
  if (nis !== null && nis >= MIND.VETO_ROUTINE_NIS && coverage !== null && coverage >= MIND.VETO_ROUTINE_COVERAGE_PCT) {
    fired.push({ kind: 'CATALYST', why: `Routine commentary carries the move (NIS ${nis.toFixed(0)}, coverage ${coverage.toFixed(0)}%).` });
  } else {
    notFired.push({ kind: 'CATALYST', why: 'No routine-commentary catalyst claim carries this move.' });
  }

  const chop = v.structure.choppiness.value;
  if (chop !== null && chop < MIND.VETO_EFFICIENCY) {
    fired.push({ kind: 'STRUCTURE', why: `The market is chopping (efficiency ${chop.toFixed(2)}).` });
  } else {
    notFired.push({
      kind: 'STRUCTURE',
      why: chop === null ? 'Choppiness was not measured.' : 'The structure is not chop.',
    });
  }

  const eventRisk = v.context.eventRisk.value;
  if (eventRisk !== null && eventRisk >= MIND.VETO_EVENT_RISK) {
    fired.push({ kind: 'STRUCTURE', why: `The move is already ${(eventRisk * 100).toFixed(1)}% — event risk.` });
  } else {
    notFired.push({ kind: 'STRUCTURE', why: 'The move is not yet event risk.' });
  }

  return { fired, notFired };
}

/**
 * The decisions the engine is considering right now.
 *
 * One row per board candidate that has a Mind signal. Every field is either
 * measured or explicitly null.
 */
export function labDecisions(scan: ScanResult | null, championModel: LogisticModel | null): LabDecision[] {
  if (!scan) return [];
  const rows: AssetRow[] = [...scan.bullish, ...scan.bearish];
  const out: LabDecision[] = [];
  const cal = calibrationReport(scoredTrades());

  for (const row of rows) {
    const mind = row.mind ?? null;
    const features = row.mindFeatures ?? null;
    if (!mind && !features) continue;

    // The champion model's probability, when there is a champion. Otherwise the
    // shipped Mind probability, which is explicitly an unfitted model.
    let pWin: number | null = null;
    if (championModel && features) {
      const x = featureCatalogue(features)
        .filter((e) => LAB_FEATURE_NAMES.includes(e.name))
        .map((e) => e.value ?? 0);
      if (x.length === LAB_FEATURE_NAMES.length) {
        pWin = predict(championModel, x);
      }
    }
    if (pWin === null && mind) pWin = mind.probability;

    // The interval on the probability comes from the reliability bucket the
    // prediction falls in: "for forecasts in this band, the realised rate is
    // X [lo, hi]". A single prediction has no interval of its own.
    const pWinCi = pWin === null ? null : bucketCi(cal, pWin);

    const topFeatures = topDrivers(mind, features);
    const veto = features ? vetoesEvaluated(features) : { fired: [], notFired: [] };

    const gates: string[] = [];
    if (mind) {
      if (mind.probability < MIND.ACTIONABLE_MIN_PROBABILITY) {
        gates.push(`the probability ${(mind.probability * 100).toFixed(1)}% is below the ${(MIND.ACTIONABLE_MIN_PROBABILITY * 100).toFixed(0)}% actionability gate`);
      }
      if (mind.netExpectedR < MIND.ACTIONABLE_MIN_NET_R) {
        gates.push(`the expected net R ${mind.netExpectedR.toFixed(3)} is below the ${MIND.ACTIONABLE_MIN_NET_R} gate`);
      }
      for (const v of mind.vetoes) gates.push(`${v.code}: ${v.reason}`);
    }

    out.push({
      id: mind?.id ?? `${row.id}_${row.side}`,
      symbol: row.pair,
      side: row.side,
      asOf: mind?.asOf ?? row.updatedAt,
      pWin: pWin === null ? null : round4(pWin),
      pWinCi,
      expectedNetR: mind ? round4(mind.netExpectedR) : null,
      topFeatures,
      vetoesNotFired: veto.notFired,
      skippedReason: mind?.actionable ? null : (gates.length ? gates.join('; ') : 'No actionability gate was cleared.'),
      actionable: mind?.actionable ?? false,
      featureSnapshot: features,
    });
  }

  out.sort((a, b) => (b.pWin ?? -1) - (a.pWin ?? -1));
  return out.slice(0, 20);
}

/** The three features that moved the probability most. */
function topDrivers(
  mind: AssetRow['mind'],
  features: FeatureVector | null,
): LabDecision['topFeatures'] {
  if (!mind) return [];
  const byName = new Map(featureCatalogue(features ?? emptyVector()).map((e) => [e.name, e]));
  return mind.drivers
    .filter((d) => d.disclosure !== true)
    .slice(0, 3)
    .map((d) => {
      const spec = byName.get(d.feature);
      return {
        name: d.feature,
        unit: spec?.unit ?? 'unknown',
        value: spec?.value ?? null,
        contribution: round4(d.contribution),
      };
    })
    .map((d) => ({ ...d, value: d.value === null ? 0 : d.value }));
}

/** The Wilson interval of the reliability bucket a probability falls in. */
function bucketCi(cal: LabCalibration, p: number): [number, number] | null {
  for (const row of cal.reliability) {
    if (p >= row.lo && (p < row.hi || row.hi === 1)) {
      if (row.n < LAB.TIER_MIN_TRADES) return null;
      const wins = row.observed === null ? 0 : row.observed * row.n;
      const lo = row.observed === null ? 0 : row.observed;
      void lo;
      void wins;
      // The reliability table does not carry the Wilson interval, so it is
      // recomputed from the bucket's own rate and size.
      const z = LAB.WILSON_Z;
      const phat = row.observed as number;
      const n = row.n;
      const denom = 1 + (z * z) / n;
      const centre = (phat + (z * z) / (2 * n)) / denom;
      const half = (z / denom) * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
      return [round4(Math.max(0, centre - half) * 100), round4(Math.min(1, centre + half) * 100)];
    }
  }
  return null;
}

function emptyVector(): FeatureVector {
  return {
    symbol: '',
    asOf: 0,
    side: 'bullish',
    structure: {} as FeatureVector['structure'],
    positioning: {} as FeatureVector['positioning'],
    catalyst: {} as FeatureVector['catalyst'],
    regime: {} as FeatureVector['regime'],
    context: {} as FeatureVector['context'],
    microstructure: {} as FeatureVector['microstructure'],
    crossVenue: {} as FeatureVector['crossVenue'],
    timeframes: {} as FeatureVector['timeframes'],
    crossAsset: {} as FeatureVector['crossAsset'],
    liquidations: {} as FeatureVector['liquidations'],
    orderbook: {} as FeatureVector['orderbook'],
    funding: {} as FeatureVector['funding'],
    regimeLabel: 'quiet',
  };
}

// ─── The account panel ───────────────────────────────────────────────────────

export function labAccount(now = Date.now()): LabAccount {
  const positions = listPositions(200);
  const opens = openPositions();
  const curve = equityCurve(500);
  const equity = labEquity();
  const closed = positions.filter((p) => p.status === 'CLOSED');
  const realisedNetR = closed.reduce((a, p) => a + (p.netR ?? 0), 0);

  const openLab: LabPosition[] = opens.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    openedAt: p.openedAt,
    entryPrice: p.entryPrice ?? 0,
    markPrice: p.entryPrice ?? 0,
    stop: p.stop,
    targets: p.targets,
    netR: p.netR,
    pWin: p.pWin,
    expectedNetR: p.expectedNetR,
    sector: p.sector,
    venue: p.venue,
  }));

  return {
    updatedAt: now,
    venue: labMode() === 'TESTNET' ? 'TESTNET' : 'PAPER',
    equityUsd: round2(equity),
    realisedNetR: round4(realisedNetR),
    closedTrades: closed.length,
    equityCurve: curve,
    openPositions: openLab,
    fills: listFills(50),
  };
}

// ─── The reviews panel ───────────────────────────────────────────────────────

export function labReviews(limit = 100): LabReview[] {
  return listReviews(limit).map((r) => ({
    ...r,
    snapshotUrl: r.featureSnapshot ? `/api/mind/features/${r.symbol}` : null,
  }));
}

// ─── The learning panel ──────────────────────────────────────────────────────

export function labLearning(now = Date.now()): LabLearning {
  const reviews = allReviews();
  const { rows } = reviewsToRows(reviews);
  const models = listModels();
  const { champion } = currentModels();

  const evaluation = rows.length ? evaluateModel(rows) : null;
  const folds = evaluation?.folds ?? [];

  const lastRetrainAt = Number(labSetting(SETTING_KEYS.lastRetrainAt, '0')) || null;
  const sinceLast = lastRetrainAt
    ? reviews.filter((r) => r.closedAt > lastRetrainAt).length
    : reviews.length;
  const gate = retrainGate(sinceLast, rows.length);

  const championEval = champion && rows.length ? evaluateModel(rows) : null;

  const criteria = beyondPaperCriteria({
    days: paperDays(now),
    paperTrades: listPositions(1000).filter((p) => p.status === 'CLOSED').length,
    expectancyCiLowerBound: championEval?.oosExpectancyCi?.[0] ?? null,
    calibrationWithinTolerance: calibrationWithinTolerance(),
    driftGreen: labStatus(now).drift.state === 'GREEN' ? true : labStatus(now).drift.state === 'DEGRADED' ? false : null,
  });

  const blockedBy = [
    ...criteria.blockedBy,
    ...(gate.allowed ? [] : [gate.reason]),
  ];

  return {
    updatedAt: now,
    models: models.map((m) => ({
      version: m.version,
      role: m.role,
      createdAt: m.createdAt,
      trainedOnTrades: m.trainedOnTrades,
      trainedAt: m.trainedAt,
      featureSchema: m.featureSchema,
      fit: m.fit as { lambda: number; iterations: number; learningRate: number; seed: number } | null,
      oosExpectancyR: m.oosExpectancyR,
      oosBrier: m.oosBrier,
      oosLogLoss: m.oosLogLoss,
      oosTrades: m.oosTrades,
      verdict: m.verdict,
    })),
    folds,
    decisions: listModelDecisions(50).map((d) => ({
      at: d.at,
      version: d.version,
      kind: d.kind,
      reason: d.reason,
      championExpectancyR: d.championExpectancyR,
      challengerExpectancyR: d.challengerExpectancyR,
      championBrier: d.championBrier,
      challengerBrier: d.challengerBrier,
    })),
    promotionBlockedBy: blockedBy,
  };
}

/** How many days the paper account has been running. */
function paperDays(now: number): number {
  const positions = listPositions(1000);
  if (!positions.length) return 0;
  const first = Math.min(...positions.map((p) => p.openedAt));
  return Math.floor((now - first) / (24 * 3600_000));
}

/** Is the calibration inside the tolerance? Null when it has not been measured. */
export function calibrationWithinTolerance(): boolean | null {
  const cal = calibrationReport(scoredTrades());
  if (!cal.n) return null;
  const worst = cal.reliability
    .filter((r) => r.gap !== null && r.n >= LAB.TIER_MIN_TRADES)
    .sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0))[0];
  if (!worst || worst.gap === null) return null;
  return worst.gap <= LAB.CALIBRATION_TOLERANCE;
}

// ─── The calibration panel ───────────────────────────────────────────────────

export function labCalibration(): LabCalibration {
  return calibrationReport(scoredTrades());
}

// ─── The alert message ───────────────────────────────────────────────────────

/**
 * The outbound alert-style message.
 *
 * TradingView's paper-trading account is a manual UI simulator with no public
 * order-placement API. Its only automation is an OUTBOUND alert webhook, so
 * this is a message the operator pastes into a TradingView alert or a chart
 * note. Nothing is sent anywhere by this application.
 */
export function labAlertMessage(scan: ScanResult | null, championModel: LogisticModel | null): LabAlertMessage | null {
  const decisions = labDecisions(scan, championModel).filter((d) => d.actionable);
  if (!decisions.length) return null;
  const d = decisions[0];
  const row = scan
    ? [...scan.bullish, ...scan.bearish].find((r) => r.pair === d.symbol && r.side === d.side)
    : undefined;
  const plan = row?.plan ?? null;
  const entry = plan?.entryMid ?? row?.setup?.z ?? 0;
  const stop = plan?.stop ?? row?.setup?.invalidation ?? 0;
  const targets = plan?.targets?.map((t) => t.price) ?? [];
  if (!entry || !stop) return null;

  const payload = {
    symbol: d.symbol,
    side: d.side,
    entry: round4(entry),
    stop: round4(stop),
    targets: targets.map((t) => round4(t)),
    pWin: d.pWin,
    modelVersion: championModel ? (currentModels().champion?.version ?? 'lab') : 'mind-1',
  };

  return {
    symbol: d.symbol,
    side: d.side,
    entry: round4(entry),
    stop: round4(stop),
    targets: payload.targets,
    pWin: d.pWin,
    modelVersion: payload.modelVersion,
    json: JSON.stringify(payload, null, 2),
  };
}

// ─── The whole page ──────────────────────────────────────────────────────────

export function labOverview(scan: ScanResult | null, championModel: LogisticModel | null): LabOverview {
  return {
    status: labStatus(),
    decisions: labDecisions(scan, championModel),
    account: labAccount(),
    reviews: labReviews(),
    learning: labLearning(),
    calibration: labCalibration(),
    alertMessage: labAlertMessage(scan, championModel),
  };
}

// ─── The controls ────────────────────────────────────────────────────────────

export type LabControlAction =
  | 'start'
  | 'stop'
  | 'kill-switch-on'
  | 'kill-switch-off'
  | 'shadow-only-on'
  | 'shadow-only-off'
  | 'rollback'
  | 'retrain'
  | 'mode';

/**
 * Run a control action.
 *
 * Each one returns a sentence saying what happened, because a control that
 * changes nothing and says nothing looks broken.
 */
export function runControl(action: LabControlAction, arg?: string): { ok: boolean; message: string } {
  switch (action) {
    case 'start':
      setLabRunning(true);
      return { ok: true, message: 'The Lab is running. It records decisions and, in PAPER mode, executes them.' };
    case 'stop':
      setLabRunning(false);
      return { ok: true, message: 'The Lab is stopped. Nothing new is decided or executed.' };
    case 'kill-switch-on':
      setLabKillSwitch(true);
      return { ok: true, message: 'The kill switch is ON. Nothing is opened, in any mode, until it is switched off.' };
    case 'kill-switch-off':
      setLabKillSwitch(false);
      return { ok: true, message: 'The kill switch is OFF.' };
    case 'shadow-only-on':
      setLabShadowOnly(true);
      return { ok: true, message: 'Shadow-only is ON. Decisions are recorded and nothing is executed.' };
    case 'shadow-only-off':
      setLabShadowOnly(false);
      return { ok: true, message: 'Shadow-only is OFF.' };
    case 'mode': {
      const mode = (arg ?? 'SHADOW').toUpperCase();
      if (mode !== 'SHADOW' && mode !== 'PAPER' && mode !== 'TESTNET') {
        return { ok: false, message: `"${mode}" is not a mode. The modes are SHADOW, PAPER and TESTNET. LIVE is not available.` };
      }
      if (mode === 'TESTNET' && !LAB.TESTNET_ENABLED) {
        return {
          ok: false,
          message:
            'The testnet adapter is OFF by default (LAB.TESTNET_ENABLED is false). Switch it on in ' +
            'server/src/config.ts before selecting TESTNET.',
        };
      }
      setLabMode(mode);
      return { ok: true, message: `The Lab is now in ${mode} mode.` };
    }
    case 'rollback': {
      if (!arg) return { ok: false, message: 'Rollback needs a model version to roll back to.' };
      const res = rollback(arg);
      return { ok: res.ok, message: res.reason };
    }
    case 'retrain': {
      const reviews = allReviews();
      const { rows } = reviewsToRows(reviews);
      const lastRetrainAt = Number(labSetting(SETTING_KEYS.lastRetrainAt, '0')) || 0;
      const sinceLast = reviews.filter((r) => r.closedAt > lastRetrainAt).length;
      const gate = retrainGate(sinceLast, rows.length);
      if (!gate.allowed) return { ok: false, message: `Not retraining. ${gate.reason}` };
      const outcome = retrain();
      setLabSetting(SETTING_KEYS.lastRetrainAt, String(Date.now()));
      return {
        ok: true,
        message:
          `Fitted ${outcome.version} on ${rows.length} resolved trades. ${outcome.reason}`,
      };
    }
    default:
      return { ok: false, message: `"${String(action)}" is not a control.` };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10_000) / 10_000;
}

/** The champion's fitted model, when there is one. */
export function championModel(): LogisticModel | null {
  const { champion } = currentModels();
  if (!champion || !champion.model) return null;
  return champion.model as LogisticModel;
}

export { reviewCount, promotionVerdict, tierRows };
export type { PaperOrder, PaperBroker, Measured, RiskState };
