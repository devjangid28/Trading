/**
 * Mind layer UI — probability, drivers, regime, calibration.
 *
 * ## The rule these components exist to enforce
 *
 * **Never render a binary signal.** There is no "SIGNAL: YES" anywhere in this
 * file, and there will not be one added, because a binary reading of a
 * probabilistic forecast is how a 54% edge gets read as a certainty.
 *
 * Every probability is rendered as a probability *and* beside the question that
 * makes it meaningful: "when we have said 54%, how often were we right?" If that
 * history is too thin to answer, the component says so and shows nothing. A dash
 * is the correct output for an unmeasured reliability, and it is what appears.
 */

import { useEffect, useState } from 'react';
import type { MindHealthView, MindRegime, MindSignalRow } from '../lib/api';

/** Regime → label and colour. Adjectives, never conclusions. */
const REGIME_LABEL: Record<MindRegime, string> = {
  'trending-bull': 'trending up',
  'trending-bear': 'trending down',
  range: 'ranging',
  'high-vol-cascade': 'liquidation cascade',
  'macro-blackout': 'macro blackout',
  quiet: 'quiet',
};

const REGIME_COLOR: Record<MindRegime, string> = {
  'trending-bull': 'var(--color-up)',
  'trending-bear': 'var(--color-down)',
  range: 'var(--accent)',
  'high-vol-cascade': 'var(--color-amber)',
  'macro-blackout': 'var(--color-down)',
  quiet: 'var(--faint)',
};

const BAND_COLOR: Record<'high' | 'medium' | 'low', string> = {
  high: 'var(--color-up)',
  medium: 'var(--accent)',
  low: 'var(--faint)',
};

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

/** R-multiples, kept to one decimal because the second is noise. */
function r(v: number): string {
  return `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(1)}R`;
}

export function RegimeBadge({ regime }: { regime: MindRegime }) {
  return (
    <span
      className="mind-regime"
      data-testid="mind-regime"
      data-regime={regime}
      title="The market-wide state the scorer read. Market-wide, not per-coin."
      style={{ color: REGIME_COLOR[regime], borderColor: REGIME_COLOR[regime] }}
    >
      {REGIME_LABEL[regime]}
    </span>
  );
}

/**
 * The probability gauge.
 *
 * Deliberately a bar with a scale, not a big percentage. The bar's width is the
 * claim; the number is only there to be read off it. A 54% bar looks like a 54%
 * bar, and "54%" in 64px type looks like a verdict.
 */
export function ProbabilityGauge({ signal }: { signal: MindSignalRow }) {
  const vetoed = signal.vetoes.length > 0;
  const color = vetoed ? 'var(--color-down)' : BAND_COLOR[signal.confidenceBand];

  return (
    <div className="mind-gauge" data-testid="mind-gauge">
      <div className="mind-gauge-head">
        <span className="mind-gauge-label">P(win)</span>
        <span className="mind-gauge-value" style={{ color }} data-testid="mind-probability">
          {vetoed ? 'no trade' : pct(signal.probability)}
        </span>
      </div>
      <div
        className="mind-gauge-track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={vetoed ? 0 : Math.round(signal.probability * 100)}
        aria-label="Calibrated probability of the target being hit"
      >
        <div
          className="mind-gauge-fill"
          style={{ width: `${vetoed ? 0 : signal.probability * 100}%`, background: color }}
        />
        {/* The base rate, marked on the track. Everything to the left of this line
            is the model saying "this is worse than the average signal". */}
        {!vetoed && <div className="mind-gauge-baseline" aria-hidden="true" />}
      </div>
      <div className="mind-gauge-foot">
        <span>
          expected <strong>{r(signal.netExpectedR)}</strong> net
        </span>
        <span className="mind-band" style={{ color }}>
          {vetoed ? 'vetoed' : `${signal.confidenceBand} confidence`}
        </span>
      </div>
    </div>
  );
}

/**
 * Why this score. Disclosure drivers (missing-data notices) are marked so a thin
 * number reads as thin rather than as confident-but-brief.
 */
export function DriverList({ signal }: { signal: MindSignalRow }) {
  if (signal.drivers.length === 0) {
    return (
      <p className="mind-drivers-empty">
        No driver was strong enough to move this score off the base rate.
      </p>
    );
  }
  return (
    <ul className="mind-drivers" data-testid="mind-drivers">
      {signal.drivers.map((d) => (
        <li key={d.feature} className={d.disclosure ? 'is-disclosure' : undefined}>
          <span className="mind-driver-name">{labelFor(d.feature)}</span>
          <span className="mind-driver-reason">{d.reason}</span>
          {!d.disclosure && (
            <span className="mind-driver-num">
              {d.contribution >= 0 ? '+' : ''}
              {d.contribution.toFixed(2)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Vetoes render as refusals with their reason, never as a negative score. */
export function VetoList({ signal }: { signal: MindSignalRow }) {
  if (signal.vetoes.length === 0) return null;
  return (
    <ul className="mind-vetoes" data-testid="mind-vetoes">
      {signal.vetoes.map((v) => (
        <li key={v.code}>
          <span className="mind-veto-code">{v.code}</span>
          <span className="mind-veto-reason">{v.reason}</span>
        </li>
      ))}
    </ul>
  );
}

/** Feature-path → human label. Strips the group prefix. */
function labelFor(feature: string): string {
  return feature
    .replace(/^(structure|positioning|catalyst|regime|context|tradability)\./, '')
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .trim();
}

/**
 * The calibration footnote: "we said X%, this grade has realised Y%".
 *
 * Renders nothing at all when the sample is too small. An empty space is the
 * honest answer; a footnote with no numbers is not.
 */
export function CalibrationFootnote({
  calibration,
  grade,
  probability,
}: {
  calibration: MindHealthView['calibration'] | null;
  grade: string;
  probability: number;
}) {
  // Suppressed entirely below the sample floor. An empty space is the honest
  // answer here; a footnote with no numbers in it is not.
  if (!calibration || calibration.suppressed) return null;
  if (calibration.brier === null || calibration.brierBaseRate === null) return null;

  return (
    <p className="mind-calibration" data-testid="mind-calibration">
      Grade {grade}. This score reads {pct(probability)}.{' '}
      {calibration.beatsBaseRate ? (
        <>
          Across {calibration.n} resolved signals, the probabilities have landed closer to
          their stated value than the base rate would have (Brier {calibration.brier.toFixed(3)}{' '}
          vs {calibration.brierBaseRate.toFixed(3)}).
        </>
      ) : (
        <>
          Across {calibration.n} resolved signals, the model is{' '}
          <strong>not yet beating</strong> the base rate (Brier {calibration.brier.toFixed(3)} vs{' '}
          {calibration.brierBaseRate.toFixed(3)}). Read this as a ranking, not a forecast.
        </>
      )}
    </p>
  );
}

/**
 * The Mind health strip: live Brier against the base rate, resolved count,
 * current regime, last refit.
 *
 * The one number that matters is the comparison, so the two Brier figures are
 * rendered side by side and the verdict is stated in words.
 */
export function MindHealthStrip({
  health,
  onToggleEvidence,
}: {
  health: MindHealthView | null;
  onToggleEvidence?: () => void;
}) {
  if (!health) {
    return (
      <div className="mind-strip is-waiting" data-testid="mind-strip">
        Mind: waiting for the first scan
      </div>
    );
  }

  if (!health.ok) {
    return (
      <div className="mind-strip is-waiting" data-testid="mind-strip">
        Mind: {health.reason ?? 'not ready'}
      </div>
    );
  }

  const c = health.calibration;
  return (
    <div className="mind-strip" data-testid="mind-strip">
      <RegimeBadge regime={health.regime} />

      <span className="mind-strip-counts">
        {health.bands.actionable} actionable · {health.bands.vetoed} vetoed
      </span>

      {c.suppressed ? (
        <span className="mind-strip-suppressed" title={c.suppressReason ?? undefined}>
          uncalibrated · {c.n} signals
        </span>
      ) : (
        <span
          className="mind-strip-brier"
          data-testid="mind-brier"
          title="Brier score of the Mind probabilities, against a model that always predicts the base rate."
        >
          Brier <strong>{c.brier!.toFixed(3)}</strong> vs base{' '}
          <strong>{c.brierBaseRate!.toFixed(3)}</strong>{' '}
          <span className={c.beatsBaseRate ? 'is-good' : 'is-warn'}>
            {c.beatsBaseRate ? 'better' : 'not better yet'}
          </span>
        </span>
      )}

      <span
        className="mind-strip-model"
        title={
          health.model.usingShippedWeights
            ? `Hand-tuned weights, not fitted to outcomes yet. Last refit: ${
                c.lastRefitAt ? new Date(c.lastRefitAt).toISOString().slice(0, 10) : 'never'
              }.`
            : 'Outcome-fitted weights.'
        }
      >
        {health.model.usingShippedWeights ? '[TUNED]' : 'fitted'}
        {c.lastRefitAt ? ` · refit ${new Date(c.lastRefitAt).toISOString().slice(0, 10)}` : ''}
      </span>

      {onToggleEvidence && health.regimeEvidence.length > 0 && (
        <button type="button" className="mind-strip-why" onClick={onToggleEvidence}>
          why this regime?
        </button>
      )}
    </div>
  );
}

/** The regime's evidence, expanded. Every input, with its reading. */
export function RegimeEvidence({
  evidence,
}: {
  evidence: Array<{ input: string; value: number | string | null; reading: string }>;
}) {
  if (evidence.length === 0) return null;
  return (
    <ul className="mind-evidence" data-testid="mind-regime-evidence">
      {evidence.map((e) => (
        <li key={e.input}>
          <span className="mind-evidence-input">{e.input}</span>
          <span className="mind-evidence-value">{e.value === null ? '—' : e.value}</span>
          <span className="mind-evidence-reading">{e.reading}</span>
        </li>
      ))}
    </ul>
  );
}

/** The whole per-signal block, as mounted inside a Signals card. */
export function MindSignalBlock({
  signal,
  calibration,
  grade,
  evidence,
}: {
  signal: MindSignalRow;
  calibration: MindHealthView['calibration'] | null;
  grade: string;
  evidence?: Array<{ input: string; value: number | string | null; reading: string }>;
}) {
  const [showWhy, setShowWhy] = useState(false);
  const rows = evidence ?? [];
  return (
    <div className="mind-block" data-testid="mind-block">
      <ProbabilityGauge signal={signal} />
      <DriverList signal={signal} />
      <VetoList signal={signal} />
      <CalibrationFootnote calibration={calibration} grade={grade} probability={signal.probability} />
      {rows.length > 0 && (
        <>
          <button
            type="button"
            className="mind-why"
            onClick={() => setShowWhy((s) => !s)}
            aria-expanded={showWhy}
          >
            {showWhy ? 'hide the regime read' : 'why this score?'}
          </button>
          {showWhy && <RegimeEvidence evidence={rows} />}
        </>
      )}
    </div>
  );
}

/** Small hook for the health strip, so it polls itself. */
export function useMindHealth(intervalMs = 60_000): MindHealthView | null {
  const [health, setHealth] = useState<MindHealthView | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const load = async () => {
      try {
        const res = await fetch('/api/mind/health');
        if (!res.ok) return;
        const body = (await res.json()) as MindHealthView;
        if (live) setHealth(body);
      } catch {
        // A failed health read leaves the previous value in place. Replacing it
        // with null would flash "waiting for the first scan" on every hiccup,
        // which is a different and much scarier claim.
      }
    };
    void load();
    timer = setInterval(() => void load(), intervalMs);
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [intervalMs]);
  return health;
}