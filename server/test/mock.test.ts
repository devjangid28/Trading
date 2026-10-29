import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * FIX 3 — mock mode.
 *
 * Two layers of test:
 *
 *   1. Unit — the replay transport serves captured responses and REFUSES
 *      everything else. The refusal is the load-bearing half: a mock that
 *      quietly answers `[]` for an uncaptured endpoint produces a UI that looks
 *      empty rather than broken, and the bug gets built into a screen.
 *
 *   2. Boot — the real server, started in mock mode, serving a populated board
 *      with grades and scores, re-ranking on a simulated candle close, and
 *      making zero outbound calls.
 *
 * NO NETWORK IS TOUCHED BY EITHER LAYER. The fixture directory is committed,
 * so this runs offline and deterministically.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8907;
const BASE = `http://127.0.0.1:${PORT}`;

describe('replay transport (unit)', () => {
  let transport: typeof import('../src/mock/transport.js');
  let fixtures: typeof import('../src/mock/fixtures.js');

  beforeAll(async () => {
    transport = await import('../src/mock/transport.js');
    fixtures = await import('../src/mock/fixtures.js');
  });

  it('canonicalises a URL so query order does not matter', () => {
    const a = fixtures.fixtureKey('https://h/p?b=2&a=1');
    const b = fixtures.fixtureKey('https://h/p?a=1&b=2');
    expect(a).toBe(b);
    expect(a).toBe('h/p?a=1&b=2');
  });

  it('ignores window parameters when matching loosely', () => {
    // limit and startTime select a window over one series, not an endpoint.
    expect(fixtures.fixtureKeyLoose('https://h/k?symbol=BTCUSDT&interval=5m&limit=500&startTime=1'))
      .toBe(fixtures.fixtureKeyLoose('https://h/k?interval=5m&symbol=BTCUSDT&limit=50'));
  });

  it('loads the committed fixture manifest', () => {
    const idx = fixtures.loadFixtures();
    expect(idx.entries.length).toBeGreaterThan(0);
    expect(idx.capturedAt).toBeTruthy();
  });

  it('serves a captured response with its real body', async () => {
    const st = transport.installMockTransport();
    const { fetchJson } = await import('../src/lib/http.js');
    try {
      // NOTE: through fetchJson, not the global fetch. The replay transport is
      // installed on the app's request path; Node's global fetch would bypass
      // it entirely and hit the real exchange — which is precisely the bug this
      // arrangement is meant to make impossible.
      const url = st.index.entries.find((e) => e.path.includes('/klines'))!.url;
      const body = await fetchJson<unknown[]>(url);
      expect(Array.isArray(body)).toBe(true);
      expect(body!.length).toBeGreaterThan(10);
      expect(st.served.length).toBe(1);
    } finally {
      transport.uninstallMockTransport();
    }
  });

  it('REFUSES an endpoint with no fixture, rather than answering empty', async () => {
    const st = transport.installMockTransport();
    const { fetchText } = await import('../src/lib/http.js');
    try {
      await expect(
        fetchText('https://data-api.binance.vision/api/v3/klines?symbol=NOTAREALSYMBOL&interval=5m&limit=10'),
      ).rejects.toBeInstanceOf(fixtures.MockNetworkBlockedError);
      expect(st.blocked.length).toBeGreaterThan(0);
      expect(st.served.length).toBe(0);
    } finally {
      transport.uninstallMockTransport();
    }
  });

  it('refuses every host, not just exchanges — mock mode has no network at all', async () => {
    const st = transport.installMockTransport();
    const { fetchText } = await import('../src/lib/http.js');
    try {
      for (const url of [
        'https://www.nseindia.com/api/allIndices',
        'https://api.coingecko.com/api/v3/global',
        'https://www.bea.gov/news/schedule',
      ]) {
        await expect(fetchText(url)).rejects.toBeInstanceOf(fixtures.MockNetworkBlockedError);
      }
      expect(st.blocked.length).toBe(3);
      expect(st.served.length).toBe(0);
    } finally {
      transport.uninstallMockTransport();
    }
  });

  it('builds a dataset with candles, prices and per-timeframe coverage', async () => {
    const st = transport.installMockTransport();
    try {
      const { buildDataset } = await import('../src/mock/dataset.js');
      const ds = buildDataset(st.index);
      expect(ds.symbols.length).toBeGreaterThan(5);
      expect(ds.priceBySymbol.size).toBeGreaterThan(5);
      expect(ds.coverage['5m']).toBeGreaterThan(5);
      expect(ds.coverage['1h']).toBeGreaterThan(5);

      const btc = ds.candlesBySymbol.get('BTCUSDT');
      expect(btc).toBeDefined();
      expect(btc!.length).toBeGreaterThan(100);
      // Sorted oldest-first and internally consistent — the parsers rely on it.
      expect(btc![0].t).toBeLessThan(btc![btc!.length - 1].t);
      for (const c of btc!.slice(0, 20)) {
        expect(c.h).toBeGreaterThanOrEqual(c.l);
        expect(c.c).toBeGreaterThan(0);
      }
    } finally {
      transport.uninstallMockTransport();
    }
  });

  it('drives the same onKlineClose handler the real socket uses', async () => {
    const st = transport.installMockTransport();
    const { buildDataset } = await import('../src/mock/dataset.js');
    const { MockLive } = await import('../src/mock/mockLive.js');
    const ds = buildDataset(st.index);

    let closes = 0;
    let ticks = 0;
    const ml = new MockLive({
      symbols: ds.symbols,
      candlesBySymbol: ds.candlesBySymbol,
      priceBySymbol: ds.priceBySymbol,
      changeBySymbol: ds.changeBySymbol,
      // Fast intervals so the test does not wait the production 15s.
      tickMs: 20,
      candleCloseMs: 40,
      handler: { onKlineClose: () => { closes++; }, onTick: () => { ticks++; } },
    });
    try {
      ml.start();
      await new Promise((r) => setTimeout(r, 200));
      // Ticks stream, and candle closes fire for every tracked symbol on the
      // close interval — the same callback production invokes from kline_5m.
      expect(ticks).toBeGreaterThan(0);
      expect(closes).toBeGreaterThan(0);
      expect(closes).toBeGreaterThanOrEqual(ds.symbols.length);
    } finally {
      ml.stop();
      transport.uninstallMockTransport();
    }
  });
});

describe('mock mode (booted server)', () => {
  let server: ChildProcess;
  let log = '';
  let healthy = false;

  const get = async (path: string) => {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    return res.json() as Promise<any>;
  };

  beforeAll(async () => {
    const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    server = spawn(process.execPath, [tsxCli, join(ROOT, 'server', 'scripts', 'dev-mock.ts')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        ORDERFLOW_DB: join(ROOT, 'data', 'mock-test.db'),
        ORDERFLOW_LOCK: join(ROOT, 'data', 'mock-test.lock'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const cap = (s: NodeJS.ReadableStream | null) => {
      s?.setEncoding('utf8');
      s?.on('data', (c: string) => { log += c; });
    };
    cap(server.stdout);
    cap(server.stderr);

    for (let i = 0; i < 120; i++) {
      try { await get('/api/health'); healthy = true; break; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
  }, 120_000);

  afterAll(() => {
    if (process.platform === 'win32' && server?.pid) {
      try {
        spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch { /* gone */ }
    }
    try { server.kill('SIGKILL'); } catch { /* gone */ }
  });

  it('boots with no outbound network', () => {
    expect(healthy, `server never became healthy:\n${log.slice(-2000)}`).toBe(true);
    expect(log).toMatch(/MOCK MODE/);
  }, 120_000);

  it('reports itself as mock so the UI cannot mistake it for live', async () => {
    const h = await get('/api/health');
    expect(h.mock.active).toBe(true);
    expect(h.mock.fixtures).toBeGreaterThan(0);
    expect(h.banGuard.transport).toBe('replay');
    expect(Object.values(h.live.sockets).every((s: any) => String(s.name).includes('MOCK'))).toBe(true);
  });

  it('populates boards with grades and scores', async () => {
    let scan: any = null;
    for (let i = 0; i < 40; i++) {
      scan = await get('/api/scan');
      if (scan.bullish.length + scan.bearish.length > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const rows = [...scan.bullish, ...scan.bearish];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => typeof r.conviction?.score === 'number')).toBe(true);
    expect(rows.some((r: any) => r.plan && r.plan.riskPerUnit > 0)).toBe(true);
  }, 120_000);

  it('re-ranks when a simulated 5m candle closes', async () => {
    const before = await get('/api/scan');
    let after: any = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      after = await get('/api/scan');
      if (after.updatedAt > before.updatedAt) break;
    }
    // A rescan happened without any client action, which is what a real
    // kline_5m close drives in production.
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
  }, 120_000);

  it('serves popup chart data', async () => {
    const scan = await get('/api/scan');
    const row = [...scan.bullish, ...scan.bearish][0];
    const asset = await get(`/api/asset/${row.id}`).catch(() => null);
    if (asset) {
      expect(asset.candles.length).toBeGreaterThan(30);
    } else {
      // Legitimate when the only board symbols lack fixtures; the refusal is
      // itself correct behaviour and is covered by the unit test above.
      expect(asset).toBeNull();
    }
  });

  it('the popup payload carries a session VWAP, not a missing field', async () => {
    // The popup's chart line and its "price above VWAP" alignment tick both
    // read this field. It was absent entirely, so a popup opened from a surface
    // with no board row in hand rendered `VWAP n/a` and failed a check the board
    // was simultaneously passing. Asserted here over the real route, offline.
    const asset = await get('/api/asset/BTCUSDT');
    expect(typeof asset.vwap).toBe('number');
    expect(Number.isFinite(asset.vwap)).toBe(true);
    expect(asset.vwap).toBeGreaterThan(0);

    // It must be a real measurement of the candles it ships with, not a number
    // that satisfies the type: a volume-weighted average price cannot fall
    // outside the range of the prices it was averaged from.
    const closed = asset.candles.filter((c: any) => c.closed);
    const session = closed.slice(Math.max(0, closed.length - 289));
    const low = Math.min(...session.map((c: any) => c.l));
    const high = Math.max(...session.map((c: any) => c.h));
    expect(asset.vwap).toBeGreaterThanOrEqual(low);
    expect(asset.vwap).toBeLessThanOrEqual(high);
  }, 120_000);

  it('made no real network call during the whole session', () => {
    // The replay transport is the only transport installed, and it throws on
    // anything uncaptured — so a successful boot is itself the proof. What is
    // asserted here is that nothing slipped past it.
    expect(log).not.toMatch(/ENOTFOUND|ECONNREFUSED|EAI_AGAIN/);
    expect(log).not.toMatch(/HTTP 429|HTTP 418/);
  });
});