/**
 * FIX 2 PROOF — supervised run.
 *
 * Shows, against a real supervised process and a real SQLite database:
 *   1. the supervisor starts the server
 *   2. killing the server mid-run makes the supervisor restart it
 *   3. the restart records a gap row for the hole
 *   4. the ledger resumes (heartbeats continue)
 *   5. a second launch refuses to start and names the holder
 *
 * Uses a stub server (`prove-supervisor-child.ts`) rather than the real one so
 * the crash is deterministic and no Binance request is made. The supervisor,
 * the lock, the run table, the gap table and the self-check are all the real
 * code paths.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// server/scripts/ -> server/ -> repo root
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'of-supproof-'));
const DB = join(TMP, 'supervisor.db');
const LOCK = join(TMP, 'orderflow.lock');
const OUT = join(TMP, 'result.json');

process.env.ORDERFLOW_DB = DB;
process.env.ORDERFLOW_LOCK = LOCK;

const line = (s = '') => process.stdout.write(`${s}\n`);
let failures = 0;
const ok = (label: string, pass: boolean, detail: string) => {
  line(`${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(48)} ${detail}`);
  if (!pass) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { loadBans, processGaps, gapSummarySince, recordRunStart, restartsSince } =
  await import('../src/ledger/store.js');
const { currentHolder: readHolder } = await import('../src/runtime/lock.js');

line('='.repeat(78));
line('FIX 2 PROOF — supervised run, crash recovery, single-instance lock');
line(`database   ${DB}`);
line(`lock file  ${LOCK}`);
line('='.repeat(78));
line();

const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const supervisorScript = join(ROOT, 'server', 'scripts', 'supervisor.ts');
const childScript = join(ROOT, 'server', 'scripts', 'prove-supervisor-child.ts');

const env = {
  ...process.env,
  ORDERFLOW_DB: DB,
  ORDERFLOW_LOCK: LOCK,
  ORDERFLOW_SERVER_ENTRY: childScript,
  PORT: '8799',
};

let sup: ChildProcess | null = null;
const spawnSup = (): ChildProcess => spawn(process.execPath, [tsxCli, supervisorScript], {
  cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
});
sup = spawnSup();

let supOut = '';
const capture = (s: NodeJS.ReadableStream | null) => {
  s?.setEncoding('utf8');
  s?.on('data', (c: string) => { supOut += c; process.stdout.write(c); });
};
capture(sup.stdout);
capture(sup.stderr);

// ── 1. Start ────────────────────────────────────────────────────────────────
line('[1] starting the supervisor');
for (let i = 0; i < 60 && !/PROOF-STUB up/.test(supOut); i++) await sleep(500);
ok('supervisor started the server', /PROOF-STUB up/.test(supOut),
  /PROOF-STUB up/.test(supOut) ? supOut.match(/PROOF-STUB up[^\n]*/)?.[0] ?? '' : 'never came up');

const holder1 = readHolder();
ok('lock held by the running server', holder1 !== null && holder1.pid > 0,
  holder1 ? `pid=${holder1.pid} port=${holder1.port} label=${holder1.label}` : 'no lock file');

await sleep(2500);
const beatsBefore = loadBans().find((b) => b.host === '__proof_heartbeat__');
ok('ledger is receiving beats', (beatsBefore?.strikes ?? 0) >= 2,
  `${beatsBefore?.strikes ?? 0} beats recorded`);
line();

// ── 2. Second instance refuses ──────────────────────────────────────────────
line('[2] attempting a second launch while the first is running');
const second = spawn(process.execPath, [tsxCli, childScript], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let secondOut = '';
second.stdout?.setEncoding('utf8');
second.stderr?.setEncoding('utf8');
second.stdout?.on('data', (c: string) => { secondOut += c; });
second.stderr?.on('data', (c: string) => { secondOut += c; });
const secondCode = await new Promise<number | null>((r) => second.on('exit', r));

line('    --- second instance output ---');
for (const l of secondOut.split('\n').filter(Boolean)) line(`    ${l}`);
line('    -------------------------------');
ok('second instance exited non-zero', secondCode === 11, `exit code ${secondCode}`);
ok('second instance named the holder', /already running/i.test(secondOut) && /PID \d+/.test(secondOut),
  secondOut.match(/another OrderFlow instance[^\n]*/)?.[0] ?? 'no message');
line();

// ── 3. Kill it mid-run ──────────────────────────────────────────────────────
line('[3] killing the server mid-run (this is the crash)');
const pidToKill = readHolder()?.pid ?? 0;
if (pidToKill > 0) {
  process.kill(pidToKill, 'SIGKILL');
  line(`    SIGKILL sent to pid ${pidToKill}`);
} else {
  line('    FAIL: no pid in the lock file, nothing to kill');
}
await sleep(1500);
ok('supervisor noticed the death', /died after/.test(supOut),
  supOut.match(/died after[^\n]*/)?.[0] ?? 'no death line');

// Wait for the restart.
const before = supOut.length;
for (let i = 0; i < 60; i++) {
  if (/PROOF-STUB up/.test(supOut.slice(before))) break;
  await sleep(500);
}
const restarted = /PROOF-STUB up/.test(supOut.slice(before));
ok('supervisor restarted the server', restarted,
  restarted ? supOut.slice(before).match(/PROOF-STUB up[^\n]*/)?.[0] ?? '' : 'no restart');
ok('supervisor reported the backoff', /crash-loop backoff/.test(supOut),
  supOut.match(/waiting \d+s before restart[^\n]*/)?.[0] ?? 'no backoff line');
line();

// ── 4. Gap row + ledger resumes ─────────────────────────────────────────────
line('[4] checking the gap row and that the ledger resumed');
await sleep(2500);
const gaps = processGaps(5);
const gap = gaps.find((g) => g.reason === 'crash-or-restart');
ok('a process gap was recorded', Boolean(gap),
  gap ? `${gap.minutes}m between ${new Date(gap.fromTs).toISOString()} and ${new Date(gap.toTs).toISOString()}` : 'none');

const beatsAfter = loadBans().find((b) => b.host === '__proof_heartbeat__');
ok('ledger resumed after the restart', (beatsAfter?.strikes ?? 0) >= 2,
  `${beatsAfter?.strikes ?? 0} beats recorded after recovery (was ${beatsBefore?.strikes ?? 0} before the crash)`);

const gap7 = gapSummarySince(Date.now() - 7 * 86_400_000);
ok('gaps are queryable over 7 days', gap7.count >= 1,
  `${gap7.count} gap(s), ${gap7.totalMinutes} minute(s) in the last 7 days`);
const runs = restartsSince(Date.now() - 86_400_000, true);
ok('restarts in the last 24h are counted', runs >= 2, `${runs} run(s) recorded`);
line();

// ── 5. Log rotation exists ──────────────────────────────────────────────────
line('[5] log file');
const logPath = join(ROOT, 'data', 'logs', 'orderflow.log');
ok('supervisor writes a rotating log', existsSync(logPath), logPath);
line();

// ── Teardown ────────────────────────────────────────────────────────────────
try { sup?.kill('SIGKILL'); } catch { /* already gone */ }
await sleep(500);
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

line();
line('='.repeat(78));
line(`RESULT: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
line('='.repeat(78));
process.exit(failures === 0 ? 0 : 1);