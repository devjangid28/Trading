/**
 * The Engine Lab's risk gate.
 *
 * ## The gate runs BEFORE the adapter
 *
 * This is the whole design. The kill switch is checked here, not inside the
 * paper broker and not inside the testnet adapter, so a kill switch works even
 * when the adapter is broken, when the adapter is a stub, or when there is no
 * adapter at all.
 *
 * ## Every limit is a number in `server/src/config.ts`
 *
 * `LAB.MAX_RISK_PER_TRADE_PCT`, `LAB.MAX_CONCURRENT_POSITIONS`,
 * `LAB.MAX_SECTOR_EXPOSURE_PCT`, `LAB.MAX_DAILY_LOSS_PCT` and
 * `LAB.KILL_SWITCH` are the only place any of those numbers exist. This file
 * reads them; it never defines one.
 *
 * ## The daily loss is measured in USD, not in R
 *
 * A percentage of equity is a USD quantity. The Lab tracks both — the USD
 * P&L and the net R — and the HALT is driven by the USD number, because that
 * is the one the percentage is about. The R figure is reported beside it.
 */

import { LAB, MIND } from '../../config.js';
import type { OrderIntent } from './executor.js';

/** One open position, as the risk gate sees it. */
export interface RiskPosition {
  symbol: string;
  side: 'bullish' | 'bearish';
  sector: string | null;
  /** The money at risk on this position, in USD. */
  riskUsd: number;
}

/** Everything the gate needs to know. */
export interface RiskState {
  /** The kill switch. True means nothing is opened, in any mode. */
  killSwitch: boolean;
  /** Realised P&L on the current UTC day, in USD. Negative is a loss. */
  realisedPnlUsdToday: number;
  /** Realised net R on the current UTC day. */
  realisedNetRToday: number;
  /** Account equity, in USD. */
  equityUsd: number;
  /** The open positions. */
  openPositions: RiskPosition[];
  /**
   * Minutes until the next tier-1 release.
   *
   * Negative once inside the window. Null when the calendar is not attached,
   * which is NOT the same as "no blackout" — but it also must not silently
   * open the gate, so the caller decides what a missing calendar means.
   */
  macroBlackoutMin: number | null;
  /** Shadow-only mode: decisions are recorded, nothing is executed. */
  shadowOnly: boolean;
}

export type RiskRule =
  | 'KILL_SWITCH'
  | 'DAILY_LOSS_HALT'
  | 'SHADOW_ONLY'
  | 'MACRO_BLACKOUT'
  | 'MAX_CONCURRENT_POSITIONS'
  | 'MAX_SECTOR_EXPOSURE'
  | 'MAX_RISK_PER_TRADE';

export interface RiskDecision {
  /** True when the order may go to the adapter. */
  allowed: boolean;
  /** Which rule decided it. Null when it was allowed. */
  rule: RiskRule | null;
  /** Why, in words. */
  reason: string;
}

/**
 * The daily-loss limit, in USD.
 *
 * A percentage of the CURRENT equity, so a loss makes the limit smaller and a
 * gain makes it larger. That is the conservative direction for the limit and
 * the standard one for a daily loss cap.
 */
export function dailyLossLimitUsd(equityUsd: number): number {
  if (!Number.isFinite(equityUsd) || equityUsd <= 0) return 0;
  return equityUsd * (LAB.MAX_DAILY_LOSS_PCT / 100);
}

/**
 * Is the engine halted for the day?
 *
 * Halted when the realised loss has REACHED the limit. The comparison is
 * `<=`, so hitting the limit exactly halts.
 */
export function dailyLossHalted(state: RiskState): { halted: boolean; limitUsd: number; reason: string | null } {
  const limitUsd = dailyLossLimitUsd(state.equityUsd);
  if (limitUsd <= 0) {
    // No equity means no account to lose money on. That is a data problem, not
    // a halt, and it is reported as "not halted" with no reason.
    return { halted: false, limitUsd, reason: null };
  }
  if (state.realisedPnlUsdToday <= -limitUsd) {
    return {
      halted: true,
      limitUsd,
      reason:
        `Daily loss limit reached: realised ${fmtUsd(state.realisedPnlUsdToday)} against a ` +
        `limit of ${fmtUsd(-limitUsd)} (${LAB.MAX_DAILY_LOSS_PCT}% of equity). The engine is ` +
        `halted until the UTC day resets.`,
    };
  }
  return { halted: false, limitUsd, reason: null };
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

/**
 * The gate.
 *
 * Checks cheapest and most absolute first: the kill switch, then the daily
 * halt, then shadow-only, then the macro blackout, then the exposure limits.
 * The order matters because the kill switch must be able to stop the engine
 * even when everything else is fine.
 */
export function assessRisk(state: RiskState, intent: OrderIntent): RiskDecision {
  // 1. The kill switch. Nothing else matters while it is on.
  if (state.killSwitch) {
    return {
      allowed: false,
      rule: 'KILL_SWITCH',
      reason: 'The kill switch is on. Nothing is opened in any mode.',
    };
  }

  // 2. The daily-loss halt.
  const halt = dailyLossHalted(state);
  if (halt.halted) {
    return { allowed: false, rule: 'DAILY_LOSS_HALT', reason: halt.reason ?? 'halted for the day' };
  }

  // 3. Shadow-only. Decisions are recorded; nothing is executed.
  if (state.shadowOnly) {
    return {
      allowed: false,
      rule: 'SHADOW_ONLY',
      reason: 'Shadow-only mode: the decision is recorded and nothing is executed.',
    };
  }

  // 4. The macro blackout. `macroBlackoutMin` is negative once inside the
  //    window, so `>= 0` means "outside it".
  if (state.macroBlackoutMin !== null && state.macroBlackoutMin <= 0) {
    return {
      allowed: false,
      rule: 'MACRO_BLACKOUT',
      reason:
        `A tier-1 macro release is inside the blackout window ` +
        `(${Math.abs(state.macroBlackoutMin)} minutes). No trade is taken.`,
    };
  }

  // 5. Concurrent positions.
  if (state.openPositions.length >= LAB.MAX_CONCURRENT_POSITIONS) {
    return {
      allowed: false,
      rule: 'MAX_CONCURRENT_POSITIONS',
      reason:
        `${state.openPositions.length} positions are already open and the limit is ` +
        `${LAB.MAX_CONCURRENT_POSITIONS}.`,
    };
  }

  // 6. Risk per trade.
  const riskPerUnit = Math.abs(intent.plannedEntry - intent.stop);
  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) {
    return {
      allowed: false,
      rule: 'MAX_RISK_PER_TRADE',
      reason: 'The plan has no stop distance, so the risk on the trade is not a number.',
    };
  }
  const riskUsd = state.equityUsd * intent.riskPct;
  const riskPct = state.equityUsd > 0 ? (riskUsd / state.equityUsd) * 100 : Infinity;
  if (riskPct > LAB.MAX_RISK_PER_TRADE_PCT) {
    return {
      allowed: false,
      rule: 'MAX_RISK_PER_TRADE',
      reason:
        `This trade would risk ${riskPct.toFixed(3)}% of equity and the limit is ` +
        `${LAB.MAX_RISK_PER_TRADE_PCT}%.`,
    };
  }

  // 7. Sector exposure.
  if (intent.sector) {
    const sectorRisk = state.openPositions
      .filter((p) => p.sector === intent.sector)
      .reduce((a, p) => a + p.riskUsd, 0);
    const sectorPct = state.equityUsd > 0 ? ((sectorRisk + riskUsd) / state.equityUsd) * 100 : Infinity;
    if (sectorPct > LAB.MAX_SECTOR_EXPOSURE_PCT) {
      return {
        allowed: false,
        rule: 'MAX_SECTOR_EXPOSURE',
        reason:
          `This trade would put ${sectorPct.toFixed(1)}% of equity into ${intent.sector} and ` +
          `the limit is ${LAB.MAX_SECTOR_EXPOSURE_PCT}%.`,
      };
    }
  }

  return {
    allowed: true,
    rule: null,
    reason: `Risk checks passed. Risk on this trade is ${riskPct.toFixed(3)}% of equity.`,
  };
}

/**
 * The probability at or above which the engine is willing to act.
 *
 * `MIND.ACTIONABLE_MIN_PROBABILITY` is the existing gate. The Lab reports the
 * tier thresholds separately, because a tier is a REPORTING device and the
 * actionability gate is a DECISION device, and conflating them is how a
 * reporting threshold starts silently moving the engine.
 */
export function actionableProbability(): number {
  return MIND.ACTIONABLE_MIN_PROBABILITY;
}
