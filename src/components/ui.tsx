import { useEffect, useState, type ReactNode } from 'react';
import { freshnessOf, ageLabel } from '../lib/freshness';

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
 * Per-panel freshness badge.
 *
 * Driven by the age of the newest DATA message, not by the age of the last
 * heartbeat. A heartbeat only proves the socket is open; the upstream feed can
 * be silently dead while heartbeats keep flowing, and a badge that counts them
 * would show a reassuring green over frozen prices.
 *
 * UNKNOWN is rendered distinctly from LIVE for the same reason: no data yet is
 * not the same claim as fresh data.
 */
export function FreshnessBadge({
  ageMs,
  className,
}: {
  ageMs: number | null;
  className?: string;
}) {
  const [, setTick] = useState(0);
  useInterval(() => setTick((x) => x + 1), 1000);

  const f = freshnessOf(ageMs);
  const color =
    f === 'LIVE' ? 'var(--color-up)'
      : f === 'DELAYED' ? 'var(--color-amber)'
        : 'var(--color-down)';

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-wide ${className ?? ''}`}
      style={{ color }}
      title={`Data age: ${ageLabel(ageMs)}`}
      role="status"
      aria-live="off"
    >
      <span
        className={f === 'LIVE' ? 'live-dot' : ''}
        style={{ width: 6, height: 6, borderRadius: 999, background: color, display: 'inline-block' }}
      />
      {f}
      {f !== 'LIVE' && (
        <span style={{ opacity: 0.7, fontWeight: 400 }}>({ageLabel(ageMs)})</span>
      )}
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
