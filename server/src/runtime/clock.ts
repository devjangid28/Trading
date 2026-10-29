import { performance } from 'node:perf_hooks';

/**
 * Sleep / wake and event-loop-stall detection.
 *
 * A laptop that suspends does not tell Node anything useful. `setInterval` simply
 * stops firing and then fires late, and every timer the app owns silently
 * develops a hole. For the ledger that hole is not cosmetic: a signal that hit
 * its stop or target while the machine was asleep would otherwise be recorded as
 * still open, and MFE/MAE would understate what the trade actually did.
 *
 * Two independent signals are used, because either alone has a blind spot:
 *
 *   1. MONOTONIC vs WALL CLOCK DRIFT. `performance.now()` does not advance
 *      during suspend on Windows; `Date.now()` jumps by however long the
 *      machine was asleep. A divergence of more than a few seconds is a
 *      definite sleep/wake or a clock change, and it is detected immediately
 *      on the next tick â€” including the first tick after the machine comes
 *      back.
 *
 *   2. TICK LATENCY. A pure event-loop stall (a long GC, a synchronous scan)
 *      moves the wall clock and the monotonic clock together, so it is invisible
 *      to the drift check but obvious as a late timer.
 *
 * A gap is reported, never silently smoothed over.
 */

export interface GapEvent {
  kind: 'sleep-wake' | 'event-loop-stall' | 'clock-change';
  /** Wall-clock ms before the gap. */
  fromTs: number;
  /** Wall-clock ms after the gap. */
  toTs: number;
  minutes: number;
  /** What we believe happened, for the log. */
  detail: string;
}

export interface ClockWatchOptions {
  /** Expected timer spacing. The gap threshold is derived from it. */
  intervalMs: number;
  /** How late a tick may be before it counts as a stall. */
  stallThresholdMs?: number;
  /** Monotonic-vs-wall divergence that counts as a sleep/wake. */
  driftThresholdMs?: number;
  onGap: (gap: GapEvent) => void;
  log?: (message: string) => void;
  /**
   * Clock sources, injectable so a test can reproduce a 65-minute suspend
   * without suspending a machine. Defaults are the real ones.
   */
  wallNow?: () => number;
  monoNow?: () => number;
}

export class ClockWatch {
  private lastWall: number;
  private lastMono: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: ClockWatchOptions;
  private gapCount = 0;

  constructor(opts: ClockWatchOptions) {
    this.opts = opts;
    this.lastWall = this.wallNow();
    this.lastMono = this.monoNow();
  }

  private get wallNow(): () => number {
    return this.opts.wallNow ?? Date.now;
  }

  private get monoNow(): () => number {
    return this.opts.monoNow ?? (() => performance.now());
  }

  /** Thresholds, derived so a slow timer is not mistaken for a sleep. */
  private get stallThreshold(): number {
    return this.opts.stallThresholdMs ?? Math.max(30_000, this.opts.intervalMs * 6);
  }

  private get driftThreshold(): number {
    return this.opts.driftThresholdMs ?? 10_000;
  }

  start(): void {
    if (this.timer) return;
    this.lastWall = this.wallNow();
    this.lastMono = this.monoNow();
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
    // Never hold the process open just to watch the clock.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Compare the two clocks and report any hole.
   *
   * Exposed so a test can drive it with a chosen wall/monotonic pair instead of
   * actually suspending a machine.
   */
  check(nowWall = this.wallNow(), nowMono = this.monoNow()): GapEvent | null {
    const wallDelta = nowWall - this.lastWall;
    const monoDelta = nowMono - this.lastMono;
    const drift = wallDelta - monoDelta;
    const from = this.lastWall;
    const to = nowWall;

    let gap: GapEvent | null = null;

    if (Math.abs(drift) > this.driftThreshold) {
      // Wall clock moved without the monotonic clock following: the machine
      // slept, or the system clock was changed under us. A backwards jump is
      // reported separately because it corrupts every "since" calculation.
      const minutes = Math.round(Math.abs(drift) / 60_000);
      gap = {
        kind: drift > 0 ? 'sleep-wake' : 'clock-change',
        fromTs: from,
        toTs: to,
        minutes,
        detail: drift > 0
          ? `monotonic clock advanced ${Math.round(monoDelta)}ms while wall advanced ${Math.round(wallDelta)}ms ` +
            `(drift ${Math.round(drift / 1000)}s) â€” the machine was suspended`
          : `wall clock moved BACK ${Math.round(-drift / 1000)}s while monotonic advanced normally ` +
            'â€” system clock changed, not sleep',
      };
    } else if (wallDelta > this.stallThreshold) {
      // Both clocks moved together, but later than any timer should: a genuine
      // event-loop stall rather than a sleep.
      gap = {
        kind: 'event-loop-stall',
        fromTs: from,
        toTs: to,
        minutes: Math.round(wallDelta / 60_000),
        detail:
          `a scheduled ${this.opts.intervalMs}ms tick arrived ${Math.round(wallDelta / 1000)}s late ` +
          '(long synchronous work or GC; not a suspend, because the monotonic clock agrees)',
      };
    }

    this.lastWall = nowWall;
    this.lastMono = nowMono;

    if (gap) {
      this.gapCount++;
      this.opts.log?.(`[clock] ${gap.kind}: ${gap.detail}`);
      this.opts.onGap(gap);
    }
    return gap;
  }

  private tick(): void {
    this.check();
  }

  gapsSeen(): number {
    return this.gapCount;
  }
}

/** Format an instant in IST, for the health endpoint and the self-check. */
export function formatIstGap(ts: number): string {
  return new Date(ts + 330 * 60_000).toISOString().replace('T', ' ').slice(0, 19) + ' IST';
}
