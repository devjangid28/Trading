/** India Standard Time. IST is UTC+05:30 with no DST, so a fixed offset is correct. */
export const IST_OFFSET_MIN = 330;

const IST_TZ = 'Asia/Kolkata';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;

export function nowMs(): number {
  return Date.now();
}

/** Current IST time as a UTC-shifted Date, so `.getHours()` reads IST. */
export function istParts(at: number = Date.now()) {
  const d = new Date(at + IST_OFFSET_MIN * MINUTE);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    /** 0 = Sunday */
    dow: d.getUTCDay(),
  };
}

/** "09:15" -> minutes since midnight IST */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function istMinutesNow(at: number = Date.now()): number {
  const p = istParts(at);
  return p.hours * 60 + p.minutes;
}

/** IST midnight of the day containing `at`, as a UTC epoch ms. */
export function istDayStart(at: number = Date.now()): number {
  const p = istParts(at);
  return Date.UTC(p.year, p.month - 1, p.day) - IST_OFFSET_MIN * MINUTE;
}

/** Format an epoch as "DD-Mon-YYYY" — the exact format the NSE holiday API uses. */
export function istDateKey(at: number = Date.now()): string {
  const p = istParts(at);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const dd = String(p.day).padStart(2, '0');
  return `${dd}-${months[p.month - 1]}-${p.year}`;
}

export function parseIstDateKey(key: string): number | null {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(key.trim());
  if (!m) return null;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const mi = months.indexOf(m[2].toLowerCase());
  if (mi < 0) return null;
  return Date.UTC(Number(m[3]), mi, Number(m[1])) - IST_OFFSET_MIN * MINUTE;
}

export function formatIst(at: number): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

export function formatIstFull(at: number): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TZ,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

export function ageLabel(publishedAt: number, now: number = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - publishedAt) / MINUTE));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

export interface SessionWindow {
  open: number;
  close: number;
}

export interface SegmentSessions {
  equity: SessionWindow;
  fnf: SessionWindow;
  currency: SessionWindow;
  commodity: SessionWindow;
}

/**
 * Current NSE/NFO session timings. Equity derivatives moved to a 15:40 close
 * under circular NSE/FAOP/74467 (effective 3 Aug 2026); equity cash keeps a
 * 15:30 normal close with a separate 15:40-16:00 closing auction.
 */
export const SESSIONS: SegmentSessions = {
  equity: { open: hhmmToMinutes('09:15'), close: hhmmToMinutes('15:30') },
  fnf: { open: hhmmToMinutes('09:15'), close: hhmmToMinutes('15:40') },
  currency: { open: hhmmToMinutes('09:00'), close: hhmmToMinutes('17:00') },
  commodity: { open: hhmmToMinutes('09:00'), close: hhmmToMinutes('23:30') },
};

export type SegmentKey = keyof SegmentSessions;

export function sessionState(segment: SegmentKey, at: number = Date.now()): {
  state: 'pre' | 'open' | 'closed' | 'weekend';
  minsToChange: number;
} {
  const p = istParts(at);
  const day = p.dow;
  const win = SESSIONS[segment];
  const mins = p.hours * 60 + p.minutes;

  if (day === 0) return { state: 'weekend', minsToChange: 0 };
  const target = mins < win.open ? win.open : mins < win.close ? win.close : win.open + 24 * 60;
  return {
    state: mins < win.open ? 'pre' : mins < win.close ? 'open' : 'closed',
    minsToChange: target - mins,
  };
}

/** Minutes since the IST midnight that starts the current UTC day, for candle bucketing. */
export function utcDayKey(t: number): number {
  return Math.floor(t / (24 * HOUR));
}
