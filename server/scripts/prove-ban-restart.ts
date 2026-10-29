/**
 * FIX 1 PROOF — child process, used to prove restart safety.
 *
 * Runs in a SEPARATE node process on purpose. The claim under test is that a
 * restart cannot re-hit a banned host, and that claim is only meaningful if
 * nothing is carried over in memory. So this process shares nothing with the
 * parent except the SQLite file and the mock HTTP server's address.
 *
 * It performs exactly the real server's boot sequence:
 *   1. bootRateLimiter() — install SQLite persistence and load persisted bans
 *   2. ask the registry whether the host is usable
 *   3. attempt a request anyway, and report what happened
 *
 * The parent asserts the mock server's request counter did not move.
 */
import { bans } from '../src/lib/http.js';
import { bootRateLimiter } from '../src/lib/rateLimitBoot.js';

const HOST = process.env.PROOF_HOST ?? 'data-api.binance.vision';
const PORT = process.env.PROOF_PORT ?? '0';
const OUT = process.env.PROOF_OUT ?? '';

const restored = bootRateLimiter();
const banned = bans.isBanned(HOST);
const remaining = bans.remainingMs(HOST);

let error = '';
try {
  // A real request attempt. The registry check runs before the socket opens,
  // so if the ban was restored this throws without a packet leaving the box.
  const { fetchText, setTransport } = await import('../src/lib/http.js');
  setTransport(async (url, init) => {
    const u = new URL(url);
    return fetch(`http://127.0.0.1:${PORT}${u.pathname}${u.search}`, init);
  });
  await fetchText(`https://${HOST}/api/v3/time`, { retries: 2 });
} catch (e) {
  error = `${(e as Error).name}: ${(e as Error).message}`;
}

const out = { restored, banned, remainingMs: remaining, attempted: true, error };
if (OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT, JSON.stringify(out, null, 2));
}
process.stdout.write(`  [restart] ${JSON.stringify(out)}\n`);