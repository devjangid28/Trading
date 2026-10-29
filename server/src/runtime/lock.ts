import { openSync, writeFileSync, readFileSync, closeSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Single-instance lock.
 *
 * Why this exists, stated bluntly: more than one server hitting Binance is what
 * caused the 418 in the first place. Two processes each running a full 56-symbol
 * scan double the request weight with no way for either to know about the other,
 * and neither sees the other's rate-limit response before it is too late.
 *
 * So the second launch must not start. It must say who is holding the lock,
 * because "address already in use" from Express arrives far too late â€” after
 * the sockets are already open.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCK = resolve(HERE, '../../../data/orderflow.lock');

/**
 * Resolved per call rather than once at module load.
 *
 * Reading the env var at import time made the path impossible to change after
 * the module was loaded, which in turn made the lock untestable. A test that
 * cannot set the path is a test that ends up writing to the real lock file and
 * locking the developer's own running server out of existence.
 */
export function lockPath(): string {
  return process.env.ORDERFLOW_LOCK ?? DEFAULT_LOCK;
}

/** Kept for callers that only need a stable display path. */
export const LOCK_PATH = DEFAULT_LOCK;

export interface LockHolder {
  pid: number;
  startedAt: number;
  host: string;
  port: number;
  label: string;
}

export type LockResult =
  | { ok: true; release: () => void }
  | { ok: false; holder: LockHolder | null; reason: string };

function readHolder(): LockHolder | null {
  try {
    const raw = readFileSync(lockPath(), 'utf8');
    const parsed = JSON.parse(raw) as LockHolder;
    if (typeof parsed?.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Exported so diagnostics and proofs can read who holds the lock. */
export function currentHolder(): LockHolder | null {
  return readHolder();
}

/** Is that pid still alive? Signal 0 performs the permission/existence check. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function describeHolder(h: LockHolder): string {
  const up = Math.max(0, Math.round((Date.now() - h.startedAt) / 1000));
  const mins = Math.floor(up / 60);
  return (
    `PID ${h.pid} on ${h.host}:${h.port} (${h.label}), started ${new Date(h.startedAt).toISOString()}, ` +
    `up ${mins}m${up % 60}s`
  );
}

/**
 * Take the lock, or explain who holds it.
 *
 * A lock file whose pid is dead is reclaimed â€” that is the crash case, and
 * refusing to start because of a stale file would mean a crash permanently
 * bricks the app until someone deletes a file by hand.
 */
export function acquireLock(opts: { port: number; label: string; host?: string }): LockResult {
  const host = opts.host ?? '127.0.0.1';
  mkdirSync(dirname(lockPath()), { recursive: true });

  const holder = readHolder();
  if (holder) {
    if (holder.pid === process.pid) {
      // Re-entrant: this process already holds it.
      return { ok: true, release: () => releaseLock() };
    }
    if (pidAlive(holder.pid)) {
      return {
        ok: false,
        holder,
        reason:
          `another OrderFlow instance is already running: ${describeHolder(holder)}. ` +
          'Two servers would double the Binance request weight, which is how the original 418 happened. ' +
          'Stop that process first, or set ORDERFLOW_LOCK to a different path to run a second instance deliberately.',
      };
    }
    // Stale lock from a crash. Reclaim it.
    try { unlinkSync(lockPath()); } catch { /* another process won the race */ }
  }

  const payload: LockHolder = {
    pid: process.pid,
    startedAt: Date.now(),
    host,
    port: opts.port,
    label: opts.label,
  };

  try {
    // 'wx' fails if the file already exists, which makes creation atomic.
    const fd = openSync(lockPath(), 'wx');
    writeFileSync(fd, JSON.stringify(payload, null, 2));
    closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const now = readHolder();
      return {
        ok: false,
        holder: now,
        reason: now
          ? `lost the race for the lock; ${describeHolder(now)}`
          : 'lost the race for the lock and the winner is unreadable',
      };
    }
    return { ok: false, holder: null, reason: `could not create ${lockPath()}: ${(err as Error).message}` };
  }

  const onExit = () => { releaseLock(); };
  process.once('exit', onExit);
  process.once('SIGINT', () => { releaseLock(); process.exit(130); });
  process.once('SIGTERM', () => { releaseLock(); process.exit(143); });

  return { ok: true, release: () => { releaseLock(); process.off('exit', onExit); } };
}

export function releaseLock(): void {
  const holder = readHolder();
  // Only remove our own lock. Removing someone else's would let a third
  // process start while the real holder is still running.
  if (holder && holder.pid !== process.pid) return;
  try { unlinkSync(lockPath()); } catch { /* already gone */ }
}

export function lockExists(): boolean {
  return existsSync(lockPath());
}
