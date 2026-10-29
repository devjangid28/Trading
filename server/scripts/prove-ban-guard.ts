/**
 * FIX 1 PROOF — ban-aware rate limiting.
 *
 * Simulates a real HTTP 418 with `Retry-After: 120` against a mock HTTP server
 * and proves the three claims that matter:
 *
 *   (a) no calls for the full 120s window
 *   (b) a RESTART during the ban makes zero calls
 *   (c) calls resume the moment the ban ends
 *
 * Everything is real except the exchange: a real `node:http` server, real
 * `fetch`, real `Response.headers` parsing, real SQLite persistence, and for
 * (b) a genuinely separate OS process.
 *
 * The clock is REAL WALL-CLOCK. This script waits the full 120 seconds rather
 * than fast-forwarding, because the point of the proof is that the wall-clock
 * gate holds, not that a simulated clock does.
 *
 * Usage:  npx tsx server/scripts/prove-ban-guard.ts [--fast]
 *   --fast shortens the window to 8s for a quick re-run; the log says so.
 */
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAST = process.argv.includes('--fast');
const WINDOW_S = FAST ? 8 : 120;
const RETRY_AFTER = FAST ? 8 : 120;

// The DB path must be set BEFORE store.ts is imported: it reads the env var at
// module load. Using a temp file keeps the proof from polluting the real ledger.
const DB = join(mkdtempSync(join(tmpdir(), 'of-banproof-')), 'proof.db');
process.env.ORDERFLOW_DB = DB;

const line = (s = '') => process.stdout.write(`${s}\n`);
const stamp = () => `+${String(Math.round((Date.now() - T0) / 1000)).padStart(3)}s`;
let T0 = Date.now();

/** Every request the mock exchange receives, with its timestamp. */
let serverHits: { at: number; url: string }[] = [];
let banServed = false;

const server: Server = createServer((req, res) => {
  serverHits.push({ at: Date.now(), url: req.url ?? '' });
  if (!banServed) {
    banServed = true;
    // The real shape Binance documents: HTTP 418 plus a Retry-After giving the
    // number of seconds required to wait. Body carries the -1003 message so the
    // body parser is exercised too.
    res.writeHead(418, {
      'Retry-After': String(RETRY_AFTER),
      'Content-Type': 'application/json',
      'x-mbx-used-weight-1m': '5940',
    });
    res.end(
      `{"code":-1003,"msg":"Way too much request weight used; IP banned until ${Date.now() + RETRY_AFTER * 1000}. Please use WebSocket Streams for live updates to avoid bans."}`,
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'x-mbx-used-weight-1m': '120' });
  res.end(JSON.stringify({ serverTime: Date.now() }));
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

const { bans, setTransport, fetchText, installBanPersistence, HostBannedError } =
  await import('../src/lib/http.js');
const store = await import('../src/ledger/store.js');

installBanPersistence({
  loadBans: store.loadBans,
  saveBan: store.saveBan,
  clearBan: store.clearBan,
});

// The ban registry sees the real Binance host; only the socket is redirected.
setTransport(async (url, init) => {
  const u = new URL(url);
  return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
});

bans.setLog((m) => line(`  [ratelimit] ${m}`));

const HOST = 'data-api.binance.vision';
const hits = () => serverHits.length;
const ok = (label: string, pass: boolean, detail: string) => {
  line(`${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
  if (!pass) failures++;
};
let failures = 0;

// ── 1. Trip the ban ──────────────────────────────────────────────────────────
line('='.repeat(78));
line('FIX 1 PROOF — HTTP 418 with Retry-After: ' + RETRY_AFTER);
if (FAST) line('!! --fast mode: the window is shortened to 8s, this is a rehearsal.');
line(`mock exchange      http://127.0.0.1:${port}  (a real node:http server)`);
line(`persistence        ${DB}  (real SQLite)`);
line(`clock              REAL WALL-CLOCK`);
line('='.repeat(78));
line();

line(`${stamp()}  [1] first request against ${HOST}`);
let tripped = false;
try {
  await fetchText(`https://${HOST}/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=10`, { retries: 2 });
} catch (e) {
  tripped = (e as Error).name === 'HttpError' && (e as { status?: number }).status === 418;
}
ok('418 was returned and surfaced', tripped, `status=${tripped ? 418 : 'n/a'}`);

const snap = bans.snapshot();
const self = snap.hosts.find((h) => h.host === HOST);
line(`${stamp()}  [2] ban recorded`);
line(`      bannedUntil  ${new Date(self!.bannedUntil!).toISOString()}`);
line(`      source       ${self!.source}`);
line(`      strikes      ${self!.strikes}`);
ok('ban window came from Retry-After', self!.source === 'retry-after', `source=${self!.source}`);
ok('ban window is 120s', Math.round((self!.bannedUntil! - Date.now()) / 1000) === RETRY_AFTER,
  `${Math.round((self!.bannedUntil! - Date.now()) / 1000)}s remaining`);
line();

const hitsAtBan = hits();

// ── 2. (b) A restart during the ban ──────────────────────────────────────────
line(`${stamp()}  [3] RESTART — spawning a separate node process against the same SQLite`);
const childOut = join(tmpdir(), `of-banproof-${process.pid}.json`);
await new Promise<void>((resolve) => {
  // Run the child through the tsx CLI directly rather than `--import tsx`:
  // the CLI registers the same .js -> .ts resolver the parent relies on, which
  // `--import` alone did not do on this Node version.
  const tsxCli = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const childFile = fileURLToPath(new URL('./prove-ban-restart.ts', import.meta.url));
  const child = spawn(process.execPath, [tsxCli, childFile], {
    env: {
      ...process.env,
      PROOF_HOST: HOST,
      PROOF_PORT: String(port),
      PROOF_OUT: childOut,
      ORDERFLOW_DB: DB,
    },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    if (code !== 0) line(`      [restart] child exited ${code}`);
    resolve();
  });
});
const { readFileSync } = await import('node:fs');
const child = JSON.parse(readFileSync(childOut, 'utf8')) as {
  restored: number; banned: boolean; error: string;
};
line();
ok('restart restored the ban from disk', child.restored === 1 && child.banned,
  `restored=${child.restored} banned=${child.banned}`);
ok('restart made ZERO calls', hits() === hitsAtBan,
  `server hits before=${hitsAtBan} after=${hits()}`);
ok('restart refused before opening a socket', child.error.includes('HostBannedError'),
  child.error.slice(0, 90));
line();

// ── 3. (a) Silence for the whole window ──────────────────────────────────────
line(`${stamp()}  [4] holding for the ban window — attempting a request every 5s`);
// Bounded by the ban's own deadline, not by a fixed elapsed total, so the last
// attempt still lands strictly INSIDE the window. An earlier version slept to
// exactly RETRY_AFTER, which let the final probe land on the boundary and pass
// through legitimately — the check was then measuring its own timing.
let refusals = 0;
while (bans.remainingMs(HOST) > 3_000) {
  await new Promise((r) => setTimeout(r, 5_000));
  // Re-check AFTER sleeping. The loop condition is evaluated before the sleep,
  // so a request fired unconditionally would land on the boundary whenever the
  // remaining time was under one sleep interval — and would then pass through
  // legitimately, which measures the harness rather than the limiter.
  if (!bans.isBanned(HOST)) break;
  try {
    await fetchText(`https://${HOST}/api/v3/klines?symbol=ETHUSDT&interval=5m&limit=10`, { retries: 2 });
  } catch (e) {
    if (e instanceof HostBannedError) refusals++;
    const left = Math.ceil(bans.remainingMs(HOST) / 1000);
    line(`${stamp()}      refused (${(e as Error).name}), ${left}s left on the ban`);
  }
}
line();
ok(`no calls during the ${RETRY_AFTER}s window`, hits() === hitsAtBan,
  `server hits still ${hits()}`);
ok('every attempt was refused pre-flight', refusals >= 1, `${refusals} refusals`);
line();

// ── 4. (c) Resume after the ban ends ─────────────────────────────────────────
line(`${stamp()}  [5] waiting for the ban to expire, then retrying`);
while (bans.isBanned(HOST)) await new Promise((r) => setTimeout(r, 1000));
line(`${stamp()}  [6] ban has expired; making a request`);
let resumeErr = '';
const resumed = await fetchText(`https://${HOST}/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=10`)
  .then(() => true).catch((e) => { resumeErr = `${(e as Error).name}: ${(e as Error).message}`; return false; });
ok('calls resume after the ban ends', resumed && hits() === hitsAtBan + 1,
  `server hits ${hitsAtBan} -> ${hits()}${resumeErr ? ` (error: ${resumeErr})` : ' (200 OK served)'}`);

const persisted = store.loadBans();
line();
ok('the expired ban was cleared from SQLite', persisted.length === 0,
  `${persisted.length} row(s) remain`);

line();
line('='.repeat(78));
line(`RESULT: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
line('='.repeat(78));
line();
line('every request the mock exchange actually received:');
for (const h of serverHits) {
  line(`  +${String(Math.round((h.at - T0) / 1000)).padStart(4)}s  ${h.url}`);
}

server.close();
try { rmSync(join(DB, '..'), { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failures === 0 ? 0 : 1);