import type { SectorFlow } from '../../shared/types';

/**
 * In-memory history of each sector's average change, sampled once per scan.
 *
 * The engine only reports the cumulative `avgChange` per sector at each poll
 * (no intraday series), so the home sector-flow plot is stitched from these
 * polls — one sample per scan tick. The module keeps it per-session and prunes
 * older than WINDOW_MIN, so a freshly opened terminal grows the line honestly
 * rather than pretending to a full day it never observed.
 */
export interface SectorSample {
  t: number;
  value: number;
}

export const WINDOW_MIN = 375; // 6h15m — mirrors the reference's 09:15→15:30 session

interface Snapshot {
  /** sector name -> samples, oldest first. */
  bySector: Map<string, SectorSample[]>;
  /** The scan this history reflects (drives dedup). */
  scanUpdatedAt: number;
  /** First sample time in the window. */
  windowStart: number;
}

let snapshot: Snapshot = { bySector: new Map(), scanUpdatedAt: 0, windowStart: Date.now() };

/** Push one scan's sector averages; deduplicated by `updatedAt`. Returns a fresh reference. */
export function pushSectorScan(sectors: SectorFlow[], updatedAt: number): Snapshot {
  if (updatedAt === snapshot.scanUpdatedAt) return snapshot;
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return snapshot;


  const horizon = updatedAt - WINDOW_MIN * 60_000;
  const bySector = new Map<string, SectorSample[]>();

  for (const s of sectors) {
    const prev = snapshot.bySector.get(s.sector) ?? [];
    const next = prev.filter((p) => p.t >= horizon && p.t < updatedAt);
    next.push({ t: updatedAt, value: s.avgChange });
    bySector.set(s.sector, next);
  }

  snapshot = {
    bySector,
    scanUpdatedAt: updatedAt,
    windowStart: updatedAt - WINDOW_MIN * 60_000,
  };
  return snapshot;
}

/** Read the current history without mutating it. */
export function readSectorHistory(): Snapshot {
  return snapshot;
}

/** Resolve a sector's samples to x/y points inside a 0..375 x, 0..100 y box. */
export function sectorPoints(
  samples: SectorSample[],
  scaleMax: number,
  width = 375,
): { x: number; y: number }[] {
  if (scaleMax <= 0 || samples.length === 0) return [];
  const xFor = (idx: number) => (width * idx) / Math.max(1, WINDOW_MIN - 1);
  const yFor = (v: number) => 12 + (100 - 24) * (1 - Math.max(-scaleMax, Math.min(scaleMax, v)) / scaleMax / 2 - 0.5);
  return samples.map((s, i) => ({ x: xFor(i), y: yFor(s.value) }));
}