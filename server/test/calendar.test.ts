import { describe, it, expect } from 'vitest';
import { inBlackout, blackoutReason, deribitExpiries, fundingEvents } from '../src/data/calendar.js';
import { etToUtc, isUsDst, formatIst, tzOffsetMs, ET_TZ } from '../src/lib/etTime.js';
import type { MarketEvent } from '../../shared/types.js';
import { VETO } from '../src/config.js';

/**
 * Blackout veto — the FOMC gate.
 *
 * Acceptance criterion 6: "Event countdown correct for 27-28 Oct 2026 FOMC
 * (14:00 ET) in IST, and blackout mode triggers in a simulated clock test."
 *
 * This is the one test where getting it wrong is a real trading loss rather
 * than a display bug: an A/B pick printed 30 minutes before the FOMC statement
 * is a signal into the single largest scheduled volatility event of the month.
 */

const MIN = 60_000;

/** The 27 Oct 2026 FOMC statement. 14:00 ET; October is EDT (UTC-4). */
const FOMC_UTC = Date.UTC(2026, 9, 27, 18, 0, 0);

const fomc: MarketEvent = {
  id: 'fomc-2026-10-27',
  kind: 'FOMC',
  title: 'FOMC statement',
  t: FOMC_UTC,
  importance: 1,
  source: 'hardcoded-verified',
  detail: '14:00 ET',
  blackout: true,
};

describe('FOMC blackout', () => {
  it('the statement time is correct in UTC', () => {
    expect(new Date(FOMC_UTC).toISOString()).toBe('2026-10-27T18:00:00.000Z');
  });

  it('the statement time renders as 23:30 IST', () => {
    // IST is UTC+05:30 with no DST, so 18:00 UTC is exactly 23:30 IST.
    const ist = new Date(FOMC_UTC + 330 * MIN);
    expect(ist.getUTCHours()).toBe(23);
    expect(ist.getUTCMinutes()).toBe(30);
    expect(ist.toISOString().slice(0, 10)).toBe('2026-10-27');
  });

  it('is blacked out 30 minutes before', () => {
    expect(inBlackout([fomc], FOMC_UTC - 30 * MIN)).toBe(true);
  });

  it('is blacked out exactly at the release', () => {
    expect(inBlackout([fomc], FOMC_UTC)).toBe(true);
  });

  it('is blacked out 30 minutes after', () => {
    expect(inBlackout([fomc], FOMC_UTC + 30 * MIN)).toBe(true);
  });

  it('is NOT blacked out 31 minutes before', () => {
    expect(inBlackout([fomc], FOMC_UTC - 31 * MIN)).toBe(false);
  });

  it('is NOT blacked out 31 minutes after', () => {
    expect(inBlackout([fomc], FOMC_UTC + 31 * MIN)).toBe(false);
  });

  it('is not blacked out at any other time of day', () => {
    // Sample a full day. Only the +/-30m window around the statement may fire.
    let fired = 0;
    for (let h = 0; h < 24; h++) {
      const t = Date.UTC(2026, 9, 27, h, 0, 0);
      if (inBlackout([fomc], t)) fired++;
    }
    // At most the hour containing 18:00 UTC, i.e. the 18:00 sample only.
    expect(fired).toBeLessThanOrEqual(1);
  });

  it('gives a readable reason naming the event', () => {
    const reason = blackoutReason([fomc], FOMC_UTC - 20 * MIN);
    expect(reason).toContain('FOMC');
    expect(reason).toContain('20m');
    expect(reason).toContain('blackout');
  });

  it('says "ago" rather than "in" once the event has passed', () => {
    expect(blackoutReason([fomc], FOMC_UTC + 10 * MIN)).toContain('ago');
  });

  it('returns null outside the window', () => {
    expect(blackoutReason([fomc], FOMC_UTC + 5 * 60 * MIN)).toBeNull();
  });

  it('ignores non-blackout events at the same moment', () => {
    const funding: MarketEvent = {
      ...fomc, id: 'funding', kind: 'FUNDING', title: 'Funding', blackout: false, importance: 2,
    };
    expect(inBlackout([funding], FOMC_UTC)).toBe(false);
  });

  it('uses the configured window, not a magic number', () => {
    expect(VETO.MACRO_BLACKOUT_MIN).toBe(30);
    expect(inBlackout([fomc], FOMC_UTC - VETO.MACRO_BLACKOUT_MIN * MIN)).toBe(true);
  });
});

describe('deribit expiries', () => {
  it('lands on the last Friday at 08:00 UTC', () => {
    const events = deribitExpiries(Date.UTC(2026, 9, 10), 3);
    expect(events.length).toBe(3);
    for (const e of events) {
      const d = new Date(e.t);
      expect(d.getUTCDay()).toBe(5); // Friday
      expect(d.getUTCHours()).toBe(8); // 08:00 UTC settle = 13:30 IST
    }
  });

  it('renders 08:00 UTC as 13:30 IST', () => {
    const first = deribitExpiries(Date.UTC(2026, 9, 10), 1)[0];
    const ist = new Date(first.t + 330 * MIN);
    expect(ist.getUTCHours()).toBe(13);
    expect(ist.getUTCMinutes()).toBe(30);
  });

  it('is never a blackout event', () => {
    expect(deribitExpiries(Date.UTC(2026, 9, 10), 3).every((e) => e.blackout === false)).toBe(true);
  });
});

describe('funding events', () => {
  it('emits 00:00, 08:00 and 16:00 UTC only', () => {
    const events = fundingEvents(Date.UTC(2026, 9, 27, 0, 0, 0), 24);
    // Numeric comparator: default .sort() is lexicographic and would order
    // these as [0, 16, 8].
    const hours = [...new Set(events.map((e) => new Date(e.t).getUTCHours()))].sort((a, b) => a - b);
    expect(hours).toEqual([0, 8, 16]);
  });


  it('never triggers a blackout', () => {
    expect(fundingEvents(Date.UTC(2026, 9, 27), 48).every((e) => e.blackout === false)).toBe(true);
  });
});

/**
 * Daylight saving — the bug this file exists to prevent.
 *
 * US DST ends 1 Nov 2026. Every 08:30 ET release after that date is one hour
 * LATER in UTC than the same clock time before it. A fixed UTC-4 offset would
 * produce 12:30 UTC for the 10 Nov CPI, which is 18:00 IST — an hour before
 * the actual release. The blackout would then open while CPI is still live
 * and close before the print, which is the exact failure the veto exists to
 * prevent.
 */

describe('ET to UTC conversion across the 1 Nov 2026 DST change', () => {
  it('treats 14 Oct 2026 as EDT (UTC-4)', () => {
    const t = etToUtc(2026, 10, 14, 8, 30);
    expect(isUsDst(t)).toBe(true);
    expect(tzOffsetMs(ET_TZ, t)).toBe(-4 * 3600_000);
  });

  it('converts 14 Oct 08:30 ET to 12:30 UTC', () => {
    expect(new Date(etToUtc(2026, 10, 14, 8, 30)).toISOString()).toBe('2026-10-14T12:30:00.000Z');
  });

  it('treats 10 Nov 2026 as EST (UTC-5)', () => {
    const t = etToUtc(2026, 11, 10, 8, 30);
    expect(isUsDst(t)).toBe(false);
    expect(tzOffsetMs(ET_TZ, t)).toBe(-5 * 3600_000);
  });

  it('converts 10 Nov 08:30 ET to 13:30 UTC, not 12:30', () => {
    expect(new Date(etToUtc(2026, 11, 10, 8, 30)).toISOString()).toBe('2026-11-10T13:30:00.000Z');
  });

  it('moves every post-DST release one hour later in UTC', () => {
    const before = etToUtc(2026, 10, 14, 8, 30); // October 14
    const after = etToUtc(2026, 11, 10, 8, 30); // November 10
    const wallDelta = Date.UTC(2026, 10, 10, 8, 30) - Date.UTC(2026, 9, 14, 8, 30);
    // Wall-clock gap is 27 days (month index 9 = October, 10 = November); the
    // UTC gap is 27 days PLUS one hour, because the clocks went back an hour
    // in between.
    expect(wallDelta).toBe(27 * 24 * 3600_000);
    expect(after - before).toBe(wallDelta + 3600_000);
  });

  it('renders both releases in IST as the user expects', () => {
    expect(formatIst(etToUtc(2026, 10, 14, 8, 30))).toBe('14 Oct 18:00 IST');
    expect(formatIst(etToUtc(2026, 11, 10, 8, 30))).toBe('10 Nov 19:00 IST');
  });

  it('covers all five hand-entered BLS releases', () => {
    expect(new Date(etToUtc(2026, 10, 14, 8, 30)).toISOString()).toBe('2026-10-14T12:30:00.000Z');
    expect(new Date(etToUtc(2026, 11, 6, 8, 30)).toISOString()).toBe('2026-11-06T13:30:00.000Z');
    expect(new Date(etToUtc(2026, 11, 10, 8, 30)).toISOString()).toBe('2026-11-10T13:30:00.000Z');
    expect(new Date(etToUtc(2026, 12, 4, 8, 30)).toISOString()).toBe('2026-12-04T13:30:00.000Z');
    expect(new Date(etToUtc(2026, 12, 10, 8, 30)).toISOString()).toBe('2026-12-10T13:30:00.000Z');
  });

  it('leaves India on a fixed offset, since it has no DST', () => {
    // October and December must differ by exactly the wall-clock gap in IST.
    const oct = formatIst(etToUtc(2026, 10, 14, 8, 30));
    const dec = formatIst(etToUtc(2026, 12, 10, 8, 30));
    expect(oct).toContain('18:00 IST');
    expect(dec).toContain('19:00 IST');
  });
});

/**
 * CPI blackout — the first live exercise of the veto, four days out.
 *
 * CPI was the strongest measured 1h driver of BTC in the 2026 research, so
 * this is the release where a wrong window costs the most. 14 Oct 2026,
 * 08:30 ET = 12:30 UTC = 18:00 IST.
 */
describe('CPI blackout on 14 Oct 2026', () => {
  const CPI_UTC = etToUtc(2026, 10, 14, 8, 30);

  const cpi: MarketEvent = {
    id: 'bls-cpi-2026-10-14',
    kind: 'CPI',
    title: 'US CPI (September data)',
    t: CPI_UTC,
    importance: 1,
    source: 'user-provided',
    detail: '08:30 ET',
    blackout: true,
  };

  it('resolves to 12:30 UTC / 18:00 IST', () => {
    expect(new Date(CPI_UTC).toISOString()).toBe('2026-10-14T12:30:00.000Z');
    const ist = new Date(CPI_UTC + 330 * MIN);
    expect(ist.toISOString().slice(0, 10)).toBe('2026-10-14');
    expect(ist.getUTCHours()).toBe(18);
    expect(ist.getUTCMinutes()).toBe(0);
  });

  it('is blacked out at -30 minutes (17:30 IST)', () => {
    const t = CPI_UTC - 30 * MIN;
    expect(new Date(t + 330 * MIN).getUTCHours()).toBe(17);
    expect(new Date(t + 330 * MIN).getUTCMinutes()).toBe(30);
    expect(inBlackout([cpi], t)).toBe(true);
  });

  it('is blacked out at +30 minutes (18:30 IST)', () => {
    const t = CPI_UTC + 30 * MIN;
    expect(new Date(t + 330 * MIN).getUTCHours()).toBe(18);
    expect(new Date(t + 330 * MIN).getUTCMinutes()).toBe(30);
    expect(inBlackout([cpi], t)).toBe(true);
  });

  it('is blacked out at the exact release', () => {
    expect(inBlackout([cpi], CPI_UTC)).toBe(true);
  });

  it('is NOT blacked out at -31 or +31 minutes', () => {
    expect(inBlackout([cpi], CPI_UTC - 31 * MIN)).toBe(false);
    expect(inBlackout([cpi], CPI_UTC + 31 * MIN)).toBe(false);
  });

  it('is not blacked out during US market hours on 13 Oct', () => {
    expect(inBlackout([cpi], Date.UTC(2026, 9, 13, 14, 0, 0))).toBe(false);
  });

  it('names CPI and states a blackout in the reason', () => {
    const reason = blackoutReason([cpi], CPI_UTC - 15 * MIN);
    expect(reason).toContain('CPI');
    expect(reason).toContain('15m');
    expect(reason).toContain('blackout');
  });

  it('fires on exactly the two hours its +/-30m window spans', () => {
    let fired = 0;
    for (let h = 0; h < 24; h++) {
      if (inBlackout([cpi], Date.UTC(2026, 9, 14, h, 0, 0))) fired++;
    }
    // The release is at 12:30 UTC, so the window is 12:00-13:00 UTC. Both
    // hourly samples fall inside it; 11:00 and 14:00 are an hour clear.
    expect(fired).toBe(2);
  });
});
