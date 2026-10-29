import { bans, installBanPersistence } from './http.js';
import { loadBans, saveBan, clearBan } from '../ledger/store.js';

/**
 * Boot the ban-aware rate limiter.
 *
 * This exists as a single named function because the proof harness caught what
 * happens without it: a restart restored the ban row from SQLite into a
 * registry, but the request path consults a DIFFERENT registry instance, so the
 * ban was never enforced and the restart happily re-hit a banned host — exactly
 * the failure this whole feature is meant to prevent.
 *
 * So: one place that installs persistence AND loads it, called before any
 * socket is opened and before the first request is issued.
 *
 * @returns the number of active bans restored from disk.
 */
export function bootRateLimiter(): number {
  installBanPersistence({ loadBans, saveBan, clearBan });
  return bans.loadPersisted();
}

export { bans };