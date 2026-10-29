/**
 * Ban-aware rate limiting.
 *
 * WHY THIS EXISTS
 *
 * A self-inflicted HTTP 418 happened because the old code only backed off
 * briefly (5s/20s/60s). Binance's own documentation states the consequences
 * plainly:
 *
 *   - "HTTP 418 return code is used when an IP has been auto-banned for
 *      continuing to send requests after receiving 429 codes."
 *   - "IP bans are tracked and scale in duration for repeat offenders,
 *      from 2 minutes to 3 days."
 *   - "A Retry-After header is sent with a 418 or 429 response and will give
 *      the number of seconds required to wait to prevent a ban (for a 418) or
 *      until the ban is over (for a 429)."
 *   - "The limits on the API are based on the IPs, not the API keys."
 *
 * SOURCE OF THE FORMAT BELOW
 *
 * No 418 response has ever been captured in this repo or in its logs, so the
 * parser is written against Binance's *documented* -1003 message rather than
 * an observed one. From the official error-code tables:
 *
 *   {"code": -1003, "msg": "Way too much request weight used; IP banned until
 *    %s. Please use WebSocket Streams for live updates to avoid bans."}
 *
 * The docs render that timestamp as an untyped `%s`, so `parseBanUntil` does
 * NOT assume a unit. It accepts epoch-ms, epoch-seconds, a relative number of
 * seconds, or an ISO date, and resolves each to an absolute instant. Anything it
 * cannot understand returns null and the caller falls back to the escalating
 * cool-off, which is documented behaviour rather than a silent guess.
 *
 * PER HOST *AND* PER IP
 *
 * The requirement is per-host state. Binance's docs also say the ban is per
 * IP, not per key, so a single ban in practice covers every Binance host from
 * this machine. Both are therefore tracked: per-host budgets and ban windows,
 * plus an IP-level ban that gates the whole Binance group. Reporting only the
 * per-host view would let us keep hammering a sibling host that is already
 * serving 418s.
 *
 * This module is pure: no I/O, no clock, no database. The clock is injected so
 * a 120-second ban can be exercised in a millisecond, and persistence arrives
 * through the `BanPersistence` interface.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Escalating cool-off, in ms, used only when neither Retry-After nor a
 * parseable ban-until can be read from the response.
 *
 * The first and last entries come straight from the documentation: "from 2
 * minutes to 3 days". The intermediate steps are a geometric ladder between
 * them so a repeat offender stops quickly rather than learning the hard way.
 * The final entry is a floor, not a ceiling for a 3-day ban — a real 3-day ban
 * arrives with a Retry-After and is honoured verbatim.
 */
export const ESCALATION_LADDER_MS = [
  2 * 60_000,        // 2 min  — documented minimum
  5 * 60_000,        // 5 min
  15 * 60_000,       // 15 min
  60 * 60_000,       // 1 h
  6 * 3600_000,      // 6 h
  24 * 3600_000,     // 24 h
  72 * 3600_000,     // 3 days — documented maximum
] as const;

/** Weight budget at which we start slowing down. [V] Binance publishes the limit. */
export const SLOWDOWN_AT = 0.7;
/** Weight budget at which non-essential work is paused. */
export const PAUSE_AT = 0.9;

/** Default one-minute weight ceiling. Overridden per host by the registry. */
export const DEFAULT_WEIGHT_LIMIT = 6000;

/**
 * The rolling window `X-MBX-USED-WEIGHT-1M` describes.
 *
 * A reading older than this no longer describes reality — Binance's window has
 * rolled — so it is discarded rather than obeyed forever.
 */
export const BUDGET_WINDOW_MS = 60_000;

/**
 * Hosts that share an IP weight pool.
 *
 * Binance: "The limits on the API are based on the IPs, not the API keys", so a
 * ban on one Binance host is treated as a ban on all of them until proven
 * otherwise. Everything else is its own island.
 */
const BAN_GROUPS: ReadonlyArray<{ group: string; hosts: readonly string[] }> = [
  {
    group: 'binance',
    hosts: [
      'data-api.binance.vision',
      'api.binance.com',
      'api1.binance.com',
      'api2.binance.com',
      'api3.binance.com',
      'api4.binance.com',
      'fapi.binance.com',
      'dapi.binance.com',
      'data-stream.binance.vision',
      'fstream.binance.com',
      'stream.binance.com',
    ],
  },
];

/** WebSocket hosts: banned state must suppress reconnects, not just REST. */
export const WS_HOSTS = [
  'data-stream.binance.vision',
  'fstream.binance.com',
  'stream.binance.com',
] as const;

export type CallPurpose = 'essential' | 'normal' | 'nonessential';
export type BudgetLevel = 'normal' | 'slowdown' | 'pause';

export type BanSource = 'retry-after' | 'body' | 'escalating' | 'persisted';

export interface BanRecord {
  host: string;
  /** Epoch ms. The host is unusable until this instant. */
  bannedUntil: number;
  source: BanSource;
  /** Verbatim header or message, kept for the log and for /api/health. */
  raw: string | null;
  strikes: number;
  updatedAt: number;
}

// ── Pure parsing ─────────────────────────────────────────────────────────────

/**
 * `Retry-After`, per RFC 9110 §10.2.4. Two forms are legal: delta-seconds and
 * an HTTP-date. Binance documents "the number of seconds required to wait".
 *
 * @returns epoch ms, or null when the header is absent or unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (value == null) return null;
  const v = value.trim();
  if (v === '') return null;

  // delta-seconds (the form Binance documents). Guarded so "3 days" or "-1"
  // fall through to the date branch instead of producing nonsense.
  if (/^\d+$/.test(v)) {
    const secs = Number(v);
    if (!Number.isFinite(secs)) return null;
    return now + secs * 1000;
  }

  // Anything numeric that is not delta-seconds is not a legal value: "-5" and
  // "3 days" both start with a digit/sign, and `Date.parse` happily returns a
  // nonsense value for some of them. A legal HTTP-date always begins with a
  // weekday name, so anything else is rejected outright.
  if (/^[+-]?\d/.test(v)) return null;

  // HTTP-date. `Date.parse` accepts the three legal formats.
  const parsed = Date.parse(v);
  if (Number.isFinite(parsed)) {
    // A date already in the past means "no wait", which we normalise to "now"
    // rather than returning a negative offset the caller has to reason about.
    return Math.max(now, parsed);
  }

  return null;
}

/**
 * The `-1003` "IP banned until <ts>" message.
 *
 * The documentation leaves the timestamp untyped, so four shapes are accepted
 * and each is resolved to an absolute instant:
 *
 *   1. a 13-digit integer  -> epoch milliseconds
 *   2. a 10-digit integer  -> epoch seconds
 *   3. a small integer     -> seconds from `now`
 *   4. a parseable date    -> absolute instant
 *
 * @returns epoch ms, or null when the body carries no usable timestamp.
 */
export function parseBanUntil(body: string | null | undefined, now: number): number | null {
  if (!body) return null;

  // Case-insensitive, tolerant of the several phrasings across Binance's
  // products ("IP banned until", "banned until", "ban expires").
  //
  // NOTE the group: `ban(?:ned)?`, not `banned?`. The latter reads as
  // "banne" + optional "d" and therefore fails to match the bare word "ban".
  // A unit test caught exactly that, on the "ban expires" phrasing.
  const m = /ban(?:ned)?\s+(?:until|expires?(?:\s+at)?)\s*:?\s*([^\s,;."')]+)/i.exec(body);
  if (!m) return null;
  return resolveTimestampToken(m[1], now);
}

function resolveTimestampToken(token: string, now: number): number | null {
  const t = token.trim().replace(/[.,;)]+$/, '');
  if (t === '') return null;

  if (/^\d{13,}$/.test(t)) return Number(t);
  if (/^\d{10}$/.test(t)) return Number(t) * 1000;
  if (/^\d+$/.test(t)) return now + Number(t) * 1000;

  const parsed = Date.parse(t);
  if (Number.isFinite(parsed)) return parsed;
  return null;
}

/**
 * The ban window implied by a limited response.
 *
 * Precedence is deliberate and matches what Binance tells us to trust:
 *   1. `Retry-After` — documented, unambiguous, and specific to this response.
 *   2. `-1003` body   — documented, but the timestamp's unit is not stated.
 *   3. escalation     — used only when neither is present.
 *
 * A body timestamp is only accepted when it lands strictly in the future; a
 * stale or malformed one must not shorten the wait that Retry-After gave us.
 */
export function resolveBanWindow(args: {
  retryAfter: string | null | undefined;
  body: string | null | undefined;
  strikes: number;
  now: number;
}): { until: number; source: BanSource; raw: string | null } {
  const { retryAfter, body, strikes, now } = args;

  const fromHeader = parseRetryAfter(retryAfter, now);
  if (fromHeader !== null) {
    return { until: fromHeader, source: 'retry-after', raw: String(retryAfter) };
  }

  const fromBody = parseBanUntil(body, now);
  if (fromBody !== null && fromBody > now) {
    return { until: fromBody, source: 'body', raw: body!.slice(0, 400) };
  }

  return {
    until: now + escalationMs(strikes),
    source: 'escalating',
    raw: body ? body.slice(0, 400) : null,
  };
}

/**
 * Escalating cool-off in ms for the Nth consecutive offence.
 * Deterministic, so a test can assert an exact duration.
 */
export function escalationMs(strikes: number): number {
  const i = Math.min(Math.max(Math.floor(strikes), 1), ESCALATION_LADDER_MS.length) - 1;
  return ESCALATION_LADDER_MS[i];
}

/**
 * Proactive budget decision from Binance's own weight header.
 *
 * Every response carries `X-MBX-USED-WEIGHT-1M` ("the currently used weight
 * for the IP of all request rate limiters"). Above 70% we slow down; above 90%
 * we pause everything that is not live ingestion.
 */
export function budgetLevel(usedWeight: number | null, limit = DEFAULT_WEIGHT_LIMIT): BudgetLevel {
  if (usedWeight === null || limit <= 0) return 'normal';
  const pct = usedWeight / limit;
  if (pct >= PAUSE_AT) return 'pause';
  if (pct >= SLOWDOWN_AT) return 'slowdown';
  return 'normal';
}

/** Read `X-MBX-USED-WEIGHT-1M` out of a fetch Headers object. */
export function parseUsedWeight(headers: {
  get(name: string): string | null;
}): number | null {
  const raw = headers.get('x-mbx-used-weight-1m');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** True when a call of this purpose may run under the current budget level. */
export function purposeAllowed(purpose: CallPurpose, level: BudgetLevel): boolean {
  if (level === 'pause') return purpose === 'essential';
  if (level === 'slowdown') return purpose !== 'nonessential';
  return true;
}

/** Milliseconds to insert between calls at this budget level. [TUNED] */
export function slowdownDelayMs(level: BudgetLevel): number {
  if (level === 'pause') return 0;
  if (level === 'slowdown') return 400;
  return 0;
}

export function groupOf(host: string): string | null {
  for (const g of BAN_GROUPS) if (g.hosts.includes(host)) return g.group;
  return null;
}

/** Hostname for a URL, or the string itself when it is already a bare host. */
export function hostOf(url: string): string {
  const m = /^wss?:\/\/([^/]+)/i.exec(url);
  if (m) return m[1].toLowerCase();
  const h = /^https?:\/\/([^/]+)/i.exec(url);
  if (h) return h[1].toLowerCase();
  return url.toLowerCase();
}

// ── Registry ─────────────────────────────────────────────────────────────────

export interface BanPersistence {
  loadBans(): BanRecord[];
  saveBan(rec: BanRecord): void;
  clearBan(host: string): void;
}

export interface RegistryOptions {
  now?: () => number;
  persist?: BanPersistence | null;
  log?: (message: string) => void;
  /** Per-host weight ceilings. Defaults to DEFAULT_WEIGHT_LIMIT. */
  limits?: Record<string, number>;
  /** Warn when one caller exceeds this many REST calls in a rolling minute. */
  devGuardPerMinute?: number;
}

interface HostState {
  bannedUntil: number;
  source: BanSource;
  raw: string | null;
  strikes: number;
  updatedAt: number;
}

export interface HostSnapshot {
  host: string;
  banned: boolean;
  bannedUntil: number | null;
  remainingMs: number;
  source: BanSource | null;
  strikes: number;
  usedWeight: number | null;
  weightLimit: number;
  budget: BudgetLevel;
}

export interface RegistrySnapshot {
  now: number;
  hosts: HostSnapshot[];
  /** IP-level ban covering every host in the same group, if any. */
  groupBans: { group: string; bannedUntil: number; source: BanSource; remainingMs: number }[];
  devGuardWarnings: number;
}

export class BanRegistry {
  private hosts = new Map<string, HostState>();
  /** group -> ban window. A ban on one Binance host gates the whole group. */
  private groups = new Map<string, HostState>();
  private weight = new Map<string, number>();
  /** host -> when the weight reading arrived, so a stale one can be dropped. */
  private weightAt = new Map<string, number>();
  /** host -> last probe permitted while paused, to break the PAUSE deadlock. */
  private probeAt = new Map<string, number>();
  private limits: Record<string, number>;
  private now: () => number;
  private persist: BanPersistence | null;
  private log: (m: string) => void;
  private devGuardPerMinute: number;
  /** label -> epoch ms of each call in the trailing minute. */
  private callLog = new Map<string, number[]>();
  private devGuardWarnings = 0;

  constructor(opts: RegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.persist = opts.persist ?? null;
    this.log = opts.log ?? ((m) => console.warn(`[ratelimit] ${m}`));
    this.limits = opts.limits ?? {};
    this.devGuardPerMinute = opts.devGuardPerMinute ?? 120;
  }

  /**
   * Attach persistence after construction.
   *
   * Done as a setter rather than a constructor argument so `lib/http.ts` can
   * own the registry without importing `node:sqlite` at module load — the pure
   * limiter stays importable by unit tests with no database present.
   */
  setPersist(p: BanPersistence | null): void {
    this.persist = p;
  }

  setLog(log: (m: string) => void): void {
    this.log = log;
  }

  /**
   * Replace the clock.
   *
   * Exists so a 120-second ban can be exercised in a millisecond. A test or a
   * proof harness drives the same code path the app does; only the source of
   * "now" differs.
   */
  setNow(now: () => number): void {
    this.now = now;
  }

  /**
   * Restore persisted bans. Called once at startup BEFORE any request is made,
   * which is the whole point: a restart must never re-hit a banned host.
   */
  loadPersisted(): number {
    if (!this.persist) return 0;
    let loaded = 0;
    let records: BanRecord[] = [];
    try {
      records = this.persist.loadBans();
    } catch (err) {
      this.log(`could not read persisted bans: ${(err as Error).message}`);
      return 0;
    }
    const now = this.now();
    for (const r of records) {
      if (r.bannedUntil <= now) {
        // Expired while the process was down. Clear it rather than carrying a
        // stale window forward, which would keep a dead ban alive.
        try { this.persist?.clearBan(r.host); } catch { /* best effort */ }
        continue;
      }
      const state: HostState = {
        bannedUntil: r.bannedUntil,
        source: 'persisted',
        raw: r.raw,
        strikes: r.strikes,
        updatedAt: r.updatedAt,
      };
      this.hosts.set(r.host, state);
      const g = groupOf(r.host);
      if (g) this.bumpGroup(g, state);
      loaded++;
    }
    if (loaded) {
      this.log(`restored ${loaded} active ban(s) from disk; those hosts will not be contacted`);
    }
    return loaded;
  }

  private bumpGroup(group: string, state: HostState): void {
    const cur = this.groups.get(group);
    if (!cur || state.bannedUntil > cur.bannedUntil) this.groups.set(group, state);
  }

  isBanned(host: string, now = this.now()): boolean {
    const h = host.toLowerCase();
    if ((this.hosts.get(h)?.bannedUntil ?? 0) > now) return true;
    const g = groupOf(h);
    if (g && (this.groups.get(g)?.bannedUntil ?? 0) > now) return true;
    return false;
  }

  remainingMs(host: string, now = this.now()): number {
    const h = host.toLowerCase();
    const own = this.hosts.get(h)?.bannedUntil ?? 0;
    const g = groupOf(h);
    const group = g ? this.groups.get(g)?.bannedUntil ?? 0 : 0;
    return Math.max(own, group, 0) - now > 0 ? Math.max(own, group) - now : 0;
  }

  bannedUntil(host: string): number | null {
    const h = host.toLowerCase();
    const own = this.hosts.get(h)?.bannedUntil ?? 0;
    const g = groupOf(h);
    const group = g ? this.groups.get(g)?.bannedUntil ?? 0 : 0;
    const max = Math.max(own, group);
    return max > 0 ? max : null;
  }

  /**
   * May we make this call? Returns null when allowed, or a human-readable
   * reason when not. Callers must not fall through to `fetch` on a non-null
   * return — that is the whole contract.
   */
  check(host: string, purpose: CallPurpose, now = this.now()): string | null {
    if (this.isBanned(host, now)) {
      const ms = this.remainingMs(host, now);
      return `${host} is BANNED for another ${Math.ceil(ms / 1000)}s (no REST, no reconnect)`;
    }
    const level = this.budgetLevelFor(host);
    if (!purposeAllowed(purpose, level)) {
      // Without this the budget deadlocks: PAUSE blocks the very request whose
      // response header would tell us the window has rolled. One probe per
      // window (weight 1-2) is negligible against a 6000 budget and is the only
      // way back. Found by the end-to-end proof, not by inspection.
      const h = host.toLowerCase();
      const lastProbe = this.probeAt.get(h) ?? 0;
      if (now - lastProbe >= BUDGET_WINDOW_MS) {
        this.probeAt.set(h, now);
        this.log(`${h} ${level.toUpperCase()}: allowing one probe request to refresh the weight reading`);
        return null;
      }
      return `${host} weight budget is in ${level.toUpperCase()} (${this.weightPctLabel(h)}); ${purpose} calls are held back`;
    }
    return null;
  }

  weightLimitFor(host: string): number {
    return this.limits[host.toLowerCase()] ?? DEFAULT_WEIGHT_LIMIT;
  }

  usedWeightFor(host: string): number | null {
    const h = host.toLowerCase();
    if (this.weightAgeMs(h) >= BUDGET_WINDOW_MS) return null;
    return this.weight.get(h) ?? null;
  }

  /** How long ago the current weight reading arrived. */
  weightAgeMs(host: string): number {
    const h = host.toLowerCase();
    const at = this.weightAt.get(h);
    if (at === undefined) return Number.POSITIVE_INFINITY;
    return this.now() - at;
  }

  weightPctLabel(host: string): string {
    const used = this.usedWeightFor(host);
    if (used === null) return 'unknown';
    const limit = this.weightLimitFor(host);
    return `${Math.round((used / limit) * 100)}% (${used}/${limit})`;
  }

  budgetLevelFor(host: string): BudgetLevel {
    const h = host.toLowerCase();
    const used = this.weight.get(h);
    if (used === undefined) return 'normal';
    // The header describes a rolling one-minute window. Carrying that number
    // forward for longer than the window it measures would keep a host in
    // PAUSE forever on a reading that stopped being true.
    if (this.weightAgeMs(h) >= BUDGET_WINDOW_MS) return 'normal';
    return budgetLevel(used, this.weightLimitFor(h));
  }

  /** Record a successful response and refresh the weight budget from headers. */
  noteResponse(host: string, headers: { get(n: string): string | null }): void {
    const used = parseUsedWeight(headers);
    if (used === null) return;
    const h = host.toLowerCase();
    const before = this.budgetLevelFor(h);
    this.weight.set(h, used);
    this.weightAt.set(h, this.now());
    const after = this.budgetLevelFor(h);
    if (after !== before) {
      this.log(`${h} weight budget ${before} -> ${after} (${this.weightPctLabel(h)})`);
    }
  }

  /**
   * Record a 418/429 and open the ban window for that host and its group.
   * Returns the ban that was applied, or null when the response was not a
   * rate-limit response.
   */
  noteLimit(args: {
    host: string;
    status: number;
    headers: { get(n: string): string | null };
    body: string | null;
  }): BanRecord | null {
    const { host, status, headers, body } = args;
    const now = this.now();
    const h = host.toLowerCase();
    const prev = this.hosts.get(h);
    const strikes = (prev?.strikes ?? 0) + 1;

    const retryAfter = headers.get('retry-after');
    const win = resolveBanWindow({ retryAfter, body, strikes, now });
    const state: HostState = {
      bannedUntil: win.until,
      source: win.source,
      raw: win.raw,
      strikes,
      updatedAt: now,
    };
    this.hosts.set(h, state);
    const g = groupOf(h);
    if (g) this.bumpGroup(g, state);

    const rec: BanRecord = {
      host: h,
      bannedUntil: win.until,
      source: win.source,
      raw: win.raw,
      strikes,
      updatedAt: now,
    };
    try {
      this.persist?.saveBan(rec);
    } catch (err) {
      this.log(`could not persist ban for ${h}: ${(err as Error).message}`);
    }

    const secs = Math.ceil((win.until - now) / 1000);
    this.log(
      `HTTP ${status} from ${h} — ban until ${new Date(win.until).toISOString()} ` +
      `(+${secs}s, source=${win.source}, strike=${strikes})` +
      (g ? ` [group ${g} also gated]` : ''),
    );
    return rec;
  }

  /** A 200 clears the escalating strike counter but never shortens a live ban. */
  noteSuccess(host: string): void {
    const h = host.toLowerCase();
    const s = this.hosts.get(h);
    if (s && s.bannedUntil <= this.now()) {
      this.hosts.delete(h);
      try { this.persist?.clearBan(h); } catch { /* best effort */ }
    }
  }

  /**
   * Dev guard: record one call and warn when a single caller is issuing more
   * than N REST calls a minute. This exists because the ban that started all
   * this was self-inflicted, and a runaway loop should be loud rather than
   * silently escalating into a multi-day block.
   */
  recordCall(label: string, now = this.now()): void {
    const window = 60_000;
    const arr = (this.callLog.get(label) ?? []).filter((t) => now - t < window);
    arr.push(now);
    this.callLog.set(label, arr);
    if (arr.length > this.devGuardPerMinute) {
      this.devGuardWarnings++;
      this.log(
        `DEV GUARD: ${label} issued ${arr.length} REST calls in 60s ` +
        `(limit ${this.devGuardPerMinute}). This pattern is what caused the 418. ` +
        `Add caching, raise the interval, or mark the call as nonessential.`,
      );
    }
  }

  snapshot(): RegistrySnapshot {
    const now = this.now();
    const names = new Set<string>([...this.hosts.keys(), ...this.weight.keys()]);
    // A host that is gated only because its IP group is banned must still show
    // up in the health report. Without this, /api/health would list the host
    // that tripped the ban and stay silent about the sibling that is equally
    // unusable — the exact "why is this panel empty" question this exists to
    // answer.
    for (const g of BAN_GROUPS) {
      if ((this.groups.get(g.group)?.bannedUntil ?? 0) > now) {
        for (const h of g.hosts) names.add(h);
      }
    }
    return {
      now,
      hosts: [...names].map((host) => ({
        host,
        banned: this.isBanned(host, now),
        bannedUntil: this.bannedUntil(host),
        remainingMs: this.remainingMs(host, now),
        source: this.hosts.get(host)?.source ?? null,
        strikes: this.hosts.get(host)?.strikes ?? 0,
        usedWeight: this.usedWeightFor(host),
        weightLimit: this.weightLimitFor(host),
        budget: this.budgetLevelFor(host),
      })),
      groupBans: [...this.groups.entries()]
        .filter(([, s]) => s.bannedUntil > now)
        .map(([group, s]) => ({
          group,
          bannedUntil: s.bannedUntil,
          source: s.source,
          remainingMs: s.bannedUntil - now,
        })),
      devGuardWarnings: this.devGuardWarnings,
    };
  }

  /** Test seam: wipe all in-memory state. Persistence is untouched. */
  reset(): void {
    this.hosts.clear();
    this.groups.clear();
    this.weight.clear();
    this.weightAt.clear();
    this.probeAt.clear();
    this.callLog.clear();
    this.devGuardWarnings = 0;
  }
}

/**
 * Cap on WebSocket connection attempts.
 *
 * Binance's WebSocket API documentation sets a limit of 300 connection
 * attempts per 5 minutes per IP. Exceeding it is itself a ban risk, and a
 * reconnect loop that ignores its own failures is exactly how a client ends
 * up in a tight retry cycle against a host that is refusing it.
 */
export const WS_CONNECT_LIMIT = 300;
export const WS_CONNECT_WINDOW_MS = 5 * 60_000;

export class ConnectAttemptLimiter {
  private stamps: number[] = [];
  private suppressed = 0;

  constructor(
    private readonly limit: number = WS_CONNECT_LIMIT,
    private readonly windowMs: number = WS_CONNECT_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** @returns true when the attempt is allowed and has been recorded. */
  tryAcquire(): boolean {
    const now = this.now();
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
    if (this.stamps.length >= this.limit) {
      this.suppressed++;
      return false;
    }
    this.stamps.push(now);
    return true;
  }

  /** Attempts left before the cap, for /api/health. */
  remaining(): number {
    const now = this.now();
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
    return Math.max(0, this.limit - this.stamps.length);
  }

  suppressedCount(): number {
    return this.suppressed;
  }

  reset(): void {
    this.stamps = [];
    this.suppressed = 0;
  }
}

/**
 * Reconnect delay: exponential backoff with full jitter, capped.
 *
 * Deterministic when `random` is supplied, so a test can assert the schedule
 * exactly rather than asserting a range and hoping.
 */
export function reconnectDelayMs(args: {
  attempt: number;
  baseMs: number;
  maxMs: number;
  jitter: number;
  random: () => number;
}): number {
  const { attempt, baseMs, maxMs, jitter, random } = args;
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  // Symmetric jitter around the exponential value, clamped at >= 500ms so a
  // zero-jitter draw never produces a hot loop.
  const delta = exp * jitter * (random() * 2 - 1);
  return Math.max(500, Math.round(exp + delta));
}