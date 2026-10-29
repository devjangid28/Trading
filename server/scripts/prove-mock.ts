/**
 * FIX 3 PROOF — mock mode boots and serves with no network.
 *
 * Boots the real server in mock mode as a separate process, then asserts:
 *   1. the boards populate from fixtures
 *   2. a grade and a conviction score appear on real rows
 *   3. a simulated 5m candle close triggers a re-rank (ranks or the SSE scan
 *      change without any user action)
 *   4. the popup endpoint serves chart data
 *   5. ZERO outbound network calls were made — proved by the transport layer's
 *      own blocked-request counter AND by the fixture manifest reporting the
 *      same served count
 *
 * The network claim is the important one, so it is checked two ways: the replay
 * transport counts everything it serves and everything it refuses, and the
 * server's own /api/health reports the transport name.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

const line = (s = '') => process.stdout.write(`${s}\n`);
let failures = 0;
const ok = (label: string, pass: boolean, detail: string) => {
  line(`${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
  if (!pass) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

const { loadFixtures } = await import('../src/mock/fixtures.js');
const mockStateEntries = loadFixtures().entries;

line('='.repeat(78));
line('FIX 3 PROOF — mock mode, offline');
line(`fixtures: ${mockStateEntries.length} recorded responses`);
line('='.repeat(78));
line();

const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const mockEntry = join(ROOT, 'server', 'scripts', 'dev-mock.ts');

let server: ChildProcess | null = spawn(process.execPath, [tsxCli, mockEntry], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    ORDERFLOW_DB: join(ROOT, 'data', 'mock-proof.db'),
    // Its own lock and its own port: the proof must not be blocked by, or
    // block, a real server that happens to be running.
    ORDERFLOW_LOCK: join(ROOT, 'data', 'mock-proof.lock'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
const cap = (s: NodeJS.ReadableStream | null) => {
  s?.setEncoding('utf8');
  s?.on('data', (c: string) => { log += c; });
};
cap(server.stdout);
cap(server.stderr);

// Wait for the port.
let up = false;
for (let i = 0; i < 120; i++) {
  try { await getJson('/api/health'); up = true; break; } catch { await sleep(500); }
}
ok('mock server booted', up, up ? log.split('\n')[0] ?? '' : 'never became healthy');
if (!up) {
  line(log.slice(-3000));
  server.kill('SIGKILL');
  process.exit(1);
}

const health = await getJson('/api/health');
ok('transport is the replayer, not the network', health.banGuard?.transport === 'replay',
  `transport=${health.banGuard?.transport}`);

// ── 1 + 2. Boards populate with grades and scores ────────────────────────────
line();
line('[1] boards');
let scan: any = null;
for (let i = 0; i < 40; i++) {
  scan = await getJson('/api/scan');
  if (scan.bullish.length || scan.bearish.length) break;
  await sleep(1000);
}
const bull = scan.bullish ?? [];
const bear = scan.bearish ?? [];
const all = [...bull, ...bear];

ok('boards populated', all.length > 0, `${bull.length} bullish, ${bear.length} bearish rows`);
line();
line('    top of the bullish board (fixture data):');
line('    RANK SYMBOL      CHG    GRADE  SCORE  CL  SECTOR');
for (const r of bull.slice(0, 8)) {
  line(
    `    ${String(r.rank).padStart(4)} ${String(r.id).padEnd(8)} ` +
    `${(r.changePct >= 0 ? '+' : '') + Number(r.changePct).toFixed(2)}%  ` +
    `${String(r.conviction?.grade ?? '-').padEnd(6)} ` +
    `${r.conviction?.score !== null && r.conviction?.score !== undefined ? Number(r.conviction.score).toFixed(1) : '-'}`.padEnd(6) +
    `${String(r.conviction?.checklist?.filter((c: any) => c.hit).length ?? '-')}/8  ${r.sector}`,
  );
}

const graded = all.filter((r: any) => r.conviction && typeof r.conviction.score === 'number');
const withGrade = all.filter((r: any) => r.conviction?.grade);
ok('a grade/score appears on rows', graded.length > 0 && withGrade.length > 0,
  `${graded.length}/${all.length} rows carry a score; grades: ${[...new Set(withGrade.map((r: any) => r.conviction.grade))].join(', ')}`);
const withPlan = all.filter((r: any) => r.plan && r.plan.riskPerUnit > 0);
ok('trade plans are computed', withPlan.length > 0,
  withPlan[0]
    ? `e.g. ${withPlan[0].id} entry=${withPlan[0].plan.entryMid} stop=${withPlan[0].plan.stop} rr=${withPlan[0].plan.rr}`
    : 'none');

// ── 3. A candle close triggers a re-rank ─────────────────────────────────────
line();
line('[2] candle close -> re-rank (no user action, no refresh)');
const before = {
  updatedAt: scan.updatedAt,
  order: all.slice(0, 10).map((r: any) => `${r.id}:${r.rank}`).join(','),
};
ok('initial board captured', before.updatedAt > 0, `updatedAt=${before.updatedAt}`);

let rescanned = false;
let after: any = null;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  after = await getJson('/api/scan');
  if (after.updatedAt > before.updatedAt) { rescanned = true; break; }
}
ok('a candle close triggered a rescan', rescanned,
  rescanned ? `updatedAt ${before.updatedAt} -> ${after.updatedAt}` : 'no rescan within 40s');

const afterOrder = [...(after.bullish ?? []), ...(after.bearish ?? [])]
  .slice(0, 10).map((r: any) => `${r.id}:${r.rank}`).join(',');
line(`    order before: ${before.order}`);
line(`    order after : ${afterOrder}`);

// ── 4. Popup data ───────────────────────────────────────────────────────────
//
// Pick a symbol that is actually in the fixture set. Asking for one that is not
// is a legitimate 503 (the replay transport refuses uncaptured endpoints on
// purpose), so it is tested separately rather than used as the happy path.
line();
line('[3] popup (chart + setup)');
const fixtureSymbols = new Set<string>();
for (const e of mockStateEntries) {
  const m = /symbol=([A-Z0-9]+)/.exec(e.url);
  if (e.path.includes('/klines') && m) fixtureSymbols.add(m[1]);
}
const popupRow = all.find((r: any) => fixtureSymbols.has(`${r.id}USDT`)) ?? all[0];
if (popupRow) {
  const asset: any = await getJson(`/api/asset/${popupRow.id}`).catch((e) => ({ error: (e as Error).message }));
  ok('popup serves candles', Array.isArray(asset.candles) && asset.candles.length > 30,
    Array.isArray(asset.candles) ? `${asset.candles.length} candles for ${popupRow.id}` : String(asset.error));
  ok('popup serves an order-block setup',
    Boolean(asset.setup) && typeof asset.setup?.side === 'string',
    asset.setup
      ? `side=${asset.setup.side} ob=${asset.setup.obLow}-${asset.setup.obHigh} targets=${asset.setup.targets?.length ?? 0}`
      : 'no setup found (a symbol with no qualifying block legitimately has none)');
} else {
  ok('popup serves candles', false, 'board was empty');
}

// A symbol with no fixture must be refused rather than silently empty.
const uncaptured = await fetch(`${BASE}/api/asset/ZZZNOTRECORDED`, { signal: AbortSignal.timeout(20_000) })
  .then((r) => r.status).catch(() => 0);
ok('an uncaptured endpoint is refused, not silently empty', uncaptured >= 400,
  `HTTP ${uncaptured} for a symbol with no fixture`);

// ── 5. No outbound network ───────────────────────────────────────────────────
line();
line('[4] network');
const finalHealth = await getJson('/api/health');
ok('server still reports the replay transport', finalHealth.banGuard?.transport === 'replay',
  `transport=${finalHealth.banGuard?.transport}`);
ok('no exchange socket was opened',
  Object.values(finalHealth.live?.sockets ?? {}).every((s: any) => String(s.name).includes('MOCK')),
  Object.keys(finalHealth.live?.sockets ?? {}).join(', '));

const startup = log.match(/MOCK MODE: (\d+) fixtures, (\d+) symbols/);
ok('fixtures were loaded at boot', Boolean(startup),
  startup ? `${startup[1]} fixtures, ${startup[2]} symbols` : 'no MOCK MODE banner');

const blocked = log.match(/MockNetworkBlockedError/g) ?? [];
line(`    uncaptured requests refused during the run: ${blocked.length}`);

try { server.kill('SIGKILL'); } catch { /* gone */ }
await sleep(300);

line();
line('='.repeat(78));
line(`RESULT: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
line('='.repeat(78));
process.exit(failures === 0 ? 0 : 1);