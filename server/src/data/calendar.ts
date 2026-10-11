import type { EventCalendar, MarketEvent } from '../../../shared/types';
import { MACRO } from '../config.js';
import { cached } from '../lib/cache.js';
import { etToUtc, formatEt, formatIst, isUsDst } from '../lib/etTime.js';
import { DERIVATIVES_DERIBIT_SETTLE_UTC_H, FUNDING_TIMES_UTC } from './constants.js';

/**
 * Phase 5 — the event calendar and the blackout veto.
 *
 * This is the one feature with a hard deadline, and CPI arrives first: the
 * 14 Oct 2026 release at 08:30 ET is 18:00 IST, four days from 10 Oct. An A/B
 * pick printed 30 minutes before it is a real failure, not a cosmetic gap.
 *
 * TIMEZONE CORRECTNESS. Every US release time is quoted in America/New_York
 * wall-clock, and it is converted to UTC with the real IANA zone (see
 * lib/etTime.ts), never a fixed offset. The offset changes on 1 Nov 2026:
 *
 *     before 1 Nov  (EDT, UTC-4)  08:30 ET -> 12:30 UTC -> 18:00 IST
 *     from 1 Nov    (EST, UTC-5)  08:30 ET -> 13:30 UTC -> 19:00 IST
 *
 * A hard-coded +4 would place every November and December release an hour
 * early, ending the blackout while the print is still live. That is the
 * specific bug this module is structured to make impossible.
 *
 * India has no daylight saving, so IST is a fixed +05:30 and that conversion
 * is exact year-round.
 *
 * SOURCES, honestly labelled:
 *   - FOMC dates are [V] from federalreserve.gov and hard-coded below.
 *   - CPI/NFP dates come from server/data/macro-events.json, transcribed by
 *     hand from the BLS schedule. BLS renders its table in JavaScript, so it
 *     cannot be scraped; a second-hand date is recorded as "user-provided".
 *   - PCE dates are [V] scraped live from bea.gov/news/schedule. That page is
 *     plain server-rendered HTML and does parse. Cross-checked on 10 Oct
 *     2026: the research's 29 Oct / 25 Nov / 23 Dec all appear verbatim on
 *     the BEA page, so PCE did NOT move to the dates one secondary source
 *     claimed.
 *   - RBI MPC dates remain [?] and are not invented.
 */

const HOUR = 3600_000;
const MINUTE = 60_000;

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const HARDCODED: MarketEvent[] = [
  {
    id: 'fomc-2026-10-27',
    kind: 'FOMC',
    title: 'FOMC statement',
    // 27 Oct 2026, 14:00 ET. Still EDT, so 18:00 UTC = 23:30 IST.
    t: etToUtc(2026, 10, 27, 14, 0),
    importance: 1,
    source: 'hardcoded-verified',
    detail: 'Verified from federalreserve.gov FOMC calendar. October 2026 is still EDT (UTC-4): 18:00 UTC / 23:30 IST.',
    blackout: true,
  },
  {
    id: 'fomc-pc-2026-10-27',
    kind: 'FOMC',
    title: 'FOMC press conference',
    t: etToUtc(2026, 10, 27, 14, 0) + 30 * MINUTE,
    importance: 1,
    source: 'hardcoded-verified',
    detail: 'Statement +30 minutes.',
    blackout: true,
  },
  {
    id: 'fomc-2026-12-09',
    kind: 'FOMC',
    title: 'FOMC statement (8-9 Dec)',
    // 9 Dec 2026, 14:00 ET. Now EST, so 19:00 UTC.
    t: etToUtc(2026, 12, 9, 14, 0),
    importance: 1,
    source: 'hardcoded-verified',
    detail: '8-9 Dec 2026 meeting; statement on the 9th. December is EST (UTC-5): 19:00 UTC / 00:30 IST.',
    blackout: true,
  },
  {
    id: 'fomc-2027-01-27',
    kind: 'FOMC',
    title: 'FOMC statement (26-27 Jan 2027)',
    t: etToUtc(2027, 1, 27, 14, 0),
    importance: 1,
    source: 'hardcoded-verified',
    detail: 'January 2027 meeting.',
    blackout: true,
  },
];

/**
 * BLS release dates: hand-transcribed, because BLS cannot be scraped.
 *
 * Confirmed on 10 Oct 2026 that the served HTML has no schedule table — the
 * page builds it in JavaScript and blocks generic browser User-Agents. So
 * this file is the only honest route, and its dates are attributed as
 * user-provided rather than passed off as machine-verified.
 *
 * The old code defaulted a missing `timeUtc` to a hard-coded "12:30Z", which
 * is an EDT-only value and is wrong for every post-DST release. Times are now
 * declared in ET and converted properly.
 */
async function userEvents(): Promise<{ events: MarketEvent[]; count: number; note: string }> {
  return cached('calendar:user', 60_000, async () => {
    try {
      const { readFileSync, existsSync } = await import('node:fs');
      const { dirname: d, resolve: r } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const here = d(fileURLToPath(import.meta.url));
      const path = r(here, '../../data/macro-events.json');
      if (!existsSync(path)) {
        return {
          events: [],
          count: 0,
          note: 'server/data/macro-events.json is missing. CPI/NFP dates must be added by hand.',
        };
      }
      const json = JSON.parse(readFileSync(path, 'utf8')) as {
        events?: {
          date: string;
          timeEt?: string;
          kind: string;
          title?: string;
          blackout?: boolean;
          source?: string;
        }[];
      };

      const events: MarketEvent[] = (json.events ?? [])
        .map((e, i) => {
          const [y, m, d] = e.date.split('-').map(Number);
          const [hh, mm] = (e.timeEt ?? '08:30').split(':').map(Number);
          if (!y || !m || !d) return null;
          // Convert ET -> UTC with the real zone, so DST is respected.
          const t = etToUtc(y, m, d, hh, mm);
          const dst = isUsDst(t);
          return {
            id: `bls-${i}-${e.kind}-${e.date}`,
            kind: e.kind as MarketEvent['kind'],
            title: e.title ?? e.kind,
            t,
            importance: (e.kind === 'CPI' || e.kind === 'NFP' || e.kind === 'PCE' || e.kind === 'FOMC' ? 1 : 2) as 1 | 2 | 3,
            // Attributed as user-provided, not "verified", because a human
            // transcribed it from a page we cannot re-check ourselves.
            source: 'user-provided' as MarketEvent['source'],
            detail:
              (e.source ? `${e.source} ` : '') +
              `${e.timeEt ?? '08:30'} ET = ${formatEt(t)} = ${formatIst(t)} (${dst ? 'EDT' : 'EST'}).`,
            blackout: e.blackout ?? true,
          } as MarketEvent;
        })
        .filter(Boolean) as MarketEvent[];

      return {
        events,
        count: events.length,
        note:
          events.length > 0
            ? `${events.length} date(s) from server/data/macro-events.json (hand-entered; BLS cannot be scraped).`
            : 'server/data/macro-events.json has no events. Add CPI/NFP dates by hand from https://www.bls.gov/schedule/2026/home.htm in a browser.',
      };
    } catch {
      return {
        events: [],
        count: 0,
        note: 'Could not read server/data/macro-events.json. CPI/NFP blackouts are inactive.',
      };
    }
  });
}

/**
 * PCE from bea.gov/news/schedule.
 *
 * Verified scrapable on 10 Oct 2026: server-rendered HTML, schedule lives in
 * a plain <table>. "Personal Income and Outlays" is the BEA title for the PCE
 * report. Parsed rather than hard-coded so the schedule tracks BEA itself,
 * but still gated: if the page shape changes we fall back to nothing rather
 * than guess a date.
 */
async function pceEvents(): Promise<{ events: MarketEvent[]; ok: boolean; reason: string }> {
  return cached('calendar:pce', 6 * HOUR, async () => {
    try {
      const res = await fetch('https://www.bea.gov/news/schedule', {
        headers: { 'User-Agent': 'orderflow-calendar/1.0 (+calendar)' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { events: [], ok: false, reason: `bea.gov HTTP ${res.status}` };
      const html = await res.text();

      const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      const yearRe = /Year\s+(\d{4})\s+Release/gi;
      const seen = new Set<string>();
      const out: MarketEvent[] = [];
      let m: RegExpExecArray | null;
      while ((m = rowRe.exec(html))) {
        const row = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!/Personal Income and Outlays/i.test(row)) continue;

        // The table rows carry no year; it lives in the "Year NNNN Release"
        // section heading that precedes them. Take the most recent heading
        // above this row so a year rollover (December listed under the next
        // year) is handled correctly instead of silently mis-dated.
        const before = html.slice(0, m.index);
        let year: number | null = null;
        let ym: RegExpExecArray | null;
        while ((ym = yearRe.exec(before))) year = Number(ym[1]);
        yearRe.lastIndex = 0;
        if (year === null) year = new Date().getUTCFullYear();

        // "October 29 8:30 AM News Personal Income and Outlays, September 2026"
        const dm = /([A-Z][a-z]+)\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(row);
        if (!dm) continue;
        const dataMatch = /Personal Income and Outlays,?\s*(.*?)$/i.exec(row);

        const month = MONTHS[dm[1].toLowerCase()];
        if (month === undefined) continue;
        let hour = Number(dm[3]);
        const pm = dm[5].toUpperCase() === 'PM';
        if (pm && hour !== 12) hour += 12;
        if (!pm && hour === 12) hour = 0;

        // BEA quotes release times in ET; convert with the real zone so the
        // post-1-Nov dates are not an hour early.
        const t = etToUtc(year, month, Number(dm[2]), hour, Number(dm[4]));
        const id = `pce-${year}-${month}-${dm[2]}`;
        if (seen.has(id)) continue;
        seen.add(id);

        out.push({
          id,
          kind: 'PCE',
          title: `PCE (${(dataMatch?.[1] ?? '').trim() || 'Personal Income and Outlays'})`,
          t,
          importance: 1,
          source: 'bea-scraped',
          detail: `Scraped from bea.gov/news/schedule. ${formatEt(t)} = ${formatIst(t)}.`,
          blackout: true,
        });
      }
      if (out.length === 0) {
        return { events: [], ok: false, reason: 'bea.gov reachable but no "Personal Income and Outlays" rows found.' };
      }
      return { events: out, ok: true, reason: `${out.length} PCE date(s) scraped from bea.gov/news/schedule.` };
    } catch (err) {
      return { events: [], ok: false, reason: `bea.gov fetch failed: ${(err as Error).message}` };
    }
  });
}

/** Deribit expiries settle 08:00 UTC on the last Friday of the month. */
export function deribitExpiries(from: number, months = 4): MarketEvent[] {
  const out: MarketEvent[] = [];
  const d = new Date(from);
  for (let i = 0; i < months; i++) {
    const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i + 1, 0));
    const lastFriday = new Date(monthStart);
    while (lastFriday.getUTCDay() !== 5) lastFriday.setUTCDate(lastFriday.getUTCDate() - 1);
    const t = Date.UTC(
      lastFriday.getUTCFullYear(), lastFriday.getUTCMonth(), lastFriday.getUTCDate(),
      DERIVATIVES_DERIBIT_SETTLE_UTC_H, 0, 0,
    );
    out.push({
      id: `deribit-${t}`,
      kind: 'DERIBIT_EXPIRY',
      title: 'Deribit options expiry',
      t,
      importance: 2,
      source: 'hardcoded-verified',
      detail: 'Last Friday, settles 08:00 UTC = 13:30 IST. [V]',
      blackout: false,
    });
  }
  return out;
}

/** Funding happens at 00:00 / 08:00 / 16:00 UTC = 05:30 / 13:30 / 21:30 IST. */
export function fundingEvents(from: number, hours = 48): MarketEvent[] {
  const out: MarketEvent[] = [];
  const start = Math.floor(from / HOUR) * HOUR;
  for (let t = start; t < from + hours * HOUR; t += HOUR) {
    if (!FUNDING_TIMES_UTC.includes(new Date(t).getUTCHours() as 0 | 8 | 16)) continue;
    out.push({
      id: `funding-${t}`,
      kind: 'FUNDING',
      title: `Funding (${String(new Date(t).getUTCHours()).padStart(2, '0')}:00 UTC)`,
      t,
      importance: 2,
      source: 'hardcoded-verified',
      detail: 'Binance funding times. [V]',
      blackout: false,
    });
  }
  return out;
}

export interface CalendarResult extends EventCalendar {
  /** Next tier-1 event with both ET and IST renderings, for the header countdown. */
  nextBlackout: {
    id: string;
    kind: string;
    title: string;
    t: string;
    ist: string;
    et: string;
    minutesUntil: number;
  } | null;
}

export async function eventCalendar(now = Date.now()): Promise<CalendarResult> {
  const events: MarketEvent[] = [...HARDCODED];
  const sources: EventCalendar['sources'] = [
    { name: 'FOMC (federalreserve.gov, verified)', ok: true, reason: '', asOf: now },
  ];

  const user = await userEvents().catch(() => ({
    events: [] as MarketEvent[], count: 0, note: 'macro-events.json read failed.',
  }));
  events.push(...user.events);
  sources.push({ name: 'BLS CPI/NFP (hand-entered)', ok: user.count > 0, reason: user.note, asOf: now });

  const pce = await pceEvents().catch(() => ({ events: [] as MarketEvent[], ok: false, reason: 'PCE fetch threw.' }));
  events.push(...pce.events);
  sources.push({ name: 'PCE (bea.gov/news/schedule, scraped)', ok: pce.ok, reason: pce.reason, asOf: now });

  events.push(...deribitExpiries(now));
  events.push(...fundingEvents(now));

  events.sort((a, b) => a.t - b.t);

  // The nearest tier-1 blackout, rendered in both zones. This is what the
  // header countdown shows, so CPI appears before FOMC now that it is closer.
  const upcoming = events.filter((e) => e.importance === 1 && e.blackout && e.t > now)[0] ?? null;
  const nextBlackout = upcoming
    ? {
        id: upcoming.id,
        kind: upcoming.kind,
        title: upcoming.title,
        t: new Date(upcoming.t).toISOString(),
        ist: formatIst(upcoming.t),
        et: formatEt(upcoming.t),
        minutesUntil: Math.round((upcoming.t - now) / MINUTE),
      }
    : null;

  return { updatedAt: now, events, sources, nextBlackout };
}

/** Is `now` inside any tier-1/tier-2 blackout window? */
export function inBlackout(events: MarketEvent[], now: number): boolean {
  const windowMs = MACRO.TIER1_BLACKOUT.includes('FOMC') ? 30 * MINUTE : 30 * MINUTE;
  return events.some((e) => e.blackout && Math.abs(now - e.t) <= windowMs);
}

export function blackoutReason(events: MarketEvent[], now: number): string | null {
  const windowMs = 30 * MINUTE;
  const hit = events.find((e) => e.blackout && Math.abs(now - e.t) <= windowMs);
  if (!hit) return null;
  const mins = Math.round((hit.t - now) / MINUTE);
  return mins >= 0
    ? `${hit.title} in ${mins}m — blackout`
    : `${hit.title} ${Math.abs(mins)}m ago — blackout`;
}

/** Next tier-1 event, for the header countdown. */
export function nextTier1(events: MarketEvent[], now: number): MarketEvent | null {
  return events.find((e) => e.importance === 1 && e.t > now) ?? null;
}

export { MACRO };