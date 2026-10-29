/**
 * FIX 3 — fixture replay.
 *
 * The rule this file exists to enforce: in mock mode the app must run the SAME
 * parsers, the SAME engine and the SAME SSE hub as production, with only the
 * bytes on the wire replaced. That is why the seam is the transport inside
 * `lib/http.ts` rather than a parallel mock data layer — a parallel layer would
 * be a second implementation, and UI work built against a second implementation
 * proves nothing about the first.
 *
 * Anything not in the fixture set is refused loudly rather than silently
 * returning empty, because an empty board and a broken board look identical in
 * a screenshot and only one of them is a bug.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = process.env.ORDERFLOW_FIXTURES ?? resolve(HERE, '../../../fixtures');

export interface FixtureEntry {
  /** Stable key used to look the response up. */
  key: string;
  /** The exact URL that was requested when this was recorded. */
  url: string;
  host: string;
  path: string;
  status: number;
  /** Response headers worth replaying (weight, retry-after, content-type). */
  headers: Record<string, string>;
  body: string;
  capturedAt: string;
  bytes: number;
}

export interface FixtureManifest {
  version: 1;
  capturedAt: string;
  generator: string;
  note: string;
  entries: FixtureEntry[];
}

export class MockNetworkBlockedError extends Error {
  /**
   * Marks the failure as terminal for the HTTP layer.
   *
   * Without this the request would be retried with backoff — three attempts
   * against a URL that is refused by design. Caught by the unit test asserting
   * exactly three refusals for three URLs and getting nine.
   */
  readonly terminal = true;

  constructor(readonly url: string) {
    super(
      `MOCK MODE: outbound request to ${url} was blocked. No fixture matches it. ` +
      'Either record it (`npm run record-fixtures`) or the code path is reaching ' +
      'for data the mock set does not contain — which is itself the bug this catches.',
    );
    this.name = 'MockNetworkBlockedError';
  }
}

/**
 * Canonical key for a URL.
 *
 * Query parameters are sorted so the same request written in a different order
 * still hits the same fixture, and volatile parameters are dropped from the
 * *fallback* key because a `limit` or `startTime` change is not a different
 * endpoint, just a different window over the same data.
 */
export function fixtureKey(url: string): string {
  const u = new URL(url);
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const qs = params.map(([k, v]) => `${k}=${v}`).join('&');
  return `${u.host}${u.pathname}${qs ? `?${qs}` : ''}`;
}

export function fixtureKeyLoose(url: string): string {
  const u = new URL(url);
  // `limit` and `startTime` select a window over one series, not an endpoint.
  const params = [...u.searchParams.entries()]
    .filter(([k]) => k !== 'limit' && k !== 'startTime' && k !== 'period')
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = params.map(([k, v]) => `${k}=${v}`).join('&');
  return `${u.host}${u.pathname}${qs ? `?${qs}` : ''}`;
}

export interface ReplayIndex {
  exact: Map<string, FixtureEntry>;
  loose: Map<string, FixtureEntry>;
  entries: FixtureEntry[];
  capturedAt: string | null;
}

export function loadFixtures(dir = FIXTURES_DIR): ReplayIndex {
  const manifestPath = join(dir, 'manifest.json');
  const exact = new Map<string, FixtureEntry>();
  const loose = new Map<string, FixtureEntry>();
  const entries: FixtureEntry[] = [];
  let capturedAt: string | null = null;

  if (!existsSync(manifestPath)) {
    return { exact, loose, entries, capturedAt };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FixtureManifest;
  capturedAt = manifest.capturedAt;

  for (const e of manifest.entries ?? []) {
    entries.push(e);
    exact.set(fixtureKey(e.url), e);
    const lk = fixtureKeyLoose(e.url);
    // First writer wins, so an exact-URL fixture always beats a loose match
    // recorded earlier for the same series.
    if (!loose.has(lk)) loose.set(lk, e);
  }

  return { exact, loose, entries, capturedAt };
}

export function lookup(index: ReplayIndex, url: string): FixtureEntry | null {
  return index.exact.get(fixtureKey(url)) ?? index.loose.get(fixtureKeyLoose(url)) ?? null;
}

/** Bodies-only directory, written alongside the manifest for eyeballing. */
export function saveManifest(index: { entries: FixtureEntry[]; capturedAt: string }, dir = FIXTURES_DIR): void {
  mkdirSync(dir, { recursive: true });
  const manifest: FixtureManifest = {
    version: 1,
    capturedAt: index.capturedAt,
    generator: 'scripts/record-fixtures.ts',
    note:
      'Real responses captured from public endpoints. Each entry records the exact URL, ' +
      'the status, replayable headers and the raw body. Mock mode serves these through the ' +
      'same transport seam production uses, so parsers and the engine are unchanged.',
    entries: index.entries,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

export function fixtureSummary(dir = FIXTURES_DIR): { count: number; bytes: number; capturedAt: string | null } {
  const idx = loadFixtures(dir);
  return {
    count: idx.entries.length,
    bytes: idx.entries.reduce((a, e) => a + e.bytes, 0),
    capturedAt: idx.capturedAt,
  };
}

export function listFixtureHosts(dir = FIXTURES_DIR): string[] {
  return [...new Set(loadFixtures(dir).entries.map((e) => e.host))].sort();
}

export function hasFixtures(dir = FIXTURES_DIR): boolean {
  return existsSync(join(dir, 'manifest.json')) && readdirSync(dir).length > 1;
}