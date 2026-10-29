import {
  BanRegistry, hostOf, slowdownDelayMs, type CallPurpose,
} from './banGuard.js';

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

/**
 * Thrown WITHOUT any request being made when the host is under a ban.
 *
 * Distinct from HttpError because no request exists: `status` is 0 and the
 * `url` names the host we refused to touch. Callers that catch HttpError to
 * degrade a panel must not treat this as "the exchange said no" — nothing was
 * asked.
 */
export class HostBannedError extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
    readonly remainingMs: number,
  ) {
    super(`host ${host} banned: ${reason}`);
    this.name = 'HostBannedError';
  }
}

export { HostBannedError as BannedHostError };

interface FetchOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  label?: string;
  /**
   * How important this call is, for the proactive weight budget.
   *
   *   essential    — live candle/ticker ingestion; never paused.
   *   normal       — scan work; paused only above the 90% weight threshold.
   *   nonessential — popup depth, order-book snapshots, backtests; paused
   *                  above 70% as well as 90%.
   */
  purpose?: CallPurpose;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RATE_LIMIT_STATUS = new Set([418, 429]);

/** Exported for tests: the statuses that trigger the shared cool-off. */
export function isRateLimitedStatus(status: number): boolean {
  return RATE_LIMIT_STATUS.has(status);
}

function isRateLimited(status: number): boolean {
  return isRateLimitedStatus(status);
}

/**
 * The process-wide ban registry.
 *
 * Per-host, because weight limits and host availability are tracked per host;
 * plus an IP-level group ban, because Binance's documentation states "The
 * limits on the API are based on the IPs, not the API keys" — so a 418 from one
 * Binance host is treated as applying to every Binance host from this machine.
 */
export const bans = new BanRegistry({
  limits: {
    'data-api.binance.vision': 6000,
    'api.binance.com': 6000,
    'fapi.binance.com': 2400,
    'api.hyperliquid.xyz': 1200,
    'api.bybit.com': 600,
  },
});

/**
 * Attach the SQLite-backed persistence. Called once at startup, BEFORE the
 * first request, so a restart during a ban makes zero calls.
 */
export function installBanPersistence(p: Parameters<BanRegistry['setPersist']>[0]): void {
  bans.setPersist(p);
}

/**
 * Legacy escape hatch kept so existing callers and tests keep working.
 *
 * Delegates to the documented escalation ladder, whose first rung is the
 * documented 2-minute minimum ban. The old 5s/20s/60s ladder is what let a
 * self-inflicted 418 escalate, so it is deliberately gone.
 */
export function coolOffMs(strikes: number, jitter = 0): number {
  const i = Math.min(Math.max(Math.floor(strikes), 1), 7) - 1;
  const base = [120_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000, 259_200_000][i];
  return base + Math.floor(Math.random() * jitter);
}

// ── Transport seam (Fix 3: mock mode) ────────────────────────────────────────

/**
 * The single place a real outbound request happens.
 *
 * Mock mode replaces this with a fixture replayer, so every parser, the whole
 * engine and the SSE hub run unchanged against recorded responses. Keeping the
 * seam here — rather than inside each provider — is what makes "the same code
 * paths" true rather than aspirational.
 */
export type Transport = (url: string, init: {
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<Response>;

let transport: Transport | null = null;

export function setTransport(t: Transport | null): void {
  transport = t;
}

export function currentTransportName(): string {
  return transport ? 'replay' : 'live';
}

async function doFetch(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  if (transport) return transport(url, { headers, signal });
  return fetch(url, { signal, headers });
}

// ── The request path ─────────────────────────────────────────────────────────

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const {
    headers = {}, timeoutMs = 12_000, retries = 2, label = url, purpose = 'normal',
  } = opts;
  const host = hostOf(url);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Ban check happens BEFORE the socket is opened. A banned host produces a
    // HostBannedError on the very first attempt with zero requests made.
    const blocked = bans.check(host, purpose);
    if (blocked) throw new HostBannedError(host, blocked, bans.remainingMs(host));

    if (attempt > 0) {
      const delay = slowdownDelayMs(bans.budgetLevelFor(host));
      if (delay) await sleep(delay);
    }

    bans.recordCall(label);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...headers }, ac.signal);

      // Proactive budget: every Binance response carries the IP's current used
      // weight. Reading it here is what lets us slow down BEFORE the next 429.
      bans.noteResponse(host, res.headers);

      if (!res.ok) {
        let body: string | null = null;
        if (isRateLimited(res.status)) {
          // Only a rate-limit body is worth reading; it is where the -1003
          // "IP banned until <ts>" timestamp lives.
          body = await res.text().catch(() => null);
          bans.noteLimit({ host, status: res.status, headers: res.headers, body });
        }
        throw new HttpError(`${label} -> HTTP ${res.status}`, res.status, url);
      }

      bans.noteSuccess(host);
      return await res.text();
    } catch (err) {
      lastErr = err;

      if (err instanceof HostBannedError) throw err;

      const status = err instanceof HttpError ? err.status : 0;
      // A failure flagged terminal (e.g. the mock transport refusing an
      // uncaptured URL) will fail identically on every attempt. Retrying it
      // just burns three times the latency and looks like a real network fault.
      if ((err as { terminal?: boolean }).terminal === true) throw err;

      if (isRateLimited(status)) {
        // The registry has already opened the window. Retrying inside that
        // window is exactly the behaviour that escalates a 429 into a 418, so
        // we stop and let the caller's next attempt observe the ban.
        break;
      }
      // Do not retry other client errors: they will not change on a second try.
      if (status >= 400 && status < 500) break;
      if (attempt < retries) await sleep(400 * 2 ** attempt);
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

export { hostOf };