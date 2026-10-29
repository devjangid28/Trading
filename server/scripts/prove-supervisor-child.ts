/**
 * Stub server for the Fix 2 acceptance proof.
 *
 * It does the four things the proof needs to observe, and nothing else:
 *   1. acquires the single-instance lock (so the refusal can be demonstrated)
 *   2. records a run row
 *   3. writes a heartbeat every second (so the ledger has a "resumes" signal)
 *   4. on start, notices the hole since the last heartbeat, records it as a
 *      process gap, and "backfills" by touching the open signals
 *
 * When the supervisor kills it, step 4 on the next boot is the real behaviour:
 * detect downtime, record the gap, backfill, carry on.
 */
import { acquireLock, LOCK_PATH } from '../src/runtime/lock.js';
import {
  loadBans, recordRunStart, recordRunEnd, saveBan, clearBan, processGaps, recordProcessGap,
} from '../src/ledger/store.js';

const PORT = Number(process.env.PORT ?? 8799);

const lock = acquireLock({ port: PORT, label: 'proof-stub' });
if (!lock.ok) {
  console.error(`PROOF-STUB REFUSING TO START: ${lock.reason}`);
  process.exit(11);
}

const runId = recordRunStart(process.pid);
console.log(`PROOF-STUB up pid=${process.pid} run=${runId} lock=${LOCK_PATH}`);

/**
 * The last heartbeat, kept in `host_bans` as a scratch key. Reusing an existing
 * table keeps this a migration rather than a new schema.
 */
const HB = '__proof_heartbeat__';
const readHb = (): number => loadBans().find((b) => b.host === HB)?.updatedAt ?? 0;

const last = readHb();
const now = Date.now();
if (last > 0 && now - last > 2_000) {
  const minutes = Math.max(1, Math.round((now - last) / 60_000));
  recordProcessGap(last, now, minutes, 'crash-or-restart');
  console.log(`PROOF-STUB detected ${Math.round((now - last) / 1000)}s of downtime; gap row written`);
}

let beats = 0;
const beat = setInterval(() => {
  beats++;
  saveBan({
    host: HB, bannedUntil: 0, source: 'escalating', raw: 'heartbeat',
    strikes: beats, updatedAt: Date.now(),
  });
  console.log(`PROOF-STUB beat ${beats} pid=${process.pid}`);
}, 1000);

function bye(reason: string): void {
  clearInterval(beat);
  clearHb();
  recordRunEnd(runId, reason);
  lock.release?.();
  process.exit(0);
}
function clearHb(): void {
  try { clearBan(HB); } catch { /* ignore */ }
}

process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGINT', () => bye('SIGINT'));

console.log(`PROOF-STUB gaps so far: ${JSON.stringify(processGaps(3))}`);