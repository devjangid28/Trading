import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BanRegistry, ConnectAttemptLimiter, budgetLevel, escalationMs,
  groupOf, hostOf, parseBanUntil, parseRetryAfter, parseUsedWeight,
  purposeAllowed, reconnectDelayMs, resolveBanWindow, slowdownDelayMs,
  DEFAULT_WEIGHT_LIMIT, PAUSE_AT, SLOWDOWN_AT, BUDGET_WINDOW_MS,
  type BanPersistence, type BanRecord,
} from '../src/lib/banGuard.js';
import { setTransport, fetchText, bans, HostBannedError } from '../src/lib/http.js';

/**
 * Fix 1 — ban-aware rate limiting.
 *
 * The incident this replaces: a self-inflicted HTTP 418 caused by a 5s/20s/60s
 * cool-off. Binance documents that "IP bans are tracked and scale in duration
 * for repeat offenders, from 2 minutes to 3 days", and that a 418 carries a
 * `Retry-After` header giving the seconds required to wait.
 *
 * NO 418 RESPONSE HAS EVER BEEN CAPTURED IN THIS REPO. The body parser is
 * written against Binance's documented -1003 message
 * ("Way too much request weight used; IP banned until %s. Please use WebSocket
 * Streams for live updates to avoid bans.") whose timestamp is documented as an
 * untyped `%s`. Every branch below is therefore tested against the shapes the
 * parser claims to handle, and the fallback path (escalation) is tested
 * separately so an unrecognised body can never silently shorten a wait.
 */

const T0 = 1_760_000_000_000;

function clockAt(start: number) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    set: (v: number) => { t = v; },
  };
}

/** In-memory persistence, so "restart" is just constructing a fresh registry. */
function memoryPersist(seed?: BanRecord[]) {
  const rows = new Map<string, BanRecord>(seed?.map((r) => [r.host, { ...r }]) ?? []);
  const impl: BanPersistence = {
    loadBans: () => [...rows.values()],
    saveBan: (r) => { rows.set(r.host, { ...r }); },
    clearBan: (h) => { rows.delete(h); },
  };
  return { impl, rows };
}

function headers(map: Record<string, string>) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (n: string) => lower.get(n.toLowerCase()) ?? null };
}

describe('parseRetryAfter', () => {
  it('parses delta-seconds, the form Binance documents', () => {
    expect(parseRetryAfter('120', T0)).toBe(T0 + 120_000);
  });

  it('treats "0" as "do not wait", not as "wait forever"', () => {
    expect(parseRetryAfter('0', T0)).toBe(T0);
  });

  it('parses an HTTP-date, the second legal form under RFC 9110', () => {
    const when = Date.parse('Wed, 14 Oct 2026 13:30:00 GMT');
    expect(parseRetryAfter('Wed, 14 Oct 2026 13:30:00 GMT', T0)).toBe(when);
  });

  it('clamps an HTTP-date already in the past to now rather than going negative', () => {
    const past = new Date(T0 - 60_000).toUTCString();
    expect(parseRetryAfter(past, T0)).toBe(T0);
  });

  it('returns null for absent, blank or unparseable values', () => {
    for (const v of [null, undefined, '', '   ', 'soon', '-5', '3 days']) {
      expect(parseRetryAfter(v, T0)).toBeNull();
    }
  });
});

describe('parseBanUntil', () => {
  it('reads the documented -1003 message and resolves a 13-digit epoch-ms', () => {
    const until = T0 + 120_000;
    const body = `{"code":-1003,"msg":"Way too much request weight used; IP banned until ${until}. Please use WebSocket Streams for live updates to avoid bans."}`;
    expect(parseBanUntil(body, T0)).toBe(until);
  });

  it('resolves a 10-digit epoch-seconds, because the docs leave the unit as %s', () => {
    const secs = Math.floor((T0 + 300_000) / 1000);
    const body = `{"code":-1003,"msg":"Way too much request weight used; IP banned until ${secs}."}`;
    expect(parseBanUntil(body, T0)).toBe(T0 + 300_000);
  });

  it('reads a small integer as a relative number of seconds', () => {
    expect(parseBanUntil('{"code":-1003,"msg":"IP banned until 90."}', T0)).toBe(T0 + 90_000);
  });

  it('accepts the other documented -1003 phrasings', () => {
    for (const msg of [
      'IP banned until 120',
      'banned until 120',
      'ban expires at 120',
    ]) {
      expect(parseBanUntil(`{"code":-1003,"msg":"${msg}"}`, T0)).toBe(T0 + 120_000);
    }
  });

  it('returns null for a -1003 variant that carries no timestamp', () => {
    // These two are real documented messages and must NOT be mistaken for a
    // ban window, or every ordinary 429 would start a multi-minute block.
    for (const msg of [
      'Too many requests queued.',
      'Too much request weight used; current limit is 6000 request weight per MINUTE. Please use WebSocket Streams for live updates to avoid polling the API.',
    ]) {
      expect(parseBanUntil(`{"code":-1003,"msg":"${msg}"}`, T0)).toBeNull();
    }
  });

  it('returns null for empty, null and non-JSON bodies', () => {
    for (const b of [null, undefined, '', '<html>418</html>']) {
      expect(parseBanUntil(b, T0)).toBeNull();
    }
  });
});

describe('resolveBanWindow precedence', () => {
  it('prefers Retry-After over the body, because it is specific to this response', () => {
    const r = resolveBanWindow({
      retryAfter: '120',
      body: '{"code":-1003,"msg":"IP banned until 99999999999999"}',
      strikes: 1,
      now: T0,
    });
    expect(r).toEqual({ until: T0 + 120_000, source: 'retry-after', raw: '120' });
  });

  it('falls back to the body when there is no Retry-After', () => {
    const until = T0 + 600_000;
    const r = resolveBanWindow({
      retryAfter: null,
      body: `{"code":-1003,"msg":"IP banned until ${until}."}`,
      strikes: 1,
      now: T0,
    });
    expect(r.source).toBe('body');
    expect(r.until).toBe(until);
  });

  it('never lets a stale body timestamp shorten the Retry-After wait', () => {
    // A body timestamp in the past is untrustworthy; the documented header wins.
    const r = resolveBanWindow({
      retryAfter: '120',
      body: '{"code":-1003,"msg":"IP banned until 1600000000"}',
      strikes: 1,
      now: T0,
    });
    expect(r.until).toBe(T0 + 120_000);
  });

  it('falls back to escalation when neither signal is usable', () => {
    const r = resolveBanWindow({ retryAfter: null, body: 'nope', strikes: 1, now: T0 });
    expect(r.source).toBe('escalating');
    expect(r.until).toBe(T0 + escalationMs(1));
  });
});

describe('escalation ladder', () => {
  it('starts at the documented 2-minute minimum ban', () => {
    expect(escalationMs(1)).toBe(2 * 60_000);
  });

  it('caps at the documented 3-day maximum', () => {
    expect(escalationMs(99)).toBe(72 * 3600_000);
  });

  it('escalates monotonically', () => {
    const rungs = [1, 2, 3, 4, 5, 6].map(escalationMs);
    for (let i = 1; i < rungs.length; i++) expect(rungs[i]).toBeGreaterThan(rungs[i - 1]);
  });

  it('treats a nonsensical strike count as a first offence', () => {
    expect(escalationMs(0)).toBe(escalationMs(1));
    expect(escalationMs(-9)).toBe(escalationMs(1));
  });
});

describe('proactive weight budget', () => {
  it('is normal below the 70% slowdown threshold', () => {
    expect(budgetLevel(Math.floor(DEFAULT_WEIGHT_LIMIT * 0.69))).toBe('normal');
    expect(budgetLevel(Math.floor(DEFAULT_WEIGHT_LIMIT * SLOWDOWN_AT) - 1)).toBe('normal');
  });

  it('flips to slowdown exactly at 70%', () => {
    expect(budgetLevel(Math.floor(DEFAULT_WEIGHT_LIMIT * SLOWDOWN_AT))).toBe('slowdown');
  });

  it('flips to pause exactly at 90%', () => {
    expect(budgetLevel(Math.floor(DEFAULT_WEIGHT_LIMIT * 0.89))).toBe('slowdown');
    expect(budgetLevel(Math.floor(DEFAULT_WEIGHT_LIMIT * PAUSE_AT))).toBe('pause');
    expect(budgetLevel(DEFAULT_WEIGHT_LIMIT)).toBe('pause');
  });

  it('stays normal when the header is absent, so a missing header is not a guess', () => {
    expect(budgetLevel(null)).toBe('normal');
  });

  it('reads X-MBX-USED-WEIGHT-1M case-insensitively', () => {
    expect(parseUsedWeight(headers({ 'X-MBX-USED-WEIGHT-1M': '1234' }))).toBe(1234);
    expect(parseUsedWeight(headers({ 'x-mbx-used-weight-1m': '9' }))).toBe(9);
    expect(parseUsedWeight(headers({}))).toBeNull();
    expect(parseUsedWeight(headers({ 'x-mbx-used-weight-1m': 'abc' }))).toBeNull();
  });

  it('keeps essential work running in every state and drops non-essential first', () => {
    expect(purposeAllowed('essential', 'normal')).toBe(true);
    expect(purposeAllowed('essential', 'slowdown')).toBe(true);
    expect(purposeAllowed('essential', 'pause')).toBe(true);

    expect(purposeAllowed('normal', 'normal')).toBe(true);
    expect(purposeAllowed('normal', 'slowdown')).toBe(true);
    expect(purposeAllowed('normal', 'pause')).toBe(false);

    expect(purposeAllowed('nonessential', 'normal')).toBe(true);
    expect(purposeAllowed('nonessential', 'slowdown')).toBe(false);
    expect(purposeAllowed('nonessential', 'pause')).toBe(false);
  });

  it('inserts a delay only when slowing down', () => {
    expect(slowdownDelayMs('normal')).toBe(0);
    expect(slowdownDelayMs('slowdown')).toBeGreaterThan(0);
    expect(slowdownDelayMs('pause')).toBe(0);
  });
});

describe('per-host isolation', () => {
  it('a ban on one Binance host does not stop an unrelated host', () => {
    const c = clockAt(T0);
    const reg = new BanRegistry({ now: c.now, log: () => {} });
    reg.noteLimit({
      host: 'api.binance.com', status: 418,
      headers: headers({ 'retry-after': '120' }), body: null,
    });

    expect(reg.isBanned('api.binance.com')).toBe(true);
    expect(reg.isBanned('fapi.binance.com')).toBe(true);   // same IP pool
    expect(reg.isBanned('api.hyperliquid.xyz')).toBe(false);
    expect(reg.isBanned('api.coingecko.com')).toBe(false);
    expect(reg.isBanned('www.nseindia.com')).toBe(false);
  });

  it('reports the group ban so a sibling Binance host is visibly gated, not silently', () => {
    const c = clockAt(T0);
    const reg = new BanRegistry({ now: c.now, log: () => {} });
    reg.noteLimit({
      host: 'api.binance.com', status: 418,
      headers: headers({ 'retry-after': '120' }), body: null,
    });
    const snap = reg.snapshot();
    expect(snap.groupBans.map((g) => g.group)).toContain('binance');
    const fapi = snap.hosts.find((h) => h.host === 'fapi.binance.com');
    expect(fapi?.banned).toBe(true);
  });

  it('lets a non-Binance host be banned independently', () => {
    const c = clockAt(T0);
    const reg = new BanRegistry({ now: c.now, log: () => {} });
    reg.noteLimit({
      host: 'api.hyperliquid.xyz', status: 429,
      headers: headers({ 'retry-after': '60' }), body: null,
    });
    expect(reg.isBanned('api.hyperliquid.xyz')).toBe(true);
    expect(reg.isBanned('data-api.binance.vision')).toBe(false);
  });

  it('clears only the expired host', () => {
    const c = clockAt(T0);
    const reg = new BanRegistry({ now: c.now, log: () => {} });
    reg.noteLimit({ host: 'api.bybit.com', status: 429, headers: headers({ 'retry-after': '60' }), body: null });
    reg.noteLimit({ host: 'api.coingecko.com', status: 429, headers: headers({ 'retry-after': '60' }), body: null });

    c.advance(61_000);
    expect(reg.isBanned('api.bybit.com')).toBe(false);
    expect(reg.isBanned('api.coingecko.com')).toBe(false);
  });
});

describe('persistence round trip (write, restart, read)', () => {
  it('survives a simulated restart and gates the host before any request', () => {
    const { impl, rows } = memoryPersist();

    const c1 = clockAt(T0);
    const first = new BanRegistry({ now: c1.now, persist: impl, log: () => {} });
    first.noteLimit({
      host: 'data-api.binance.vision', status: 418,
      headers: headers({ 'retry-after': '120' }), body: null,
    });
    expect(rows.size).toBe(1);

    // "Restart": a brand new process, five minutes later, still inside the ban.
    const c2 = clockAt(T0 + 60_000);
    const second = new BanRegistry({ now: c2.now, persist: impl, log: () => {} });
    const loaded = second.loadPersisted();

    expect(loaded).toBe(1);
    expect(second.isBanned('data-api.binance.vision')).toBe(true);
    expect(second.check('data-api.binance.vision', 'essential')).toMatch(/BANNED/);
  });

  it('marks a restored ban as sourced from disk rather than inventing a new one', () => {
    const { impl } = memoryPersist();
    const c1 = clockAt(T0);
    new BanRegistry({ now: c1.now, persist: impl, log: () => {} })
      .noteLimit({ host: 'fapi.binance.com', status: 418, headers: headers({ 'retry-after': '120' }), body: null });

    const c2 = clockAt(T0 + 1000);
    const second = new BanRegistry({ now: c2.now, persist: impl, log: () => {} });
    second.loadPersisted();
    const h = second.snapshot().hosts.find((x) => x.host === 'fapi.binance.com');
    expect(h?.source).toBe('persisted');
  });

  it('drops a ban that expired while the process was down', () => {
    const { impl, rows } = memoryPersist();
    const c1 = clockAt(T0);
    new BanRegistry({ now: c1.now, persist: impl, log: () => {} })
      .noteLimit({ host: 'api.binance.com', status: 418, headers: headers({ 'retry-after': '60' }), body: null });

    // Restart 5 minutes later: the window has closed, so the row is cleared
    // rather than carried forward as a live ban.
    const c2 = clockAt(T0 + 300_000);
    const second = new BanRegistry({ now: c2.now, persist: impl, log: () => {} });
    expect(second.loadPersisted()).toBe(0);
    expect(second.isBanned('api.binance.com')).toBe(false);
    expect(rows.size).toBe(0);
  });

  it('a successful response clears the persisted ban once the window has passed', () => {
    const { impl, rows } = memoryPersist();
    const c = clockAt(T0);
    const reg = new BanRegistry({ now: c.now, persist: impl, log: () => {} });
    reg.noteLimit({ host: 'api.bybit.com', status: 429, headers: headers({ 'retry-after': '30' }), body: null });
    expect(rows.size).toBe(1);
    c.advance(31_000);
    reg.noteSuccess('api.bybit.com');
    expect(rows.size).toBe(0);
  });

  it('survives a persistence backend that throws, rather than taking the caller down', () => {
    const boom: BanPersistence = {
      loadBans: () => { throw new Error('disk locked'); },
      saveBan: () => { throw new Error('disk full'); },
      clearBan: () => { throw new Error('nope'); },
    };
    const msgs: string[] = [];
    const c = clockAt(T0);
    const reg = new BanRegistry({ now: c.now, persist: boom, log: (m) => msgs.push(m) });
    expect(reg.loadPersisted()).toBe(0);
    reg.noteLimit({ host: 'x.example', status: 418, headers: headers({ 'retry-after': '10' }), body: null });
    // The in-memory ban still applies even though the write failed.
    expect(reg.isBanned('x.example')).toBe(true);
    expect(msgs.some((m) => m.includes('disk full'))).toBe(true);
  });
});

describe('no request is made while banned', () => {
  let calls = 0;

  beforeEach(() => {
    calls = 0;
    bans.reset();
    bans.setNow(() => T0);
    bans.setLog(() => {});
    // A transport that counts every outbound request. Standing in for the real
    // socket, so a counted call is exactly one request that would have hit the
    // exchange.
    setTransport(async () => {
      calls++;
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  });

  afterEach(() => {
    setTransport(null);
    bans.reset();
  });

  it('refuses immediately with zero calls, for every purpose including essential', async () => {
    bans.noteLimit({
      host: 'data-api.binance.vision', status: 418,
      headers: headers({ 'retry-after': '120' }), body: null,
    });
    const callsBefore = calls;

    for (const purpose of ['essential', 'normal', 'nonessential'] as const) {
      await expect(
        fetchText('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT', { purpose, retries: 3 }),
      ).rejects.toBeInstanceOf(HostBannedError);
    }
    expect(calls).toBe(callsBefore);
  });

  it('stays silent for the whole window and resumes the moment it closes', async () => {
    let t = T0;
    bans.setNow(() => t);

    await fetchText('https://data-api.binance.vision/api/v3/time').catch(() => {});
    bans.noteLimit({
      host: 'data-api.binance.vision', status: 418,
      headers: headers({ 'retry-after': '120' }), body: null,
    });
    const afterBan = calls;

    for (let elapsed = 0; elapsed < 120_000; elapsed += 5_000) {
      t = T0 + elapsed;
      await fetchText('https://data-api.binance.vision/api/v3/time').catch(() => {});
    }
    expect(calls).toBe(afterBan);

    t = T0 + 121_000;
    await fetchText('https://data-api.binance.vision/api/v3/time');
    expect(calls).toBe(afterBan + 1);
  });

  it('does not retry inside the ban window, which is what escalated 429 into 418', async () => {
    let t = T0;
    bans.setNow(() => t);
    bans.noteLimit({
      host: 'data-api.binance.vision', status: 429,
      headers: headers({ 'retry-after': '120' }), body: null,
    });
    const before = calls;
    await expect(
      fetchText('https://data-api.binance.vision/api/v3/klines?symbol=ETHUSDT', { retries: 5 }),
    ).rejects.toBeInstanceOf(HostBannedError);
    expect(calls).toBe(before);
  });

  it('reads the -1003 body of a real 418 response when there is no Retry-After', async () => {
    const until = T0 + 900_000;
    setTransport(async () => new Response(
      `{"code":-1003,"msg":"Way too much request weight used; IP banned until ${until}. Please use WebSocket Streams for live updates to avoid bans."}`,
      { status: 418, headers: { 'Content-Type': 'application/json' } },
    ));
    let t = T0;
    bans.setNow(() => t);

    await expect(
      fetchText('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT', { retries: 1 }),
    ).rejects.toBeInstanceOf(HttpError);

    expect(bans.isBanned('data-api.binance.vision')).toBe(true);
    expect(bans.bannedUntil('data-api.binance.vision')).toBe(until);
    const before = calls;
    t = T0 + 600_000;
    await expect(
      fetchText('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT'),
    ).rejects.toBeInstanceOf(HostBannedError);
    expect(calls).toBe(before);
  });

  it('pauses non-essential work at 90% but keeps exactly one probe alive', async () => {
    let weight = Math.floor(DEFAULT_WEIGHT_LIMIT * 0.95);
    setTransport(async () => {
      calls++;
      return new Response('[]', {
        status: 200,
        headers: { 'x-mbx-used-weight-1m': String(weight) },
      });
    });
    let t = T0;
    bans.setNow(() => t);

    await fetchText('https://data-api.binance.vision/api/v3/time');
    expect(bans.budgetLevelFor('data-api.binance.vision')).toBe('pause');
    expect(calls).toBe(1);

    // The first held-back call is permitted as a probe: without one request per
    // window the budget can never refresh and the host stays paused forever.
    const beforeProbe = calls;
    await fetchText('https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT', {
      purpose: 'nonessential',
    });
    expect(calls).toBe(beforeProbe + 1);

    // The probe reported 95% again, so the next one is held back.
    await expect(fetchText('https://data-api.binance.vision/api/v3/depth?symbol=ETHUSDT', {
      purpose: 'nonessential',
    })).rejects.toBeInstanceOf(HostBannedError);
    expect(calls).toBe(beforeProbe + 1);

    // Live ingestion is never held back, not even for a probe.
    await fetchText('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT', { purpose: 'essential' });
    expect(calls).toBe(beforeProbe + 2);

    // Once the window rolls and the exchange reports a healthy weight, the
    // budget recovers and held-back calls flow again.
    t = T0 + BUDGET_WINDOW_MS + 1;
    weight = 300;
    await fetchText('https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT', {
      purpose: 'nonessential',
    });
    expect(bans.budgetLevelFor('data-api.binance.vision')).toBe('normal');
    const n = calls;
    await fetchText('https://data-api.binance.vision/api/v3/depth?symbol=ETHUSDT', {
      purpose: 'nonessential',
    });
    expect(calls).toBe(n + 1);
  });

  it('drops a weight reading older than the window it measures', async () => {
    let t = T0;
    bans.setNow(() => t);
    const reg = new BanRegistry({ now: () => t, log: () => {} });
    reg.noteResponse('api.binance.com', headers({ 'x-mbx-used-weight-1m': '5900' }));
    expect(reg.budgetLevelFor('api.binance.com')).toBe('pause');

    // 70 seconds later the rolling window has rolled; the old 5900 no longer
    // describes anything, so obeying it would pause the host indefinitely.
    t = T0 + 70_000;
    expect(reg.budgetLevelFor('api.binance.com')).toBe('normal');
    expect(reg.usedWeightFor('api.binance.com')).toBeNull();
  });

  it('allows at most one probe per window, so a paused host cannot be hammered', () => {
    let t = T0;
    const msgs: string[] = [];
    const reg = new BanRegistry({ now: () => t, log: (m) => msgs.push(m) });
    reg.noteResponse('api.binance.com', headers({ 'x-mbx-used-weight-1m': '5990' }));
    expect(reg.check('api.binance.com', 'nonessential', t)).toBeNull();       // probe
    expect(reg.check('api.binance.com', 'nonessential', t)).toMatch(/PAUSE/); // held
    // A minute later the exchange still reports a saturated weight.
    t = T0 + BUDGET_WINDOW_MS;
    reg.noteResponse('api.binance.com', headers({ 'x-mbx-used-weight-1m': '5990' }));
    expect(reg.check('api.binance.com', 'nonessential', t)).toBeNull();       // next probe
    expect(reg.check('api.binance.com', 'normal', t)).toMatch(/PAUSE/);
    expect(msgs.some((m) => m.includes('probe request'))).toBe(true);
  });
});

describe('dev guard', () => {
  it('warns and names the caller once a single label exceeds the per-minute cap', () => {
    const msgs: string[] = [];
    const c = clockAt(T0);
    const reg = new BanRegistry({ now: c.now, log: (m) => msgs.push(m), devGuardPerMinute: 5 });
    for (let i = 0; i < 5; i++) reg.recordCall('binance klines LUMIAUSDT 5m');
    expect(msgs).toHaveLength(0);

    reg.recordCall('binance klines LUMIAUSDT 5m');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('binance klines LUMIAUSDT 5m');
    expect(msgs[0]).toContain('DEV GUARD');
  });

  it('forgets calls that have aged out of the rolling minute', () => {
    const msgs: string[] = [];
    const c = clockAt(T0);
    const reg = new BanRegistry({ now: c.now, log: (m) => msgs.push(m), devGuardPerMinute: 3 });
    for (let i = 0; i < 3; i++) reg.recordCall('scan');
    c.advance(61_000);
    for (let i = 0; i < 3; i++) reg.recordCall('scan');
    expect(msgs).toHaveLength(0);
  });

  it('tracks each caller separately, so one loud panel cannot mask another', () => {
    const msgs: string[] = [];
    const c = clockAt(T0);
    const reg = new BanRegistry({ now: c.now, log: (m) => msgs.push(m), devGuardPerMinute: 3 });
    for (let i = 0; i < 4; i++) reg.recordCall('popup depth BTCUSDT');
    for (let i = 0; i < 3; i++) reg.recordCall('scan');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('popup depth BTCUSDT');
  });
});

describe('websocket connection-attempt cap', () => {
  it('allows the cap then refuses, rather than looping into a ban', () => {
    const c = clockAt(T0);
    const lim = new ConnectAttemptLimiter(5, 300_000, c.now);
    for (let i = 0; i < 5; i++) expect(lim.tryAcquire()).toBe(true);
    expect(lim.tryAcquire()).toBe(false);
    expect(lim.remaining()).toBe(0);
    expect(lim.suppressedCount()).toBe(1);
  });

  it('recovers as the rolling window slides', () => {
    const c = clockAt(T0);
    const lim = new ConnectAttemptLimiter(2, 300_000, c.now);
    lim.tryAcquire(); lim.tryAcquire();
    expect(lim.tryAcquire()).toBe(false);
    c.advance(300_001);
    expect(lim.tryAcquire()).toBe(true);
  });

  it('backs off exponentially and is bounded', () => {
    const args = { baseMs: 1000, maxMs: 60_000, jitter: 0.3, random: () => 0.5 };
    expect(reconnectDelayMs({ ...args, attempt: 0 })).toBe(1000);
    expect(reconnectDelayMs({ ...args, attempt: 1 })).toBe(2000);
    expect(reconnectDelayMs({ ...args, attempt: 2 })).toBe(4000);
    expect(reconnectDelayMs({ ...args, attempt: 20 })).toBe(60_000);
  });

  it('applies jitter symmetrically and never returns a hot loop', () => {
    const args = { baseMs: 1000, maxMs: 60_000, jitter: 0.3, attempt: 0 };
    expect(reconnectDelayMs({ ...args, random: () => 0 })).toBe(700);
    expect(reconnectDelayMs({ ...args, random: () => 1 })).toBe(1300);
    // With an absurd base and full negative jitter, the 500ms floor holds.
    expect(reconnectDelayMs({ baseMs: 1, maxMs: 1, jitter: 1, attempt: 5, random: () => 0 })).toBe(500);
  });
});

describe('host parsing', () => {
  it('extracts the hostname from rest and websocket urls', () => {
    expect(hostOf('https://data-api.binance.vision/api/v3/klines?x=1')).toBe('data-api.binance.vision');
    expect(hostOf('wss://fstream.binance.com/market/stream?streams=x')).toBe('fstream.binance.com');
    expect(hostOf('HTTPS://API.BINANCE.COM/v3')).toBe('api.binance.com');
    expect(hostOf('data-api.binance.vision')).toBe('data-api.binance.vision');
  });

  it('groups every Binance host, and nothing else', () => {
    expect(groupOf('data-stream.binance.vision')).toBe('binance');
    expect(groupOf('fstream.binance.com')).toBe('binance');
    expect(groupOf('api.coingecko.com')).toBeNull();
  });
});

// Imported late so the `no request is made while banned` block above can use
// it without shadowing the HttpError assertion at the top of the file.
import { HttpError } from '../src/lib/http.js';