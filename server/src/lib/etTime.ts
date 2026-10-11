/**
 * ET -> UTC conversion that actually knows about daylight saving.
 *
 * WHY THIS EXISTS: the calendar originally converted with a fixed UTC-4
 * (October is EDT). That is correct for 14 Oct 2026 and wrong for every
 * release after 1 Nov 2026, when the US returns to standard time and 08:30 ET
 * becomes 13:30 UTC rather than 12:30. A fixed offset would silently place
 * every November and December CPI print an hour EARLY, which means a blackout
 * that ends before the release actually happens. That is exactly the failure
 * mode this module exists to prevent.
 *
 * IST stays a fixed +05:30 because India observes no daylight saving.
 */

export const ET_TZ = 'America/New_York';
export const IST_OFFSET_MIN = 330;

/**
 * Offset in ms for a timezone at a given instant, computed from the actual
 * IANA rules via Intl. Returns `localWallClock - utcInstant`.
 */
export function tzOffsetMs(timeZone: string, at: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(at)) parts[p.type] = p.value;

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24, // Intl can emit 24 for midnight under hour12:false
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC epoch.
 *
 * Two passes because the offset depends on the instant, and the instant is
 * what we are solving for. The first guess can be an hour out near a DST
 * boundary; the second pass corrects it.
 */
export function wallClockToUtc(
  timeZone: string,
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = wall - tzOffsetMs(timeZone, wall);
  ts = wall - tzOffsetMs(timeZone, ts);
  return ts;
}

/** Convenience for US releases, which are always quoted in ET. */
export function etToUtc(year: number, month: number, day: number, hour = 8, minute = 30): number {
  return wallClockToUtc(ET_TZ, year, month, day, hour, minute);
}

/** True when the given instant falls inside US daylight saving time. */
export function isUsDst(at: number): boolean {
  return tzOffsetMs(ET_TZ, at) === -4 * 3600_000;
}

const IST_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour12: false,
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** Render an epoch as "14 Oct 18:00 IST". */
export function formatIst(at: number): string {
  return `${IST_FMT.format(at).replace(',', '')} IST`;
}

const ET_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: ET_TZ,
  hour12: false,
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** Render an epoch as "14 Oct 08:30 ET". */
export function formatEt(at: number): string {
  return `${ET_FMT.format(at).replace(',', '')} ET`;
}
