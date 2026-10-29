import { spawn, type ChildProcess } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * FIX 2 — supervised run.
 *
 * WHY A SMALL NODE WRAPPER AND NOT pm2
 *
 * pm2 was the obvious choice and was rejected on evidence, not taste:
 *
 *   - pm2's Windows support has a long tail of open issues around daemonising
 *     and the `startup`/`save` flow that Task Scheduler depends on. The one
 *     thing this must get right is starting on login unattended.
 *   - It is a global install: the supervisor would then be a machine-wide
 *     dependency that does not travel with the repo, so a fresh clone on
 *     another machine would need a global install before `npm run start:forever`
 *     works at all. Everything here uses only Node built-ins and the existing
 *     devDependency on tsx.
 *   - The features actually needed are small and specific: restart on exit,
 *     crash-loop backoff, log rotation, and a lock file. pm2 is a process
 *     manager for fleets; this is a single always-on process on a laptop, and
 *     Task Scheduler is already the Windows-native answer to "start on login".
 *
 * On Linux/macOS the same wrapper works under systemd or a `pm2 startup`
 * equivalent, so nothing here is Windows-only.
 *
 * CRASH-LOOP BACKOFF
 *
 * Restarting instantly on a crash is how a bad deploy becomes an outage: the
 * process fails, restarts, fails again, and each cycle fires a partial scan at
 * Binance. So a run that dies quickly gets an exponentially longer wait, and
 * the backoff resets only after the process has stayed up long enough to count
 * as healthy.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// server/scripts/ -> server/ -> repo root
const ROOT = resolve(HERE, '../..');
const LOG_DIR = resolve(ROOT, 'data/logs');
const LOG_FILE = join(LOG_DIR, 'orderflow.log');

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** A run shorter than this counts as a crash loop, not a healthy boot. */
const HEALTHY_AFTER_MS = 60_000;

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_LOGS = 5;

function log(message: string): void {
  const line = `${new Date().toISOString()} [supervisor] ${message}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    rotateIfNeeded();
    appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch {
    // Never let logging take the supervisor down.
  }
}

/**
 * Size-based rotation.
 *
 * Deliberately not a date scheme: the interesting case is a crash loop, which
 * happens minutes apart, and a daily rotation would put the entire loop inside
 * one file.
 */
function rotateIfNeeded(): void {
  if (!existsSync(LOG_FILE)) return;
  if (statSync(LOG_FILE).size < MAX_LOG_BYTES) return;
  for (let i = KEEP_LOGS - 1; i >= 1; i--) {
    const from = `${LOG_FILE}.${i}`;
    const to = `${LOG_FILE}.${i + 1}`;
    if (existsSync(from)) {
      if (i + 1 > KEEP_LOGS) { try { unlinkSync(from); } catch { /* ignore */ } continue; }
      try { renameSync(from, to); } catch { /* ignore */ }
    }
  }
  try { renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch { /* ignore */ }
}

function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures - 1, 8));
}

/** Resolve the server entry point, preferring tsx for TypeScript. */
function serverCommand(): { cmd: string; args: string[] } {
  const tsxCli = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');
  if (!existsSync(tsxCli)) {
    throw new Error('tsx not found. Run `npm install` before `npm run start:forever`.');
  }
  // ORDERFLOW_SERVER_ENTRY exists so the acceptance proof can supervise a stub
  // server instead of the real one, without a second code path in the
  // supervisor itself.
  const entry = process.env.ORDERFLOW_SERVER_ENTRY ?? resolve(ROOT, 'server/src/index.ts');
  return { cmd: process.execPath, args: [tsxCli, entry] };
}

let child: ChildProcess | null = null;
let consecutiveFailures = 0;
let stopping = false;

function start(): void {
  const { cmd, args } = serverCommand();
  const startedAt = Date.now();

  log(`starting server: ${cmd} ${args.join(' ')}`);
  child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ORDERFLOW_SUPERVISED: '1' },
  });

  const pipe = (stream: NodeJS.ReadableStream | null, tag: string) => {
    if (!stream) return;
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) {
        if (!l.trim()) continue;
        process.stdout.write(`${l}\n`);
        try {
          mkdirSync(LOG_DIR, { recursive: true });
          appendFileSync(LOG_FILE, `${l}\n`, 'utf8');
        } catch { /* ignore */ }
      }
      void tag;
    });
  };
  pipe(child.stdout, 'out');
  pipe(child.stderr, 'err');

  child.on('exit', (code, signal) => {
    const ranMs = Date.now() - startedAt;
    child = null;
    if (stopping) {
      log(`server exited during shutdown (code=${code} signal=${signal})`);
      process.exit(0);
    }

    if (ranMs >= HEALTHY_AFTER_MS) {
      consecutiveFailures = 0;
      log(`server ran for ${Math.round(ranMs / 1000)}s then exited (code=${code} signal=${signal}) — healthy run, restarting immediately`);
    } else {
      consecutiveFailures++;
      log(
        `server died after ${ranMs}ms (code=${code} signal=${signal}) — crash #${consecutiveFailures}`,
      );
    }

    const wait = backoffMs(consecutiveFailures);
    if (wait > 0) {
      log(`waiting ${Math.round(wait / 1000)}s before restart (crash-loop backoff)`);
    }
    setTimeout(start, wait);
  });

  child.on('error', (err) => {
    log(`failed to spawn server: ${err.message}`);
    consecutiveFailures++;
    setTimeout(start, backoffMs(consecutiveFailures));
  });
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log(`received ${signal}; stopping the server`);
  if (child) {
    child.kill(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    // Give it a moment to exit cleanly, then stop waiting.
    setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* gone */ } }, 5000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log('supervisor up. Press Ctrl+C to stop.');
log(`log file: ${LOG_FILE} (rotates at ${MAX_LOG_BYTES / 1024 / 1024}MB, keeps ${KEEP_LOGS})`);
start();