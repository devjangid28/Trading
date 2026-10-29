import { setTransport, type Transport } from '../lib/http.js';
import {
  lookup, loadFixtures, MockNetworkBlockedError, type FixtureEntry, type ReplayIndex,
} from './fixtures.js';

/**
 * Fix 3 — the replay transport.
 *
 * Installed in place of the real one, so `fetchText` / `fetchJson` /
 * `fetchJsonSafe` and every provider above them are untouched. A request that
 * has a fixture is served from disk with its captured status and headers; a
 * request without one throws `MockNetworkBlockedError`.
 *
 * The throw is the important half. Mock mode that quietly returns `[]` for an
 * uncaptured endpoint produces a UI that looks empty rather than broken, and
 * the bug gets built into a screen instead of being caught here.
 */

export interface MockState {
  active: boolean;
  /** Every URL served, in order. Asserted against in the boot test. */
  served: string[];
  /** Every URL refused because no fixture matched. */
  blocked: string[];
  index: ReplayIndex;
}

let state: MockState | null = null;

/** Is mock mode on? Set by `ORDERFLOW_MOCK=1` or by `installMockTransport()`. */
export function mockRequested(): boolean {
  return process.env.ORDERFLOW_MOCK === '1';
}

export function isMockActive(): boolean {
  return state !== null;
}

export function mockState(): MockState {
  if (!state) throw new Error('mock mode is not active');
  return state;
}

function toResponse(entry: FixtureEntry): Response {
  return new Response(entry.body, {
    status: entry.status,
    headers: {
      // Always advertise JSON: every provider in this app parses JSON.
      'content-type': entry.headers['content-type'] ?? 'application/json',
      // Replayed weight header, so the proactive budget behaves as it did live
      // rather than silently sitting at "unknown".
      ...(entry.headers['x-mbx-used-weight-1m']
        ? { 'x-mbx-used-weight-1m': entry.headers['x-mbx-used-weight-1m'] }
        : {}),
      'x-orderflow-fixture': entry.key,
    },
  });
}

export function installMockTransport(dir?: string): MockState {
  const index = loadFixtures(dir);
  state = { active: true, served: [], blocked: [], index };

  const transport: Transport = async (url) => {
    const hit = lookup(index, url);
    if (!hit) {
      state!.blocked.push(url);
      throw new MockNetworkBlockedError(url);
    }
    state!.served.push(url);
    // A small delay so mock mode has realistic latency and the UI's
    // pending/skeleton states are actually exercised during development.
    await new Promise((r) => setTimeout(r, 4));
    return toResponse(hit);
  };

  setTransport(transport);
  return state;
}

export function uninstallMockTransport(): void {
  setTransport(null);
  state = null;
}

/** Reset the counters without changing which fixtures are loaded. */
export function resetMockCounters(): void {
  if (state) { state.served = []; state.blocked = []; }
}

export { MockNetworkBlockedError };