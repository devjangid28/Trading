import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lockMod from '../src/runtime/lock.js';
import { ClockWatch } from '../src/runtime/clock.js';

/**
 * Fix 2 — lock, clock watch, supervised-run accounting.
 *
 * The lock tests matter more than they look: a lock that fails OPEN lets a
 * second server start, and two servers is the documented cause of the original
 * 418. The crash tests matter for the same reason in reverse — a lock that
 * fails CLOSED turns one crash into a permanently bricked app.
 */

const T0 = 1_760_000_000_000;

let tmp: string;
let prevLock: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'of-lock-'));
  prevLock = process.env.ORDERFLOW_LOCK;
  // lockPath() reads this per call, so no module re-import is needed.
  process.env.ORDERFLOW_LOCK = join(tmp, 'test.lock');
});

afterEach(() => {
  if (prevLock === undefined) delete process.env.ORDERFLOW_LOCK;
  else process.env.ORDERFLOW_LOCK = prevLock;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('single-instance lock', () => {
  it('grants the lock to the first caller', () => {
    const r = lockMod.acquireLock({ port: 8787, label: 'test' });
    expect(r.ok).toBe(true);
    r.ok && r.release();
  });

it('refuses a second caller and names the holder', () => {
  const first = lockMod.acquireLock({ port: 8787, label: 'orderflow-api' });
  expect(first.ok).toBe(true);

  // A DIFFERENT, live pid is what a second process looks like from here.
  // process.pid is this process (and therefore re-entrant), so the parent is
  // used: it is guaranteed alive for the duration of the test.
  const holderPid = process.ppid;
  const file = join(tmp, 'test.lock');
  writeFileSync(file, JSON.stringify({
    pid: holderPid, startedAt: Date.now() - 65_000,
    host: '127.0.0.1', port: 8787, label: 'orderflow-api',
  }));

  const second = lockMod.acquireLock({ port: 8787, label: 'orderflow-api' });
  expect(second.ok).toBe(false);
  if (!second.ok) {
    expect(second.reason).toMatch(/already running/i);
    expect(second.reason).toContain(`PID ${holderPid}`);
    expect(second.reason).toContain('orderflow-api');
    expect(second.holder?.pid).toBe(holderPid);
    // The stated reason matters: it must say why, not just "no".
    expect(second.reason).toMatch(/418/);
  }
  first.ok && first.release();
});

  it('reclaims a lock whose owner is dead, so a crash cannot brick the app', () => {
    const file = join(tmp, 'test.lock');
    writeFileSync(file, JSON.stringify({
      // A pid that cannot be running: above the Windows max process id.
      pid: 4_294_000_000, startedAt: Date.now() - 3_600_000,
      host: '127.0.0.1', port: 8787, label: 'dead-server',
    }));

    const r = lockMod.acquireLock({ port: 8787, label: 'orderflow-api' });
    expect(r.ok).toBe(true);
    expect(lockMod.currentHolder()?.pid).toBe(process.pid);
    r.ok && r.release();
  });

  it('is re-entrant for the same process', () => {
    const a = lockMod.acquireLock({ port: 8787, label: 'x' });
    const b = lockMod.acquireLock({ port: 8787, label: 'x' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

it('never removes another process\'s lock on release', () => {
  const file = join(tmp, 'test.lock');
    writeFileSync(file, JSON.stringify({
      pid: 4_294_000_000, startedAt: Date.now(), host: '127.0.0.1', port: 1, label: 'other',
    }));
    lockMod.releaseLock();
    // The file must survive: releasing is only ever allowed to clear our own.
    expect(lockMod.currentHolder()?.pid).toBe(4_294_000_000);
  });

  it('describes the holder in a form an operator can act on', () => {
    const d = lockMod.describeHolder({
      pid: 1234, startedAt: T0, host: '127.0.0.1', port: 8787, label: 'orderflow-api',
    });
    expect(d).toContain('PID 1234');
    expect(d).toContain('127.0.0.1:8787');
    expect(d).toContain('orderflow-api');
  });

  it('reports liveness for a pid that does not exist', () => {
    expect(lockMod.pidAlive(4_294_000_000)).toBe(false);
    expect(lockMod.pidAlive(0)).toBe(false);
    expect(lockMod.pidAlive(-1)).toBe(false);
    expect(lockMod.pidAlive(process.pid)).toBe(true);
  });
});

describe('clock watch — sleep, wake and stall detection', () => {
  const mk = (gaps: unknown[]) => {
    // The two clocks are driven explicitly so a 65-minute suspend can be
    // reproduced without suspending the test runner.
    const cw = new ClockWatch({
      intervalMs: 5000,
      stallThresholdMs: 30_000,
      driftThresholdMs: 10_000,
      onGap: (g) => { gaps.push(g); },
      wallNow: () => T0,
      monoNow: () => 1000,
    });
    return { cw, seen: gaps };
  };

  it('sees a suspend: wall clock jumps, monotonic clock does not', () => {
    const gaps: any[] = [];
    const { cw } = mk(gaps);
    // 5s of timer, but 65 minutes of wall time — the machine slept.
    const g = cw.check(T0 + 65 * 60_000, 1000 + 5000);
    expect(g).not.toBeNull();
    expect(g!.kind).toBe('sleep-wake');
    expect(g!.detail).toMatch(/suspended/);
    expect(g!.minutes).toBe(65);
  });

  it('sees a backwards clock change and labels it differently from sleep', () => {
    const gaps: any[] = [];
    const { cw } = mk(gaps);
    // Monotonic advanced 5s, wall went back an hour (NTP correction / user edit).
    const g = cw.check(T0 - 3_600_000, 1000 + 5000);
    expect(g).not.toBeNull();
    expect(g!.kind).toBe('clock-change');
    expect(g!.detail).toMatch(/BACK/);
  });

  it('sees a pure event-loop stall, where both clocks agree but the timer is late', () => {
    const gaps: any[] = [];
    const { cw } = mk(gaps);
    const g = cw.check(T0 + 120_000, 1000 + 120_000);
    expect(g).not.toBeNull();
    expect(g!.kind).toBe('event-loop-stall');
    expect(g!.detail).toMatch(/GC|synchronous/i);
  });

  it('reports nothing for a healthy tick', () => {
    const gaps: any[] = [];
    const { cw } = mk(gaps);
    expect(cw.check(T0 + 5000, 1000 + 5000)).toBeNull();
    expect(cw.check(T0 + 10_000, 1000 + 10_000)).toBeNull();
    expect(gaps).toHaveLength(0);
  });

  it('does not fire twice for one long sleep', () => {
    const gaps: any[] = [];
    const { cw } = mk(gaps);
    cw.check(T0 + 3_600_000, 1000 + 5000);
    // The very next tick is normal again — the hole is reported once, not
    // remembered, so a long sleep does not manufacture a stream of gaps.
    expect(cw.check(T0 + 3_605_000, 1000 + 10_000)).toBeNull();
    expect(gaps).toHaveLength(1);
  });

  it('counts the gaps it has seen', () => {
    const gaps: any[] = [];
    const { cw } = mk(gaps);
    cw.check(T0 + 3_600_000, 1000 + 5000);
    cw.check(T0 + 3_605_000, 1000 + 10_000);
    cw.check(T0 + 7_300_000, 1000 + 3_670_000);
    expect(cw.gapsSeen()).toBe(2);
  });
});

describe('supervisor crash-loop backoff', () => {
  // Mirrors server/scripts/supervisor.ts. Duplicated rather than imported
  // because importing the supervisor would start it.
  const backoff = (n: number) =>
    n <= 0 ? 0 : Math.min(5 * 60_000, 2000 * 2 ** Math.min(n - 1, 8));

  it('does not wait after a healthy run', () => {
    expect(backoff(0)).toBe(0);
  });

  it('grows exponentially with consecutive fast failures', () => {
    expect(backoff(1)).toBe(2_000);
    expect(backoff(2)).toBe(4_000);
    expect(backoff(3)).toBe(8_000);
    expect(backoff(4)).toBe(16_000);
  });

  it('caps at 5 minutes rather than growing without limit', () => {
    expect(backoff(20)).toBe(5 * 60_000);
    expect(backoff(1000)).toBe(5 * 60_000);
  });

  it('keeps every rung under the cap, so no rung is unreachable', () => {
    for (let n = 1; n <= 12; n++) {
      expect(backoff(n)).toBeLessThanOrEqual(5 * 60_000);
      expect(backoff(n)).toBeGreaterThan(0);
    }
  });
});