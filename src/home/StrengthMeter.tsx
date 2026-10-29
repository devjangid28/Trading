import type { Side } from '../../shared/types';
import { ROW_HOVER_MS } from './motion';

/**
 * Segmented strength meter.
 *
 * Replaces the old tall sparkline card. The meter's job is to show *how strong*
 * the move is, at a glance, across rows of different assets — which is a
 * comparison problem, not a shape problem. Twenty-eight thin ticks are far
 * easier to compare down a column than twenty-eight different sparklines.
 *
 * `value` is the engine's strength score. It is unbounded above, so it is
 * normalised against `max` (the strongest row on screen) rather than against a
 * constant: the meter then always fills 0-100% of what is actually on the page,
 * and a quiet market still produces a readable spread.
 */

export const METER_TICKS = 28;

export function meterFill(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

export function StrengthMeter({
  value,
  max,
  side,
  compact = false,
}: {
  value: number;
  max: number;
  side: Side;
  compact?: boolean;
}) {
  const fill = meterFill(value, max);
  const filled = Math.round(fill * METER_TICKS);
  const accent = side === 'bullish' ? 'var(--color-up)' : 'var(--color-down)';

  return (
    <span
      className={`of-meter ${side === 'bullish' ? 'is-bull' : 'is-bear'}`}
      data-testid="strength-meter"
      data-fill={filled}
      data-value={Number.isFinite(value) ? value : 0}
      aria-hidden="true"
    >
      {Array.from({ length: METER_TICKS }, (_, i) => (
        <i
          key={i}
          className={
            i < filled ? 'on' : i === filled && filled < METER_TICKS ? 'mark' : 'off'
          }
          style={{
            background: i <= filled ? accent : undefined,
            transitionDuration: `${ROW_HOVER_MS}ms`,
          }}
        />
      ))}
      {compact && <span className="of-meter-cap">{filled}</span>}
    </span>
  );
}