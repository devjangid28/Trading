const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface FetchOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  label?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shared throttle for the Binance REST hosts.
 *
 * Binance answers a burst of requests with HTTP 418 ("I'm rate limited") and
 * 429. Neither is worth retrying immediately, and retrying them in a tight loop
 * is how a client that was merely busy becomes a client that is blocked for
 * minutes. Both now open a shared circuit for a cool-down, so every caller
 * backs off together instead of each discovering the limit independently.
 *
 * This was found in practice, not theorised: repeated test-server launches
 * pushed the request rate over the weight quota and the whole scan started
 * returning 418 for every symbol.
 */
const throttle = {
  /** Epoch ms until which the host is considered rate limited. */
  blockedUntil: 0,
  /** Consecutive failures, used to escalate the cool-off. */
  strikes: 0,
};

const RATE_LIMIT_STATUS = new Set([418, 429]);

/** Exported for tests: the statuses that trigger the shared cool-off. */
export function isRateLimitedStatus(status: number): boolean {
  return RATE_LIMIT_STATUS.has(status);
}

/**
 * How long to stop for, given how many times in a row we have been limited.
 *
 * Exported for tests, and deliberately deterministic when `jitter = 0` — a
 * test that asserts a real duration has to be able to ask for the deterministic
 * one, otherwise every run asserts a different number.
 */
export function coolOffMs(strikes: number, jitter = 0): number {
  const base = strikes <= 1 ? 5_000 : strikes === 2 ? 20_000 : 60_000;
  return base + Math.floor(Math.random() * jitter);
}

function isRateLimited(status: number): boolean {
  return isRateLimitedStatus(status);
}

/**
 * Wait out the shared cool-off.
 *
 * Only half of waiting callers actually block. The rest are allowed to proceed,
 * which keeps a scan from stalling for five seconds behind a single rate-limited
 * symbol while the rest of the universe is perfectly reachable.
 */
async function respectCooldown(): Promise<void> {
  const wait = throttle.blockedUntil - Date.now();
  if (wait <= 0) return;
  if (Math.random() < 0.5) await sleep(wait);
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const { headers = {}, timeoutMs = 12_000, retries = 2, label = url } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await respectCooldown();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...headers },
      });
      if (!res.ok) throw new HttpError(`${label} -> HTTP ${res.status}`, res.status, url);
      // A success clears the shared cool-off, so one healthy request is
      // enough to stop penalising every other caller.
      throttle.blockedUntil = 0;
      throttle.strikes = 0;
      return await res.text();
    } catch (err) {
      lastErr = err;
      const status = err instanceof HttpError ? err.status : 0;

      if (isRateLimited(status)) {
        throttle.strikes++;
        throttle.blockedUntil = Math.max(throttle.blockedUntil, Date.now() + coolOffMs(throttle.strikes));
        // Retry rate limits with a long wait, unlike other 4xx which are the
        // caller's fault and not worth repeating.
        if (attempt < retries) {
          await sleep(coolOffMs(throttle.strikes, 1_500));
          continue;
        }
        break;
      }

      // Do not retry other client errors: they will not change on a second try.
      if (status >= 400 && status < 500) break;
      if (attempt < retries) await sleep(400 * Math.pow(2, attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from ${opts.label ?? url}: ${text.slice(0, 160)}`);
  }
}

/** Fetch and tolerate failure, returning a fallback instead of throwing. */
export async function fetchJsonSafe<T>(
  url: string,
  fallback: T,
  opts: FetchOpts = {},
): Promise<T> {
  try {
    return await fetchJson<T>(url, opts);
  } catch {
    return fallback;
  }
}
