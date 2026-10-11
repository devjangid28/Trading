import { useEffect, useState } from 'react';

/**
 * Header countdown to the next blacked-out macro release.
 *
 * CPI is the nearest tier-1 event until it passes, so this is the piece that
 * makes the 14 Oct 18:00 IST print visible without opening a tab. It ticks
 * locally every second from a server-supplied timestamp, so it stays accurate
 * between polls instead of freezing whenever the parent re-renders.
 *
 * The blackout state itself is highlighted, not just the countdown: inside the
 * +/-30 minute window the chip turns red, because that is the only moment the
 * veto is actually suppressing trades.
 */

export interface NextBlackout {
  id: string;
  kind: string;
  title: string;
  t: string;
  ist: string;
  et: string;
  minutesUntil: number;
}

const KIND_LABEL: Record<string, string> = {
  CPI: 'CPI',
  NFP: 'JOBS',
  PCE: 'PCE',
  FOMC: 'FOMC',
};

function compact(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function BlackoutCountdown({ next }: { next: NextBlackout | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!next) {
    return (
      <span
        className="text-[11px] whitespace-nowrap px-2 py-1 rounded-md shrink-0"
        style={{ color: 'var(--faint)' }}
        title="No blacked-out macro event scheduled"
      >
        no macro event
      </span>
    );
  }

  const target = Date.parse(next.t);
  const remain = target - Date.now();
  const inWindow = remain <= 30 * 60_000 && remain >= -30 * 60_000;
  const imminent = remain > 0 && remain <= 24 * 3600_000;

  return (
    <span
      className="text-[11px] font-medium whitespace-nowrap px-2 py-1 rounded-md shrink-0 flex items-center gap-1.5"
      style={{
        background: inWindow ? 'var(--color-down)' : 'var(--panel-2)',
        color: inWindow ? '#fff' : imminent ? 'var(--text)' : 'var(--muted)',
      }}
      title={
        `${next.title}\n${next.et} / ${next.ist}\n` +
        (inWindow
          ? 'BLACKOUT ACTIVE - no A/B grades within 30 minutes of the release'
          : 'Blackout starts 30 minutes before the release')
      }
      role="status"
      aria-live="polite"
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: inWindow ? '#fff' : imminent ? 'var(--color-down)' : 'var(--faint)' }}
      />
      <span>{KIND_LABEL[next.kind] ?? next.kind}</span>
      <span style={{ opacity: 0.65 }}>{next.ist}</span>
      <span style={{ opacity: inWindow ? 1 : 0.75 }}>{inWindow ? 'BLACKOUT' : compact(remain)}</span>
    </span>
  );
}