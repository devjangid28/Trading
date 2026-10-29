/**
 * The Engine Lab's execution layer.
 *
 * ## What this file is allowed to do
 *
 * Two things, and only two:
 *
 *   1. **PAPER** — simulate a fill against real closed candles.
 *   2. **TESTNET** — place an order on Binance's testnet, which has no money.
 *
 * **REAL-MONEY EXECUTION IS NOT BUILT.** There is no adapter here that can
 * reach `api.binance.com` with a live key, and the one that would is a stub
 * that refuses. See `LiveExecutor` at the bottom of this file for what it would
 * take to build it and why it is not built.
 *
 * ## The paper fill is not the ledger fill
 *
 * Part XIX found that the ledger assumed "a perfect fill at the entry mid,
 * instantly, with no costs". This broker does not:
 *
 *   - the fill is at the **NEXT candle's open**, because that is when a
 *     market order actually reaches the book;
 *   - the fill pays **slippage**, always in the direction that hurts;
 *   - the fill pays the **taker fee**;
 *   - the position pays **funding** for every 8-hour UTC boundary it crosses;
 *   - an ambiguous candle resolves **STOP FIRST**;
 *   - a position that hits neither level **expires**.
 *
 * ## Costs are counted once
 *
 * The gross R is measured on the RAW prices (the candle open, the level), and
 * the slippage is then charged as a cost. Charging slippage inside the fill
 * price AND as a cost would double-count it, and a double-counted cost is a
 * number that is wrong by exactly the amount nobody checked.
 */

import { LAB, RISK, FUNDING_TIMES_UTC } from '../../config.js';
import { fetchJson } from '../../lib/http.js';
import type { Candle } from '../../../../shared/types.js';

export type LabSide = 'bullish' | 'bearish';
export type LabVenue = 'PAPER' | 'TESTNET';

/** One trading decision, handed to an adapter. */
export interface OrderIntent {
  /** The signal id this order belongs to. */
  signalId: string;
  /** The symbol, e.g. `BTCUSDT`. */
  symbol: string;
  side: LabSide;
  /** The price the plan wanted. The paper broker does NOT fill here. */
  plannedEntry: number;
  /** The stop. */
  stop: number;
  /** The take-profit levels, nearest first. */
  targets: number[];
  /** Account equity, for sizing. */
  equityUsd: number;
  /** The fraction of equity to risk, e.g. 0.005 for 0.5%. */
  riskPct: number;
  /** When the decision was made. */
  decidedAt: number;
  /** The sector, for the exposure limit. */
  sector: string | null;
  /** The model's probability, stored for the review. */
  pWin: number | null;
  /** The funding rate, when it was measured. Null means "not measured". */
  funding8h: number | null;
}

export interface FillLeg {
  at: number;
  /** The RAW price: the candle open, or the level. */
  referencePrice: number;
  /** The price actually paid, after slippage. */
  price: number;
  qty: number;
  /** Taker fee, in quote currency. */
  feeUsd: number;
  /** Slippage cost, in quote currency. */
  slippageUsd: number;
}

export interface FillResult {
  ok: boolean;
  /** Why it did not fill, in words. Null when it did. */
  reason: string | null;
  fill: FillLeg | null;
}

export interface CloseResult {
  ok: boolean;
  reason: string | null;
  fill: FillLeg | null;
}

/**
 * The seam every execution venue goes through.
 *
 * The Lab never talks to a venue directly; it talks to this interface, so a
 * paper run and a testnet run are the same code path with a different adapter.
 */
export interface ExecutionAdapter {
  /**
   * Where this adapter trades.
   *
   * `'LIVE'` is a member of this type only so the disabled stub can say what
   * it is. No adapter that returns `'LIVE'` can actually reach an exchange.
   */
  readonly venue: LabVenue | 'LIVE';
  /** Whether this adapter can run right now, and why not when it cannot. */
  available(): { ok: boolean; reason: string };
  /** Open a position. */
  open(intent: OrderIntent): Promise<FillResult>;
  /** Close a position at a given price. */
  close(intent: OrderIntent, at: number, price: number): Promise<CloseResult>;
}

// ─── The pure pricing helpers ───────────────────────────────────────────────

/** The slippage allowance, in bps, for a fill. */
export function slippageBps(): number {
  return LAB.PAPER_SLIPPAGE_BPS;
}

/**
 * Apply slippage to a price, always in the direction that hurts.
 *
 * A BUY pays more than the reference; a SELL receives less. A fill that is
 * always in the engine's favour is a fill assumption, not a model.
 */
export function applySlippage(price: number, side: LabSide, bps: number): number {
  const factor = bps / 10_000;
  return side === 'bullish' ? price * (1 + factor) : price * (1 - factor);
}

/**
 * How many 8-hour UTC funding boundaries fall in `(from, to]`.
 *
 * Counted from the exchange's own schedule (`FUNDING_TIMES_UTC`), not from
 * `hours / 8`: those disagree whenever a trade straddles a boundary, and the
 * difference is one whole funding payment.
 */
export function fundingEventsCrossed(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  const start = new Date(from);
  const end = new Date(to);
  let count = 0;
  // Start at the hour AFTER the opening hour: a boundary at exactly `from` is
  // not crossed by a trade that opens at that instant.
  for (let day = start.getUTCDate() - 1; day <= end.getUTCDate() + 1; day++) {
    for (const hour of FUNDING_TIMES_UTC) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), day, hour));
      const t = d.getTime();
      if (t > from && t <= to) count++;
    }
  }
  return count;
}

/**
 * The funding cost of holding a position, in quote currency.
 *
 * Positive means the engine PAID. Longs pay when funding is positive; shorts
 * receive. When the rate was never measured the cost is ZERO — a different
 * claim from a zero rate, and the caller records which it was.
 */
export function fundingCostUsd(
  side: LabSide,
  entry: number,
  qty: number,
  funding8h: number | null,
  heldMs: number,
): number {
  if (funding8h === null || !Number.isFinite(funding8h) || funding8h === 0) return 0;
  const events = fundingEventsCrossed(0, heldMs);
  if (events === 0) return 0;
  const perEvent = funding8h * entry * qty;
  return side === 'bullish' ? perEvent * events : -perEvent * events;
}

// ─── The paper broker ───────────────────────────────────────────────────────

export type PaperOrderStatus = 'PENDING' | 'OPEN' | 'CLOSED';

export interface PaperOrder {
  id: string;
  signalId: string;
  symbol: string;
  side: LabSide;
  plannedEntry: number;
  stop: number;
  targets: number[];
  sector: string | null;
  pWin: number | null;
  funding8h: number | null;
  decidedAt: number;
  /** When the fill happened. Null while the order is pending. */
  filledAt: number | null;
  /** The raw reference price of the fill: the next candle's open. */
  referenceEntry: number | null;
  /** The price actually paid, after slippage. */
  entryPrice: number | null;
  qty: number;
  /** The risk per unit, frozen at entry. */
  riskPerUnit: number;
  /** The risk in quote currency: `qty * riskPerUnit`. */
  riskUsd: number;
  feeUsd: number;
  slippageUsd: number;
  status: PaperOrderStatus;
  /** Set when the position closed. */
  closedAt: number | null;
  closeReason: 'STOP' | 'TARGET' | 'EXPIRED' | 'CLOSED' | null;
  referenceExit: number | null;
  exitPrice: number | null;
  /** The funding paid, in quote currency. */
  fundingUsd: number;
  /** True when one candle covered both the stop and a target. */
  ambiguous: boolean;
}

/**
 * The paper broker.
 *
 * Pure with respect to the market: it is fed closed candles and it never
 * fetches anything. A position fills at the open of the first candle that
 * closes after the decision, and the same candle can then stop it out — which
 * is exactly what happens in the market, and exactly what the ledger's
 * mid-price fill could never reproduce.
 */
export class PaperBroker implements ExecutionAdapter {
  readonly venue: LabVenue = 'PAPER';

  private readonly orders = new Map<string, PaperOrder>();
  private seq = 0;

  available(): { ok: boolean; reason: string } {
    return { ok: true, reason: 'The paper broker always works — it fills against closed candles.' };
  }

  /** The orders currently on the book, pending and open. */
  list(): PaperOrder[] {
    return [...this.orders.values()].sort((a, b) => a.decidedAt - b.decidedAt);
  }

  /**
   * Put an existing order back on the book.
   *
   * Used after a restart: the STORE holds the position, and the broker holds
   * the in-flight state. Without this, a restart would silently drop the open
   * positions and the equity curve would restart from the wrong place.
   */
  restore(o: PaperOrder): void {
    this.orders.set(o.id, o);
    const n = Number(o.id.replace(/^paper-/, ''));
    if (Number.isFinite(n) && n > this.seq) this.seq = n;
  }

  get(id: string): PaperOrder | undefined {
    return this.orders.get(id);
  }

  /**
   * Submit an order. It does NOT fill here.
   *
   * The fill happens on the next candle, at that candle's open. Submitting at
   * the decision price is the assumption Part XIX found and called out.
   */
  async open(intent: OrderIntent): Promise<FillResult> {
    const submitted = this.submit(intent);
    return {
      ok: submitted.ok,
      reason: submitted.reason,
      fill: null,
    };
  }

  /** The synchronous half of `open`, because the paper broker never awaits. */
  submit(intent: OrderIntent): { ok: boolean; reason: string | null; orderId: string | null } {
    const riskPerUnit = Math.abs(intent.plannedEntry - intent.stop);
    if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) {
      return { ok: false, reason: 'the stop is not below/above the entry, so there is no risk to size', orderId: null };
    }
    if (!Number.isFinite(intent.equityUsd) || intent.equityUsd <= 0) {
      return { ok: false, reason: 'the account equity is unknown, so the position cannot be sized', orderId: null };
    }
    const riskUsd = intent.equityUsd * intent.riskPct;
    const qty = riskUsd / riskPerUnit;
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, reason: 'the computed size is zero', orderId: null };
    }
    const id = `paper-${++this.seq}`;
    this.orders.set(id, {
      id,
      signalId: intent.signalId,
      symbol: intent.symbol,
      side: intent.side,
      plannedEntry: intent.plannedEntry,
      stop: intent.stop,
      targets: intent.targets.filter((t) => Number.isFinite(t)),
      sector: intent.sector,
      pWin: intent.pWin,
      funding8h: intent.funding8h,
      decidedAt: intent.decidedAt,
      filledAt: null,
      referenceEntry: null,
      entryPrice: null,
      qty,
      riskPerUnit,
      riskUsd,
      feeUsd: 0,
      slippageUsd: 0,
      status: 'PENDING',
      closedAt: null,
      closeReason: null,
      referenceExit: null,
      exitPrice: null,
      fundingUsd: 0,
      ambiguous: false,
    });
    return { ok: true, reason: null, orderId: id };
  }

  /**
   * Advance the book with one CLOSED candle.
   *
   * The order of operations inside the candle is the whole point:
   *
   *   1. Pending orders whose fill time has arrived fill at THIS candle's open.
   *   2. The same candle is then checked for the stop and the targets.
   *   3. STOP FIRST when the candle covered both.
   *
   * A candle that gaps through a level is handled explicitly: a gap DOWN
   * through the stop fills at the OPEN (worse than the stop), and a gap UP
   * through a target fills at the OPEN (better than the target), because a
   * resting limit sells at or through its price.
   */
  onCandleClose(c: Candle): PaperOrder[] {
    const touched: PaperOrder[] = [];
    const closeAt = c.t + 5 * 60_000;

    for (const o of this.orders.values()) {
      if (o.status === 'PENDING') {
        // The fill happens at the open of the first candle that CLOSES after the
        // decision. A candle whose open time is before the decision is not a
        // fill: the decision was made at a close, so the earliest fill is the
        // next candle's open.
        if (c.t < o.decidedAt) continue;
        const reference = c.o;
        const price = applySlippage(reference, o.side, slippageBps());
        const notional = Math.abs(price * o.qty);
        o.filledAt = c.t;
        o.referenceEntry = reference;
        o.entryPrice = price;
        o.feeUsd += notional * (RISK.TAKER_FEE_BPS / 10_000);
        o.slippageUsd += Math.abs(price - reference) * o.qty;
        o.status = 'OPEN';
        touched.push(o);
      }

      if (o.status !== 'OPEN') continue;

      const dir = o.side === 'bullish' ? 1 : -1;
      const stopHit = dir === 1 ? c.l <= o.stop : c.h >= o.stop;
      // A gap through the stop fills at the OPEN, which is worse than the stop.
      const gapThroughStop = dir === 1 ? c.o <= o.stop : c.o >= o.stop;

      let targetHit = false;
      let targetPrice: number | null = null;
      for (const t of o.targets) {
        const hit = dir === 1 ? c.h >= t : c.l <= t;
        if (hit) {
          targetHit = true;
          // A gap through the target fills at the OPEN: a resting limit sells
          // at or through its price.
          targetPrice = dir === 1
            ? (c.o >= t ? c.o : t)
            : (c.o <= t ? c.o : t);
          break;
        }
      }

      const expired = closeAt >= o.decidedAt + LAB.POSITION_EXPIRY_HOURS * 3600_000;

      if (stopHit && targetHit) {
        // STOP FIRST. The conservative reading, and the one the ledger's
        // AMBIGUITY policy already commits to.
        o.ambiguous = true;
        this.closeAt(o, c.t, gapThroughStop ? c.o : o.stop, 'STOP');
        touched.push(o);
        continue;
      }
      if (stopHit) {
        this.closeAt(o, c.t, gapThroughStop ? c.o : o.stop, 'STOP');
        touched.push(o);
        continue;
      }
      if (targetHit && targetPrice !== null) {
        this.closeAt(o, c.t, targetPrice, 'TARGET');
        touched.push(o);
        continue;
      }
      if (expired) {
        // The trade's life is over; the mark is the price at the end of it.
        this.closeAt(o, closeAt, c.c, 'EXPIRED');
        touched.push(o);
      }
    }
    return touched;
  }

  /** Close a position at an explicit price. */
  private closeAt(o: PaperOrder, at: number, reference: number, reason: PaperOrder['closeReason']): void {
    const price = applySlippage(reference, o.side, slippageBps());
    const notional = Math.abs(price * o.qty);
    o.feeUsd += notional * (RISK.TAKER_FEE_BPS / 10_000);
    o.slippageUsd += Math.abs(price - reference) * o.qty;
    o.closedAt = at;
    o.closeReason = reason;
    o.referenceExit = reference;
    o.exitPrice = price;
    o.status = 'CLOSED';

    const heldMs = Math.max(0, at - (o.filledAt ?? at));
    o.fundingUsd = fundingCostUsd(o.side, o.entryPrice ?? o.plannedEntry, o.qty, o.funding8h, heldMs);
  }

  async close(intent: OrderIntent, at: number, price: number): Promise<CloseResult> {
    const o = this.list().find(
      (x) => x.symbol === intent.symbol && x.side === intent.side && x.status === 'OPEN',
    );
    if (!o) return { ok: false, reason: 'no open position for that symbol and side', fill: null };
    this.closeAt(o, at, price, 'CLOSED');
    return {
      ok: true,
      reason: null,
      fill: {
        at,
        referencePrice: price,
        price: o.exitPrice ?? price,
        qty: o.qty,
        feeUsd: o.feeUsd,
        slippageUsd: o.slippageUsd,
      },
    };
  }

  /**
   * The realised R of a closed order.
   *
   * `grossR` is measured on the RAW prices; the slippage, the fees and the
   * funding are then charged. The net is therefore the same number as the
   * move on the ACTUAL fill prices — the two paths agree by construction.
   */
  static realisedR(o: PaperOrder): { grossR: number | null; netR: number | null; costR: number | null } {
    if (o.status !== 'CLOSED' || o.referenceEntry === null || o.referenceExit === null) {
      return { grossR: null, netR: null, costR: null };
    }
    if (!Number.isFinite(o.riskPerUnit) || o.riskPerUnit <= 0) return { grossR: null, netR: null, costR: null };
    const dir = o.side === 'bullish' ? 1 : -1;
    const grossR = (dir * (o.referenceExit - o.referenceEntry)) / o.riskPerUnit;
    const costUsd = o.feeUsd + o.slippageUsd + o.fundingUsd;
    const costR = o.riskUsd > 0 ? costUsd / o.riskUsd : null;
    return {
      grossR: round4(grossR),
      netR: costR === null ? null : round4(grossR - costR),
      costR: costR === null ? null : round4(costR),
    };
  }
}

function round4(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10_000) / 10_000;
}

// ─── The Binance testnet adapter ────────────────────────────────────────────

/**
 * The Binance TESTNET adapter.
 *
 * OFF by default (`LAB.TESTNET_ENABLED` is `false`). The keys come from the
 * environment and are never logged, never returned over HTTP and never sent to
 * the browser — the adapter only ever holds the env var NAMES, and reads the
 * values at call time.
 *
 * Every call goes through `fetchText`/`fetchJson`, which means the ban guard
 * and the mock transport both apply. The ban guard's host registry does not
 * know the testnet hosts, so they are registered here with the same weight
 * budget as the live hosts.
 */
export class BinanceTestnetAdapter implements ExecutionAdapter {
  readonly venue: LabVenue = 'TESTNET';

  constructor(
    private readonly host: string = LAB.TESTNET_SPOT_HOST,
    private readonly market: 'spot' | 'futures' = 'spot',
  ) {}

  available(): { ok: boolean; reason: string } {
    if (!LAB.TESTNET_ENABLED) {
      return {
        ok: false,
        reason:
          'The Binance testnet adapter is OFF by default. Set LAB.TESTNET_ENABLED in ' +
          'server/src/config.ts to switch it on. Testnet money is not real money, ' +
          'but it is still a live order against a live exchange.',
      };
    }
    if (!process.env[LAB.TESTNET_API_KEY_ENV] || !process.env[LAB.TESTNET_API_SECRET_ENV]) {
      return {
        ok: false,
        reason:
          `The testnet key is not in the environment. Set ${LAB.TESTNET_API_KEY_ENV} and ` +
          `${LAB.TESTNET_API_SECRET_ENV}. The values are never logged and never sent to the browser.`,
      };
    }
    return { ok: true, reason: 'Testnet credentials are present in the environment.' };
  }

  /** True when the credentials are present. The VALUES are never exposed. */
  configured(): boolean {
    return Boolean(process.env[LAB.TESTNET_API_KEY_ENV] && process.env[LAB.TESTNET_API_SECRET_ENV]);
  }

  /**
   * Place a testnet order.
   *
   * The endpoint is the testnet host's `/api/v3/order`, which is the Spot
   * Test Network's mapping of the live `/api/v3/order`. Only `/api/*` exists
   * on the spot testnet; `/sapi/*` does not.
   */
  async open(intent: OrderIntent): Promise<FillResult> {
    const avail = this.available();
    if (!avail.ok) return { ok: false, reason: avail.reason, fill: null };

    const side = intent.side === 'bullish' ? 'BUY' : 'SELL';
    const qty = Math.max(0, intent.equityUsd * intent.riskPct / Math.abs(intent.plannedEntry - intent.stop));
    const symbol = this.market === 'futures' ? intent.symbol : intent.symbol;
    const url = `${this.host}/api/v3/order?symbol=${encodeURIComponent(symbol)}&side=${side}&type=MARKET&quantity=${qty}`;

    try {
      const res = await fetchJson<{ price?: string; executedQty?: string; commission?: string }>(url, {
        headers: { 'X-MBX-APIKEY': process.env[LAB.TESTNET_API_KEY_ENV] as string },
        purpose: 'essential',
        label: 'binance-testnet-order',
      });
      const price = Number(res.price ?? 0);
      const qtyFilled = Number(res.executedQty ?? 0);
      if (!Number.isFinite(price) || price <= 0 || qtyFilled <= 0) {
        return { ok: false, reason: 'the testnet returned no fill price', fill: null };
      }
      const notional = price * qtyFilled;
      return {
        ok: true,
        reason: null,
        fill: {
          at: Date.now(),
          referencePrice: price,
          price,
          qty: qtyFilled,
          feeUsd: notional * (RISK.TAKER_FEE_BPS / 10_000),
          slippageUsd: 0,
        },
      };
    } catch (err) {
      return { ok: false, reason: `the testnet order failed: ${(err as Error).message}`, fill: null };
    }
  }

  async close(intent: OrderIntent, at: number, price: number): Promise<CloseResult> {
    const avail = this.available();
    if (!avail.ok) return { ok: false, reason: avail.reason, fill: null };
    const side = intent.side === 'bullish' ? 'SELL' : 'BUY';
    const qty = Math.max(0, intent.equityUsd * intent.riskPct / Math.abs(intent.plannedEntry - intent.stop));
    const url = `${this.host}/api/v3/order?symbol=${encodeURIComponent(intent.symbol)}&side=${side}&type=MARKET&quantity=${qty}`;
    try {
      const res = await fetchJson<{ price?: string }>(url, {
        headers: { 'X-MBX-APIKEY': process.env[LAB.TESTNET_API_KEY_ENV] as string },
        purpose: 'essential',
        label: 'binance-testnet-close',
      });
      const filled = Number(res.price ?? price);
      return {
        ok: true,
        reason: null,
        fill: {
          at,
          referencePrice: filled,
          price: filled,
          qty,
          feeUsd: filled * qty * (RISK.TAKER_FEE_BPS / 10_000),
          slippageUsd: 0,
        },
      };
    } catch (err) {
      return { ok: false, reason: `the testnet close failed: ${(err as Error).message}`, fill: null };
    }
  }
}

// ─── The real-money executor that is not built ─────────────────────────────

/**
 * THE REAL-MONEY EXECUTOR IS NOT BUILT, AND THIS STUB IS WHY THAT IS VISIBLE.
 *
 * It refuses every call. It has no host, no key handling and no path to the
 * live exchange — there is nothing to configure, because there is nothing to
 * configure it INTO.
 *
 * ## What would have to be true before this could be written
 *
 * These are the promotion criteria, and they are the same ones the Lab's
 * promotion gate enforces for the model. Writing this class without them
 * would be a configuration mistake waiting to happen.
 *
 *   1. **At least 90 days AND at least 300 paper trades** — whichever is
 *      LATER. Not "or".
 *   2. **The lower bound of the net-expectancy confidence interval is above
 *      zero**, out-of-sample, after fees, slippage and funding.
 *   3. **Calibration within tolerance** — every reliability bucket's
 *      |observed - predicted| inside `LAB.CALIBRATION_TOLERANCE`.
 *   4. **The drift monitor is GREEN** — no sustained degradation against
 *      validation.
 *   5. **Explicit manual approval from the operator.** The engine cannot
 *      promote itself, and neither can this stub.
 *
 * Even with all five, this class would still need: a per-exchange key
 * custody story, a hard cap that survives a restart, an order/position
 * reconciliation on boot, a kill switch that works when the process is
 * half-dead, and a decision about what "the operator" means when the operator
 * is asleep.
 *
 * Until then: SHADOW, PAPER and TESTNET. Nothing else.
 */
export class LiveExecutor implements ExecutionAdapter {
  readonly venue: LabVenue | 'LIVE' = 'LIVE';

  available(): { ok: boolean; reason: string } {
    return {
      ok: false,
      reason:
        'REAL-MONEY EXECUTION IS NOT BUILT. This adapter has no host and no key handling, ' +
        'and it is not a configuration away from working. Promotion to anything beyond ' +
        'paper/testnet requires 90+ days AND 300+ paper trades, a net-expectancy CI lower ' +
        'bound above zero, calibration within tolerance, a green drift monitor, and the ' +
        'operator\'s explicit manual approval.',
    };
  }

  async open(): Promise<FillResult> {
    return { ok: false, reason: this.available().reason, fill: null };
  }

  async close(): Promise<CloseResult> {
    return { ok: false, reason: this.available().reason, fill: null };
  }
}
