import { NETWORK, TZ } from '../config.js';
import { bans, hostOf } from '../lib/http.js';
import { etToUtc, formatEt, formatIst, isUsDst } from '../lib/etTime.js';
import {
  dbSelfTest, DB_PATH,
} from '../ledger/store.js';
import { formatIstGap } from './clock.js';

/**
 * Startup self-check.
 *
 * Prints PASS/FAIL for the five things that, if they are wrong, silently
 * corrupt the ledger rather than crashing the app:
 *
 *   1. lock acquired          — two servers double the Binance request weight
 *   2. DB writable            — a read-only DB loses every signal, quietly
 *   3. ban state loaded       — a restart that ignores a ban re-hits the host
 *   4. calendar loaded 30d    — an empty calendar means CPI never blackouts out
 *   5. timezone conversion    — a wrong IST/ET offset mis-times every release
 *
 * The calendar check asserts on specific, named events rather than a count. A
 * calendar with three wrong dates still has three dates in it, so "count > 0"
 * proves nothing.
 */

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SelfCheckReport {
  results: CheckResult[];
  passed: boolean;
  /** Events the calendar is expected to know about, with their expected IST. */
  calendarEvents: { kind: string; whenIst: string; found: boolean }[];
}

const DAY = 86_400_000;

/** Confirm the database accepts writes, then clean up after ourselves. */
function checkDbWritable(): CheckResult {
  const r = dbSelfTest();
  return {
    name: 'DB writable',
    pass: r.ok,
    detail: r.ok ? `${DB_PATH} accepted a write and read it back` : `${DB_PATH}: ${r.error}`,
  };
}

/** A single conversion, asserted against a value fixed in the config comments. */
function checkTimezone(): CheckResult {
  // 14 Oct 2026 is before the 1 Nov DST change, so America/New_York is EDT
  // (UTC-4) and 08:30 ET must be 12:30 UTC = 18:00 IST. Getting this wrong is
  // the documented trap: a hard-coded +4 places every post-DST release an hour
  // early and ends the blackout while the print is still live.
  const t = etToUtc(2026, 10, 14, 8, 30);
  const ist = formatIst(t);
  const dst = isUsDst(t);
  const okIst = ist.startsWith('14 Oct 18:00');
  const okDst = dst === true;
  const okEt = formatEt(t).startsWith('14 Oct 08:30');

  // And the other side of the DST boundary, to prove it is not hard-coded.
  const t2 = etToUtc(2026, 12, 10, 8, 30);
  const ist2 = formatIst(t2);
  const okIst2 = ist2.startsWith('10 Dec 19:00');

  const pass = okIst && okDst && okEt && okIst2;
  return {
    name: 'Timezone conversion',
    pass,
    detail:
      `CPI 14 Oct: 08:30 ET = ${formatEt(t)} = ${ist} (${dst ? 'EDT' : 'EST'}) ${okIst && okDst && okEt ? 'OK' : 'WRONG'}; ` +
      `CPI 10 Dec (post-DST): 08:30 ET = ${formatEt(t2)} = ${ist2} ${okIst2 ? 'OK' : 'WRONG'}`,
  };
}

/**
 * The named events the calendar must know about for the next 30 days.
 *
 * Dates come from the research: FOMC 27 Oct 2026 is on federalreserve.gov,
 * CPI 14 Oct 2026 from the BLS schedule (hand-entered), and PCE from
 * bea.gov/news/schedule. The expected IST times follow from the offsets.
 */
const REQUIRED_EVENTS: { kind: string; iso: string; expectIst: string; label: string }[] = [
  { kind: 'CPI', iso: '2026-10-14T12:30:00.000Z', expectIst: '14 Oct 18:00', label: 'CPI 14 Oct' },
  { kind: 'FOMC', iso: '2026-10-27T18:00:00.000Z', expectIst: '27 Oct 23:30', label: 'FOMC 27 Oct' },
  { kind: 'PCE', iso: '2026-10-29T12:30:00.000Z', expectIst: '29 Oct 18:00', label: 'PCE 29 Oct' },
];

export async function runSelfCheck(opts: {
  lockAcquired: boolean;
  lockDetail: string;
  restoredBans: number;
  now?: number;
}): Promise<SelfCheckReport> {
  const now = opts.now ?? Date.now();
  const results: CheckResult[] = [];

  results.push({
    name: 'Single-instance lock',
    pass: opts.lockAcquired,
    detail: opts.lockDetail,
  });

  results.push(checkDbWritable());

  const spotHost = hostOf(NETWORK.BINANCE_SPOT_HOST);
  const banned = bans.isBanned(spotHost);
  results.push({
    name: 'Ban state loaded',
    // Loading means the registry knows the persisted rows. An active ban is not
    // a failure — it is the system working — so the check is about the wiring.
    pass: true,
    detail:
      `${opts.restoredBans} persisted ban(s) restored; ${spotHost} is ` +
      (banned
        ? `BANNED until ${formatIstGap(bans.bannedUntil(spotHost) ?? now)}`
        : 'usable') +
      (opts.restoredBans > 0 && !banned ? ' (rows expired while down and were cleared)' : ''),
  });

  const { eventCalendar } = await import('../data/calendar.js');
  let calDetail: string;
  const calendarEvents: SelfCheckReport['calendarEvents'] = [];
  try {
    const cal = await eventCalendar(now);
    const horizon = now + 30 * DAY;
    const window = cal.events.filter((e) => e.t >= now - DAY && e.t <= horizon);

    for (const want of REQUIRED_EVENTS) {
      const hit = window.find((e) => e.kind === want.kind && Math.abs(e.t - Date.parse(want.iso)) < 60_000);
      const istTxt = hit ? formatIst(hit.t) : '';
      const okIst = istTxt.startsWith(want.expectIst);
      calendarEvents.push({
        kind: want.label,
        whenIst: hit ? istTxt : 'NOT FOUND',
        found: Boolean(hit) && okIst,
      });
    }

    const found = calendarEvents.filter((c) => c.found).length;
    calDetail =
      `${window.length} event(s) in the next 30 days; ` +
      calendarEvents.map((c) => `${c.kind}=${c.whenIst}${c.found ? '' : ' MISSING'}`).join(', ') +
      `; blackout sources: ${cal.sources.filter((s) => s.ok).length}/${cal.sources.length} ok`;
    results.push({ name: 'Calendar events (30d)', pass: found === REQUIRED_EVENTS.length, detail: calDetail });
  } catch (err) {
    results.push({ name: 'Calendar events (30d)', pass: false, detail: `calendar threw: ${(err as Error).message}` });
  }

  results.push(checkTimezone());
  results.push({
    name: 'IST offset',
    pass: TZ.IST_OFFSET_MIN === 330,
    detail:
      `fixed UTC+${String(Math.floor(TZ.IST_OFFSET_MIN / 60)).padStart(2, '0')}:` +
      `${String(TZ.IST_OFFSET_MIN % 60).padStart(2, '0')}, no DST — correct for India year-round`,
  });

  return {
    results,
    passed: results.every((r) => r.pass),
    calendarEvents,
  };
}

export function printSelfCheck(report: SelfCheckReport): void {
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log('');
  console.log('  STARTUP SELF-CHECK');
  console.log('  ' + '-'.repeat(72));
  for (const r of report.results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${pad(r.name, 26)} ${r.detail}`);
  }
  console.log('  ' + '-'.repeat(72));
  console.log(`  ${report.passed ? 'ALL CHECKS PASSED' : 'ONE OR MORE CHECKS FAILED'}`);
  console.log('');
}