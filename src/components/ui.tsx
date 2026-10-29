import { useEffect, useState, type ReactNode } from 'react';
import { freshnessOf, ageLabel, useAgeClock } from '../lib/freshness';
import { useLastDataAt } from '../lib/priceStore';

export function Panel({
  title,
  subtitle,
  right,
  children,
  className = '',
  bodyClass = '',
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={`panel flex flex-col min-h-0 ${className}`}>
      {title && (
        <header className="panel-header shrink-0">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-tight truncate">{title}</h2>
            {subtitle && (
              <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--muted)' }}>
                {subtitle}
              </p>
            )}
          </div>
          {right && <div className="shrink-0 flex items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={`flex-1 min-h-0 ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function Chip({
  children,
  color,
  bg,
  title,
}: {
  children: ReactNode;
  color?: string;
  bg?: string;
  title?: string;
}) {
  return (
    <span className="chip" style={{ color: color ?? 'var(--muted)', background: bg ?? 'var(--panel-2)' }} title={title}>
      {children}
    </span>
  );
}

export function LiveBadge({ updatedAt, stale }: { updatedAt: number; stale?: boolean }) {
  const [, setTick] = useState(0);
  useInterval(() => setTick((x) => x + 1), 1000);
  const secs = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  const color = stale ? 'var(--color-amber)' : 'var(--color-up)';
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium" style={{ color }}>
      <span
        className={stale ? '' : 'live-dot'}
        style={{ width: 7, height: 7, borderRadius: 999, background: color, display: 'inline-block' }}
      />
      {stale ? 'Stale' : secs < 5 ? 'Live' : `${secs}s ago`}
    </span>
  );
}

/**
 * Stream health notice — silent when healthy.
 *
 * WHY IT RENDERS NOTHING WHEN LIVE
 *
 * This replaced a permanent `LIVE` badge in the header plus a `STALE 10s ago`
 * tag on every board row. A trading terminal does not do that: when the feed is
 * healthy it just renders the price, and the only time it speaks about the
 * feed is when the feed is wrong. A badge that says "LIVE" 99.9% of the time
 * trains the eye to skip it, which means it has no value on the 0.1% — the one
 * occasion it exists for.
 *
 * So the notice is silent by default and appears only past the DELAYED
 * threshold, naming the age and the reason. That still satisfies the rule that
 * stale data is never presented as live: silence is a claim about a feed we are
 * actively receiving at 5Hz, not a badge we forgot to turn off. If the stream
 * stops, this renders — it is the only thing standing between a frozen price
 * and an unsuspecting trader.
 *
 * Driven by the age of the newest DATA message, not by the heartbeat. A
 * heartbeat only proves the socket is open; the upstream feed can be silently
 * dead while heartbeats keep flowing.
 */
export function StreamNotice({
  ageMs,
  className,
}: {
  /** Explicit age if the caller knows it; otherwise the app-wide data clock. */
  ageMs?: number | null;
  className?: string;
}) {
  const now = useAgeClock();
  const lastData = useLastDataAt();

  const resolvedAge = ageMs !== undefined
    ? ageMs
    : lastData === null
      ? null
      : now - lastData;

  const f = freshnessOf(resolvedAge);
  // LIVE renders nothing at all. There is no dot, no word, no reserved space.
  if (f === 'LIVE') return null;

  const color = f === 'DELAYED' ? 'var(--color-amber)' : 'var(--color-down)';
  const label =
    f === 'UNKNOWN'
      ? 'connecting — no data yet'
      : f === 'DELAYED'
        ? `feed delayed ${ageLabel(resolvedAge)}`
        : `feed stale ${ageLabel(resolvedAge)} — prices are not updating`;

  return (
    <span
      data-testid="stream-notice"
      className={`inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-wide ${className ?? ''}`}
      style={{ color }}
      title={`Newest market data is ${ageLabel(resolvedAge)} old`}
      role="status"
    >
      <span
        style={{ width: 6, height: 6, borderRadius: 999, background: color, display: 'inline-block' }}
      />
      {label}
    </span>
  );
}

/**
 * The market source mode, shown persistently in the app header.
 *
 * This is a different claim from `StreamNotice`: freshness says how old THIS
 * panel's data is; the mode badge says where the data is coming from at all.
 * `MOCK` (fixture replay), `BANNED` (the upstream host was rate-limited or
 * banned us), and `OFFLINE` (no socket) each need to be visible
 * without hovering a tooltip — the old pill claimed "LIVE 24/7" over all of
 * them, which is the exact dishonesty this badge exists to remove.
 */
export type MarketMode = 'LIVE' | 'MOCK' | 'BANNED' | 'OFFLINE';

const MODE_PALETTE: Record<MarketMode, { color: string; label: string }> = {
  LIVE: { color: 'var(--color-up)', label: 'LIVE' },
  MOCK: { color: 'var(--color-amber)', label: 'MOCK' },
  BANNED: { color: 'var(--color-down)', label: 'BANNED' },
  OFFLINE: { color: 'var(--faint)', label: 'OFFLINE' },
};

export function ModeBadge({
  mode,
  detail,
  className,
}: {
  mode: MarketMode;
  detail?: string;
  className?: string;
}) {
  const p = MODE_PALETTE[mode];
  return (
    <span
      data-testid="mode-badge"
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-widest ${className ?? ''}`}
      style={{
        color: p.color,
        borderColor: `color-mix(in srgb, ${p.color} 45%, transparent)`,
        background: `color-mix(in srgb, ${p.color} 8%, transparent)`,
      }}
      title={detail}
      role="status"
    >
      <span
        style={{ width: 6, height: 6, borderRadius: 999, background: p.color, display: 'inline-block' }}
      />
      {p.label}
    </span>
  );
}

/**
 * Per-value age tag.
 *
 * Kept for panels that render one number whose provenance matters on its own
 * (a single quote, a funding rate, a position mark) — where saying how old the
 * number is adds information rather than clutter.
 *
 * NOT used on the board rows. A per-row age tag on a 200-row board is the
 * "STALE 10s ago" wall of text this UI used to have: it fires on whichever
 * symbol happens to be quiet, says nothing actionable, and buries the price it
 * sits next to. `StreamNotice` covers the case that actually matters — the feed
 * as a whole — in one place.
 */
export function ValueAge({
  at,
  className,
}: {
  /** Epoch ms the displayed value was produced, or null when never seen. */
  at: number | null | undefined;
  className?: string;
}) {
  const now = useAgeClock();
  const age = at === null || at === undefined ? null : Math.max(0, now - at);
  const f = freshnessOf(age);
  if (f === 'LIVE') return null;
  const color = f === 'DELAYED' ? 'var(--color-amber)' : 'var(--color-down)';
  return (
    <span
      data-testid="row-age"
      className={`font-semibold tracking-wide ${className ?? ''}`}
      style={{ color }}
      title={at == null ? 'No value received yet' : `Value produced ${new Date(at).toISOString()}`}
    >
      {f === 'UNKNOWN' ? 'NO DATA' : `${f} ${ageLabel(age)}`}
    </span>
  );
}

export function useInterval(cb: () => void, ms: number | null) {
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(cb, ms);
    return () => clearInterval(id);
  }, [cb, ms]);
}

export function StatTile({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  color?: string;
}) {
  return (
    <div className="px-3 py-2 min-w-0">
      <div className="text-[10px] uppercase tracking-wider truncate" style={{ color: 'var(--faint)' }}>
        {label}
      </div>
      <div className="mono text-[15px] font-semibold leading-tight truncate" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub !== undefined && (
        <div className="text-[10px] truncate" style={{ color: 'var(--muted)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export function Empty({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
        {message}
      </p>
      {hint && (
        <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="h-full flex items-center justify-center gap-2 p-6" style={{ color: 'var(--muted)' }}>
      <span
        style={{
          width: 14,
          height: 14,
          border: '2px solid var(--border)',
          borderTopColor: 'var(--accent, #6366f1)',
          borderRadius: 999,
          animation: 'spin 0.7s linear infinite',
        }}
      />
      <span className="text-[12px]">{label ?? 'Loading…'}</span>
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );
}
