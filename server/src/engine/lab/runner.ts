/**
 * The Engine Lab's runner: the closed loop.
 *
 * ```
 *   observe ─► decide ─► execute (paper/testnet) ─► review ─► retrain ─► promote
 * ```
 *
 * Each step is one function and each one is called from exactly one place, so
 * the loop cannot acquire a second path.
 *
 * ## SHADOW mode executes nothing
 *
 * In SHADOW the runner still decides and still records the decision; it just
 * does not open a position. That is what makes SHADOW useful: it is the
 * counterfactual arm of the experiment.
 *
 * ## The risk gate runs BEFORE the broker
 *
 * `assessRisk` is consulted before an order is ever submitted. The kill
 * switch, the daily-loss halt, the blackout and the exposure limits are all
 * checked there, so a blocked trade never reaches the venue — not even the
 * paper one.
 */

import { LAB, MIND } from '../../config.js';
import type { AssetRow, Candle, FeatureVector } from '../../../../shared/types.js';
import { fetchKlines } from '../../data/binance.js';
import { PaperBroker, type OrderIntent, type PaperOrder } from './executor.js';
import { assessRisk, type RiskState } from './risk.js';
import { classifyTrade } from './reviews.js';
import {
  appendEquity,
  listPositions,
  openPositions,
  saveFill,
  savePosition,
  saveReview,
  type StoredPosition,
} from './store.js';
import {
  labEquity,
  labKillSwitch,
  labMode,
  labRunning,
  labShadowOnly,
  labStatus,
  setLabEquity,
} from './service.js';
import { featureCoverage } from '../mind/features.js';

/** What one pass of the loop did. */
export interface ConsiderReport {
  /** How many candidates were looked at. */
  considered: number;
  /** How many orders were submitted. */
  submitted: number;
  /** Why each candidate was not taken. */
  skipped: Array<{ symbol: string; side: string; reason: string }>;
}

export interface AdvanceReport {
  /** How many positions were checked. */
  checked: number;
  /** How many positions closed. */
  resolved: number;
  /** How many reviews were written. */
  reviews: number;
  /** Why each position was not closed, when it was not. */
  open: string[];
}

export class LabRunner {
  private readonly broker = new PaperBroker();

  /** Rehydrate the broker from the store, so a restart does not lose the book. */
  constructor() {
    for (const p of openPositions()) {
      this.broker.restore(toPaperOrder(p));
    }
  }

  /** The broker, for the account panel and the tests. */
  get paper(): PaperBroker {
    return this.broker;
  }

  /**
   * The risk state, as the gate sees it.
   *
   * The daily loss comes from the closed positions of the current UTC day, and
   * the equity from the Lab's own account setting.
   */
  riskState(now = Date.now()): RiskState {
    const dayStart = new Date(now);
    dayStart.setUTCHours(LAB.DAILY_RESET_UTC_HOUR, 0, 0, 0);
    const closedToday = listPositions(1000).filter(
      (p) => p.status === 'CLOSED' && p.closedAt !== null && p.closedAt >= dayStart.getTime(),
    );
    return {
      killSwitch: labKillSwitch(),
      realisedPnlUsdToday: closedToday.reduce((a, p) => a + (p.netR ?? 0) * p.riskUsd, 0),
      realisedNetRToday: closedToday.reduce((a, p) => a + (p.netR ?? 0), 0),
      equityUsd: labEquity(),
      openPositions: openPositions().map((p) => ({
        symbol: p.symbol,
        side: p.side,
        sector: p.sector,
        riskUsd: p.riskUsd,
      })),
      macroBlackoutMin: null,
      shadowOnly: labShadowOnly(),
    };
  }

  /**
   * Consider the board.
   *
   * In SHADOW mode the decision is evaluated and recorded, and nothing is
   * submitted. In PAPER mode an order is submitted for every candidate that
   * clears BOTH the actionability gate and the risk gate.
   */
  consider(rows: AssetRow[], now = Date.now()): ConsiderReport {
    const report: ConsiderReport = { considered: 0, submitted: 0, skipped: [] };
    if (!labRunning()) return report;

    const mode = labMode();
    const shadow = mode === 'SHADOW';
    const held = new Set(openPositions().map((p) => `${p.symbol}:${p.side}`));

    for (const row of rows) {
      const mind = row.mind ?? null;
      const plan = row.plan ?? null;
      if (!mind || !plan) continue;
      report.considered++;

      const key = `${row.pair}:${row.side}`;
      if (held.has(key)) {
        report.skipped.push({ symbol: row.pair, side: row.side, reason: 'A position on this symbol and side is already open.' });
        continue;
      }

      if (!mind.actionable) {
        report.skipped.push({
          symbol: row.pair,
          side: row.side,
          reason: 'The actionability gate did not clear: the probability or the expected net R is below its threshold.',
        });
        continue;
      }

      const intent: OrderIntent = {
        signalId: `${row.id}_${row.side}_${now}`,
        symbol: row.pair,
        side: row.side,
        plannedEntry: plan.entryMid,
        stop: plan.stop,
        targets: plan.targets.map((t) => t.price).filter((p) => Number.isFinite(p) && p > 0),
        equityUsd: labEquity(),
        riskPct: LAB.MAX_RISK_PER_TRADE_PCT / 100,
        decidedAt: now,
        sector: row.sector,
        pWin: mind.probability,
        funding8h: row.derivatives?.funding8h ?? null,
      };

      const gate = assessRisk(this.riskState(now), intent);
      if (!gate.allowed) {
        report.skipped.push({ symbol: row.pair, side: row.side, reason: gate.reason });
        continue;
      }

      if (shadow) {
        // SHADOW: the decision is real, the execution is not.
        report.skipped.push({
          symbol: row.pair,
          side: row.side,
          reason: 'SHADOW mode: the decision was taken and recorded, and nothing was executed.',
        });
        continue;
      }

      const submitted = this.broker.submit(intent);
      if (!submitted.ok || !submitted.orderId) {
        report.skipped.push({ symbol: row.pair, side: row.side, reason: submitted.reason ?? 'The order was refused.' });
        continue;
      }
      report.submitted++;

      const order = this.broker.get(submitted.orderId);
      if (order) this.persist(order, row);
    }
    return report;
  }

  /**
   * Advance the book with the latest closed candles.
   *
   * One fetch per symbol, and only for the symbols the Lab actually holds.
   * An empty book fetches nothing.
   */
  async advance(now = Date.now()): Promise<AdvanceReport> {
    const report: AdvanceReport = { checked: 0, resolved: 0, reviews: 0, open: [] };
    const opens = openPositions();
    if (!opens.length) return report;

    const bySymbol = new Map<string, StoredPosition[]>();
    for (const p of opens) {
      const arr = bySymbol.get(p.symbol);
      if (arr) arr.push(p);
      else bySymbol.set(p.symbol, [p]);
    }

    for (const [symbol, list] of bySymbol) {
      const earliest = Math.min(...list.map((p) => p.openedAt));
      const wanted = Math.min(1000, Math.max(60, Math.ceil((now - earliest) / (5 * 60_000)) + 20));
      let candles: Candle[] = [];
      try {
        const raw = await fetchKlines(symbol, '5m', wanted);
        candles = raw.filter((c) => c.closed);
      } catch {
        report.open.push(`${symbol}: the candles could not be fetched, so nothing was resolved.`);
        continue;
      }

      for (const c of candles) {
        report.checked++;
        const touched = this.broker.onCandleClose(c);
        for (const o of touched) {
          const stored = list.find((p) => p.id === o.id) ?? null;
          if (o.status === 'CLOSED') {
            report.resolved++;
            const written = this.writeReview(o, stored);
            if (written) report.reviews++;
          } else {
            this.persist(o, null);
          }
        }
      }
    }
    return report;
  }

  /** Persist an order to the store. */
  private persist(o: PaperOrder, row: AssetRow | null): void {
    const r = PaperBroker.realisedR(o);
    const previous = listPositions(1000).find((p) => p.id === o.id) ?? null;
    savePosition({
      id: o.id,
      signalId: o.signalId,
      symbol: o.symbol,
      side: o.side,
      sector: row?.sector ?? previous?.sector ?? null,
      openedAt: o.decidedAt,
      filledAt: o.filledAt,
      referenceEntry: o.referenceEntry,
      entryPrice: o.entryPrice,
      qty: o.qty,
      riskPerUnit: o.riskPerUnit,
      riskUsd: o.riskUsd,
      stop: o.stop,
      targets: o.targets,
      pWin: o.pWin,
      expectedNetR: row?.mind?.netExpectedR ?? previous?.expectedNetR ?? null,
      venue: 'PAPER',
      status: o.status,
      closedAt: o.closedAt,
      closeReason: o.closeReason,
      referenceExit: o.referenceExit,
      exitPrice: o.exitPrice,
      grossR: r.grossR,
      netR: r.netR,
      costR: r.costR,
      feeUsd: o.feeUsd,
      slippageUsd: o.slippageUsd,
      fundingUsd: o.fundingUsd,
      ambiguous: o.ambiguous,
      // The feature vector frozen at entry. It is stored ON THE POSITION so the
      // review can carry it, and so the "link to the stored feature snapshot"
      // on the reviews panel has something to link to.
      featureSnapshot: row?.mindFeatures ?? previous?.featureSnapshot ?? null,
    });

    if (o.filledAt !== null && o.entryPrice !== null) {
      saveFill({
        id: `${o.id}-entry`,
        at: o.filledAt,
        positionId: o.id,
        symbol: o.symbol,
        side: o.side === 'bullish' ? 'buy' : 'sell',
        price: o.entryPrice,
        qty: o.qty,
        feeUsd: o.feeUsd,
        slippageUsd: o.slippageUsd,
        venue: 'PAPER',
        costNote: 'Costs are MODELLED from LAB/RISK, not measured from a venue.',
      });
    }
    if (o.closedAt !== null && o.exitPrice !== null) {
      saveFill({
        id: `${o.id}-exit`,
        at: o.closedAt,
        positionId: o.id,
        symbol: o.symbol,
        side: o.side === 'bullish' ? 'sell' : 'buy',
        price: o.exitPrice,
        qty: o.qty,
        feeUsd: 0,
        slippageUsd: 0,
        venue: 'PAPER',
        costNote: 'Costs are MODELLED from LAB/RISK, not measured from a venue.',
      });
    }
  }

  /**
   * Write the review for a closed position.
   *
   * The review is the EVIDENCE. It is written once and never edited, and it
   * never touches the model or a threshold.
   */
  private writeReview(o: PaperOrder, stored: StoredPosition | null): boolean {
    const r = PaperBroker.realisedR(o);
    const outcome: 0 | 1 | null =
      o.closeReason === 'TARGET' ? 1 : o.closeReason === 'STOP' ? 0 : null;

    const features = storedFeatureSnapshot(stored);
    const verdict = classifyTrade({
      predictedPWin: o.pWin,
      outcome,
      outcomeLabel: o.closeReason ?? 'CLOSED',
      grossR: r.grossR,
      netR: r.netR,
      costR: r.costR,
      features,
      newsDuringTrade: null,
      regimeAtEntry: features?.regimeLabel ?? null,
      regimeAtExit: null,
      mfeR: null,
      maeR: null,
      coverage: features ? featureCoverage(features) : null,
    });

    saveReview({
      id: `review-${o.id}`,
      signalId: o.signalId,
      positionId: o.id,
      symbol: o.symbol,
      side: o.side,
      openedAt: o.filledAt ?? o.decidedAt,
      closedAt: o.closedAt ?? Date.now(),
      predictedPWin: o.pWin,
      outcome,
      outcomeLabel: o.closeReason ?? 'CLOSED',
      grossR: r.grossR,
      netR: r.netR,
      costR: r.costR,
      failureClass: verdict.failureClass,
      failureNote: verdict.note,
      noFault: verdict.noFault,
      featureSnapshot: features,
      snapshotUrl: features ? `/api/mind/features/${o.symbol}` : null,
      createdAt: Date.now(),
    });

    // The equity curve and the account.
    const pnlUsd = r.netR !== null ? r.netR * o.riskUsd : 0;
    const equity = labEquity() + pnlUsd;
    setLabEquity(equity);
    appendEquity(o.closedAt ?? Date.now(), equity, r.netR ?? 0, pnlUsd);

    return true;
  }
}

/**
 * The frozen feature snapshot for a position.
 *
 * It is stored ON THE POSITION row, at entry, so the review can carry it and
 * the reviews panel can link to it. A position opened before the Lab started
 * recording vectors has none, and the review says so rather than inventing one.
 */
function storedFeatureSnapshot(p: StoredPosition | null): FeatureVector | null {
  if (!p || !p.featureSnapshot) return null;
  return p.featureSnapshot as FeatureVector;
}

/** Turn a stored position back into a broker order, for the rehydration path. */
function toPaperOrder(p: StoredPosition): PaperOrder {
  return {
    id: p.id,
    signalId: p.signalId,
    symbol: p.symbol,
    side: p.side,
    plannedEntry: p.entryPrice ?? 0,
    stop: p.stop,
    targets: p.targets,
    sector: p.sector,
    pWin: p.pWin,
    funding8h: null,
    decidedAt: p.openedAt,
    filledAt: p.filledAt,
    referenceEntry: p.referenceEntry,
    entryPrice: p.entryPrice,
    qty: p.qty,
    riskPerUnit: p.riskPerUnit,
    riskUsd: p.riskUsd,
    feeUsd: p.feeUsd ?? 0,
    slippageUsd: p.slippageUsd ?? 0,
    status: p.status === 'CLOSED' ? 'CLOSED' : p.status === 'OPEN' ? 'OPEN' : 'PENDING',
    closedAt: p.closedAt,
    closeReason: (p.closeReason as PaperOrder['closeReason']) ?? null,
    referenceExit: p.referenceExit,
    exitPrice: p.exitPrice,
    fundingUsd: p.fundingUsd ?? 0,
    ambiguous: p.ambiguous,
  };
}

/** The single runner the server uses. */
export const labRunner = new LabRunner();

let labTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the Lab's clock.
 *
 * Every five minutes, just after a candle close, the open positions are
 * advanced against the latest closed candles and the closed ones are reviewed.
 */
export function startLabWorker(onLog?: (r: AdvanceReport) => void): void {
  if (labTimer) return;
  const run = () => {
    labRunner
      .advance()
      .then((r) => {
        if (r.resolved > 0) onLog?.(r);
      })
      .catch((err) => console.error('[lab] advance failed:', (err as Error).message));
  };
  labTimer = setInterval(run, 5 * 60_000);
  setTimeout(run, 25_000);
}

export function stopLabWorker(): void {
  if (labTimer) clearInterval(labTimer);
  labTimer = null;
}

/** The confidence band the engine uses, for the Lab's own reporting. */
export function labConfidenceBand(): number {
  return MIND.BAND_HIGH;
}

/** The status, for the runner's own logging. */
export function runnerStatus(): ReturnType<typeof labStatus> {
  return labStatus();
}
