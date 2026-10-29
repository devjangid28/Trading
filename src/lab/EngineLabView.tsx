/**
 * The Engine Lab.
 *
 * ## What this page is for
 *
 * It is a SUPERVISION surface. The point is not to show a number that looks
 * good; it is to make it possible to see whether the engine is working, and to
 * show the reader exactly what the evidence does and does not support.
 *
 * ## The rendering rules this page follows
 *
 *   1. **A number that was not measured renders as `—`.** Never as 0, never
 *      as a dash that looks like a measured zero.
 *   2. **Coverage and hit rate are always together.** A hit rate without the
 *      number of trades behind it is a sentence, not a fact.
 *   3. **A tier below the sample floor says so in words.** It does not print
 *      a rate with a small number under it.
 *   4. **The failure classification of a trade is shown with its reason.**
 *      "Variance, no fault" is a verdict and it is shown as one.
 *   5. **`STALE` is never rendered as `LIVE`,** and the Lab is not a market
 *      feed: it reports the age of its own numbers.
 */

import { useCallback, useState } from 'react';
import { api, usePolling } from '../lib/api';
import { Panel, Chip, Empty, Spinner, StatTile } from '../components/ui';
import type {
  LabAccount,
  LabCalibration,
  LabDecision,
  LabLearning,
  LabOverview,
  LabReview,
  LabStatus,
} from '../../shared/types';
import './lab.css';

/** A number that was not measured. */
function dash(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

/** A percentage that was not measured. */
function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)}%`;
}

function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function r(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(3)} R`;
}

function when(at: number | null | undefined): string {
  if (!at) return '—';
  return new Date(at).toLocaleString('en-GB');
}

// ─── 1. Status ───────────────────────────────────────────────────────────────

function StatusSection({ status }: { status: LabStatus | null }) {
  if (!status) return <Empty message="The Lab status has not loaded." />;
  const driftColor =
    status.drift.state === 'GREEN'
      ? 'var(--color-up)'
      : status.drift.state === 'DEGRADED'
        ? 'var(--color-down)'
        : 'var(--color-amber)';

  return (
    <div className="lab-section">
      <div className="lab-tiles">
        <StatTile
          label="Mode"
          value={status.mode}
          sub={status.liveAvailable ? 'LIVE available' : 'LIVE is not available'}
        />
        <StatTile
          label="Model"
          value={status.model.version}
          sub={
            status.model.trainedAt
              ? `trained ${when(status.model.trainedAt)}`
              : 'never fitted — the shipped unfitted model is in force'
          }
        />
        <StatTile
          label="Trained on"
          value={status.model.trainedOnTrades === null ? '—' : `${status.model.trainedOnTrades} trades`}
          sub={status.model.trainedAt ? when(status.model.trainedAt) : undefined}
        />
        <StatTile
          label="Drift monitor"
          value={status.drift.state}
          color={driftColor}
          sub={`${status.drift.n} live trade${status.drift.n === 1 ? '' : 's'} in the window`}
        />
        <StatTile
          label="Kill switch"
          value={status.killSwitch ? 'ON' : 'off'}
          color={status.killSwitch ? 'var(--color-down)' : undefined}
          sub={status.killSwitch ? 'nothing is opened in any mode' : 'the engine may open positions'}
        />
        <StatTile
          label="Daily loss"
          value={money(status.dailyLoss.realisedPnlUsdToday)}
          color={status.dailyLoss.halted ? 'var(--color-down)' : undefined}
          sub={
            status.dailyLoss.halted
              ? 'HALTED'
              : `limit ${money(-status.dailyLoss.limitUsd)} · ${r(status.dailyLoss.realisedNetRToday)}`
          }
        />
      </div>

      <p className="lab-note" data-testid="lab-drift-reason">
        <strong style={{ color: driftColor }}>Drift monitor.</strong> {status.drift.reason}
      </p>

      {status.dailyLoss.halted && (
        <p className="lab-note" style={{ color: 'var(--color-down)' }} data-testid="lab-halt-reason">
          <strong>Daily-loss halt.</strong> {status.dailyLoss.reason}
        </p>
      )}

      {status.shadowOnly && (
        <p className="lab-note" style={{ color: 'var(--color-amber)' }} data-testid="lab-shadow-notice">
          <strong>Shadow-only.</strong> Decisions are recorded and nothing is executed.
        </p>
      )}

      <p className="lab-note">
        <strong>Executors.</strong> Paper: available. Testnet:{' '}
        {status.executors.testnet.enabled ? 'on' : 'off'} — {status.executors.testnet.reason} Live:{' '}
        {status.executors.live.available ? 'available' : 'not built'} — {status.executors.live.reason}
      </p>
    </div>
  );
}

// ─── 2. Live decisions ───────────────────────────────────────────────────────

function DecisionsSection({ decisions }: { decisions: LabDecision[] | null }) {
  if (!decisions) return <Spinner label="Reading the decisions…" />;
  if (!decisions.length) {
    return (
      <Empty
        message="The engine is considering nothing right now."
        hint="No board candidate produced a decision. That is the normal state: most scans produce no trade."
      />
    );
  }
  return (
    <div className="lab-table-wrap">
      <table className="lab-table" data-testid="lab-decisions">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Side</th>
            <th>P(win)</th>
            <th>95% CI</th>
            <th>Net R</th>
            <th>Top features</th>
            <th>Vetoes that did not fire</th>
            <th>Why it was skipped</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((d) => (
            <tr key={d.id} data-testid={`lab-decision-${d.symbol}`}>
              <td className="mono">{d.symbol}</td>
              <td>
                <span className={d.side === 'bullish' ? 'up' : 'down'}>{d.side === 'bullish' ? 'LONG' : 'SHORT'}</span>
              </td>
              <td className="mono">{d.pWin === null ? '—' : `${(d.pWin * 100).toFixed(1)}%`}</td>
              <td className="mono">
                {d.pWinCi ? `${d.pWinCi[0].toFixed(1)}–${d.pWinCi[1].toFixed(1)}%` : '—'}
              </td>
              <td className="mono">{dash(d.expectedNetR, 3)}</td>
              <td>
                {d.topFeatures.length === 0 ? (
                  '—'
                ) : (
                  <ul className="lab-list">
                    {d.topFeatures.map((f) => (
                      <li key={f.name}>
                        <span className="mono">{f.name}</span>{' '}
                        <span style={{ color: 'var(--faint)' }}>
                          {dash(f.value, 3)} {f.unit}
                        </span>{' '}
                        <span style={{ color: f.contribution >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                          {f.contribution >= 0 ? '+' : ''}
                          {f.contribution.toFixed(2)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              <td>
                {d.vetoesNotFired.length === 0 ? (
                  '—'
                ) : (
                  <ul className="lab-list">
                    {d.vetoesNotFired.map((v) => (
                      <li key={v.kind}>
                        <strong>{v.kind}</strong> — {v.why}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              <td className="lab-why">
                {d.actionable ? (
                  <Chip color="var(--color-up)">actionable</Chip>
                ) : (
                  (d.skippedReason ?? '—')
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── 3. The account ──────────────────────────────────────────────────────────

function EquityCurve({ account }: { account: LabAccount }) {
  const pts = account.equityCurve;
  if (pts.length < 2) {
    return (
      <p className="lab-note" data-testid="lab-equity-empty">
        The equity curve needs at least two closed trades before it can be drawn. It has {pts.length}.
      </p>
    );
  }
  const values = pts.map((p) => p.equityUsd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 100;
  const h = 28;
  const d = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - ((p.equityUsd - min) / span) * (h - 2) - 1;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg
      className="lab-spark"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Equity curve"
      data-testid="lab-equity-curve"
    >
      <path d={d} fill="none" stroke="var(--accent, #6366f1)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function AccountSection({ account }: { account: LabAccount | null }) {
  if (!account) return <Spinner label="Reading the account…" />;
  return (
    <div className="lab-section">
      <div className="lab-tiles">
        <StatTile label="Venue" value={account.venue} sub="modelled costs, no real money" />
        <StatTile label="Equity" value={money(account.equityUsd)} />
        <StatTile label="Realised net R" value={r(account.realisedNetR)} />
        <StatTile label="Closed trades" value={account.closedTrades} />
      </div>

      <EquityCurve account={account} />

      <h3 className="lab-h3">Open positions</h3>
      {account.openPositions.length === 0 ? (
        <p className="lab-note" data-testid="lab-no-positions">
          No open positions. The engine abstains most of the time, and that is the intended behaviour.
        </p>
      ) : (
        <div className="lab-table-wrap">
          <table className="lab-table" data-testid="lab-positions">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th>Opened</th>
                <th>Entry</th>
                <th>Mark</th>
                <th>Stop</th>
                <th>Targets</th>
                <th>P(win)</th>
                <th>Net R</th>
                <th>Sector</th>
              </tr>
            </thead>
            <tbody>
              {account.openPositions.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.symbol}</td>
                  <td className={p.side === 'bullish' ? 'up' : 'down'}>{p.side === 'bullish' ? 'LONG' : 'SHORT'}</td>
                  <td className="mono">{when(p.openedAt)}</td>
                  <td className="mono">{dash(p.entryPrice, 4)}</td>
                  <td className="mono">{dash(p.markPrice, 4)}</td>
                  <td className="mono">{dash(p.stop, 4)}</td>
                  <td className="mono">{p.targets.length ? p.targets.map((t) => t.toFixed(4)).join(' / ') : '—'}</td>
                  <td className="mono">{p.pWin === null ? '—' : `${(p.pWin * 100).toFixed(1)}%`}</td>
                  <td className="mono">{dash(p.netR, 3)}</td>
                  <td>{p.sector ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="lab-h3">Fills</h3>
      {account.fills.length === 0 ? (
        <p className="lab-note">No fills yet.</p>
      ) : (
        <div className="lab-table-wrap">
          <table className="lab-table" data-testid="lab-fills">
            <thead>
              <tr>
                <th>When</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Price</th>
                <th>Qty</th>
                <th>Fee</th>
                <th>Slippage</th>
                <th>Costs</th>
              </tr>
            </thead>
            <tbody>
              {account.fills.map((f) => (
                <tr key={f.id}>
                  <td className="mono">{when(f.at)}</td>
                  <td className="mono">{f.symbol}</td>
                  <td>{f.side.toUpperCase()}</td>
                  <td className="mono">{dash(f.price, 4)}</td>
                  <td className="mono">{dash(f.qty, 6)}</td>
                  <td className="mono">{money(f.feeUsd)}</td>
                  <td className="mono">{money(f.slippageUsd)}</td>
                  <td className="lab-why">{f.costNote}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── 4. The reviews ──────────────────────────────────────────────────────────

const FAILURE_LABEL: Record<string, string> = {
  variance: 'Variance',
  'bad-timing': 'Bad timing',
  'stop-too-tight': 'Stop too tight',
  'news-shock': 'News shock',
  'regime-misread': 'Regime misread',
  'cost-drag': 'Cost drag',
  'data-problem': 'Data problem',
  'no-fault-no-change': 'No fault, no change',
};

function ReviewsSection({ reviews }: { reviews: LabReview[] | null }) {
  if (!reviews) return <Spinner label="Reading the reviews…" />;
  if (!reviews.length) {
    return (
      <Empty
        message="No trade has been reviewed yet."
        hint="A review is written the moment a paper position closes. Reviews are evidence only: they never change the model or a threshold."
      />
    );
  }
  return (
    <div className="lab-table-wrap">
      <table className="lab-table" data-testid="lab-reviews">
        <thead>
          <tr>
            <th>Closed</th>
            <th>Symbol</th>
            <th>Side</th>
            <th>P(win)</th>
            <th>Outcome</th>
            <th>Gross R</th>
            <th>Net R</th>
            <th>Cost R</th>
            <th>Classification</th>
            <th>Why</th>
            <th>Snapshot</th>
          </tr>
        </thead>
        <tbody>
          {reviews.map((v) => (
            <tr key={v.id} data-testid={`lab-review-${v.symbol}`}>
              <td className="mono">{when(v.closedAt)}</td>
              <td className="mono">{v.symbol}</td>
              <td className={v.side === 'bullish' ? 'up' : 'down'}>{v.side === 'bullish' ? 'LONG' : 'SHORT'}</td>
              <td className="mono">{v.predictedPWin === null ? '—' : `${(v.predictedPWin * 100).toFixed(1)}%`}</td>
              <td>{v.outcome === null ? 'censored' : v.outcome === 1 ? 'win' : 'loss'}</td>
              <td className="mono">{dash(v.grossR, 3)}</td>
              <td className="mono">{dash(v.netR, 3)}</td>
              <td className="mono">{dash(v.costR, 3)}</td>
              <td>
                <Chip
                  color={v.noFault ? 'var(--muted)' : 'var(--color-amber)'}
                  title={v.noFault ? 'No fault found, no change to the model' : 'A fault was found'}
                >
                  {FAILURE_LABEL[v.failureClass] ?? v.failureClass}
                </Chip>
              </td>
              <td className="lab-why">{v.failureNote}</td>
              <td>
                {v.snapshotUrl ? (
                  <a
                    href={v.snapshotUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="lab-link"
                    data-testid="lab-review-snapshot-link"
                  >
                    feature snapshot
                  </a>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── 5. The learning history ─────────────────────────────────────────────────

function LearningSection({ learning }: { learning: LabLearning | null }) {
  if (!learning) return <Spinner label="Reading the learning history…" />;
  return (
    <div className="lab-section">
      <h3 className="lab-h3">Model versions</h3>
      {learning.models.length === 0 ? (
        <p className="lab-note" data-testid="lab-no-models">
          No model has been fitted yet. The shipped, unfitted model is in force, and its probability is
          calibrated at the base rate by construction.
        </p>
      ) : (
        <div className="lab-table-wrap">
          <table className="lab-table" data-testid="lab-models">
            <thead>
              <tr>
                <th>Version</th>
                <th>Role</th>
                <th>Fitted</th>
                <th>Trained on</th>
                <th>OOS expectancy</th>
                <th>OOS Brier</th>
                <th>OOS log loss</th>
                <th>OOS trades</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {learning.models.map((m) => (
                <tr key={m.version}>
                  <td className="mono">{m.version}</td>
                  <td>
                    <Chip color={m.role === 'CHAMPION' ? 'var(--color-up)' : 'var(--muted)'}>{m.role}</Chip>
                  </td>
                  <td className="mono">{when(m.trainedAt)}</td>
                  <td className="mono">{m.trainedOnTrades === null ? '—' : m.trainedOnTrades}</td>
                  <td className="mono">{dash(m.oosExpectancyR, 3)}</td>
                  <td className="mono">{dash(m.oosBrier, 4)}</td>
                  <td className="mono">{dash(m.oosLogLoss, 4)}</td>
                  <td className="mono">{m.oosTrades === null ? '—' : m.oosTrades}</td>
                  <td className="lab-why">{m.verdict ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="lab-h3">Walk-forward folds</h3>
      {learning.folds.length === 0 ? (
        <p className="lab-note" data-testid="lab-no-folds">
          No fold has been evaluated. The harness needs more resolved trades before it can split the
          population.
        </p>
      ) : (
        <div className="lab-table-wrap">
          <table className="lab-table" data-testid="lab-folds">
            <thead>
              <tr>
                <th>Fold</th>
                <th>Train</th>
                <th>Test</th>
                <th>Purged</th>
                <th>Embargoed</th>
                <th>Brier</th>
                <th>Brier (base rate)</th>
                <th>Log loss</th>
                <th>Coverage</th>
                <th>Win rate</th>
              </tr>
            </thead>
            <tbody>
              {learning.folds.map((f) => (
                <tr key={f.index}>
                  <td className="mono">{f.index}</td>
                  <td className="mono">{f.trainRows}</td>
                  <td className="mono">{f.testRows}</td>
                  <td className="mono">{f.purged}</td>
                  <td className="mono">{f.embargoed}</td>
                  <td className="mono">{dash(f.brier, 4)}</td>
                  <td className="mono">{dash(f.brierBaseRate, 4)}</td>
                  <td className="mono">{dash(f.logLoss, 4)}</td>
                  <td className="mono">{pct(f.coveragePct)}</td>
                  <td className="mono">{pct(f.winRatePct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="lab-h3">Promotions, rejections and rollbacks</h3>
      {learning.decisions.length === 0 ? (
        <p className="lab-note">Nothing has been promoted, rejected or rolled back yet.</p>
      ) : (
        <div className="lab-table-wrap">
          <table className="lab-table" data-testid="lab-decisions-log">
            <thead>
              <tr>
                <th>When</th>
                <th>Version</th>
                <th>What</th>
                <th>Champion R</th>
                <th>Challenger R</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {learning.decisions.map((d, i) => (
                <tr key={`${d.at}_${d.version}_${i}`}>
                  <td className="mono">{when(d.at)}</td>
                  <td className="mono">{d.version}</td>
                  <td>
                    <Chip
                      color={
                        d.kind === 'PROMOTED'
                          ? 'var(--color-up)'
                          : d.kind === 'ROLLED_BACK'
                            ? 'var(--color-amber)'
                            : 'var(--muted)'
                      }
                    >
                      {d.kind}
                    </Chip>
                  </td>
                  <td className="mono">{dash(d.championExpectancyR, 3)}</td>
                  <td className="mono">{dash(d.challengerExpectancyR, 3)}</td>
                  <td className="lab-why">{d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="lab-h3">What blocks promotion beyond paper and testnet</h3>
      <ul className="lab-list" data-testid="lab-promotion-blocked">
        {learning.promotionBlockedBy.length === 0 ? (
          <li>Nothing is blocking it — except the operator&apos;s manual approval, which is always required.</li>
        ) : (
          learning.promotionBlockedBy.map((b) => <li key={b}>{b}</li>)
        )}
      </ul>
    </div>
  );
}

// ─── 6. Calibration ──────────────────────────────────────────────────────────

function ReliabilityDiagram({ cal }: { cal: LabCalibration }) {
  const rows = cal.reliability.filter((r) => r.n > 0);
  if (!rows.length) {
    return (
      <p className="lab-note" data-testid="lab-reliability-empty">
        No decided trade carries a model probability yet, so there is no reliability diagram to draw.
        This is the absence of evidence, not evidence of miscalibration.
      </p>
    );
  }
  const maxN = Math.max(...rows.map((r) => r.n));
  return (
    <div className="lab-reliability" data-testid="lab-reliability">
      <div className="lab-rel-row lab-rel-head">
        <span>Bucket</span>
        <span>n</span>
        <span>Predicted</span>
        <span>Observed</span>
        <span>Gap</span>
        <span />
      </div>
      {rows.map((r) => {
        const obs = r.observed ?? 0;
        const pred = r.meanPredicted ?? 0;
        return (
          <div className="lab-rel-row" key={`${r.lo}-${r.hi}`}>
            <span className="mono">
              {r.lo.toFixed(1)}–{r.hi.toFixed(1)}
            </span>
            <span className="mono">{r.n}</span>
            <span className="mono">{dash(r.meanPredicted, 3)}</span>
            <span className="mono">{dash(r.observed, 3)}</span>
            <span className="mono">{dash(r.gap, 3)}</span>
            <span className="lab-rel-bars">
              <i className="lab-rel-bar lab-rel-pred" style={{ width: `${pred * 100}%` }} />
              <i className="lab-rel-bar lab-rel-obs" style={{ width: `${obs * 100}%` }} />
              <i className="lab-rel-n" style={{ width: `${(r.n / maxN) * 40}%` }} />
            </span>
          </div>
        );
      })}
      <p className="lab-note">
        The filled bar is the predicted probability, the hollow bar is the observed rate, and the grey
        bar is the number of trades in the bucket.
      </p>
    </div>
  );
}

function CalibrationSection({ cal }: { cal: LabCalibration | null }) {
  if (!cal) return <Spinner label="Reading the calibration…" />;
  return (
    <div className="lab-section">
      <div className="lab-tiles">
        <StatTile label="Decided trades" value={cal.n} sub={`${cal.censored} censored and excluded`} />
        <StatTile label="Base rate" value={pct(cal.baseRate === null ? null : cal.baseRate * 100, 2)} />
        <StatTile label="Brier" value={dash(cal.brier, 4)} sub={`base rate ${dash(cal.brierBaseRate, 4)}`} />
        <StatTile
          label="Brier skill"
          value={cal.brierSkill === null ? '—' : `${(cal.brierSkill * 100).toFixed(1)}%`}
          sub="against the constant base rate"
        />
        <StatTile label="Log loss" value={dash(cal.logLoss, 4)} sub="nats per observation" />
      </div>

      <p className="lab-note" data-testid="lab-calibration-verdict">
        {cal.verdict}
      </p>

      <h3 className="lab-h3">Reliability</h3>
      <ReliabilityDiagram cal={cal} />

      <h3 className="lab-h3">Confidence tiers</h3>
      <div className="lab-table-wrap">
        <table className="lab-table" data-testid="lab-tiers">
          <thead>
            <tr>
              <th>Threshold</th>
              <th>Trades</th>
              <th>Coverage</th>
              <th>Hit rate</th>
              <th>95% Wilson CI</th>
              <th>Net R</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {cal.tiers.map((t) => (
              <tr key={t.threshold}>
                <td className="mono">p ≥ {t.threshold.toFixed(2)}</td>
                <td className="mono">{t.n}</td>
                <td className="mono">{pct(t.coveragePct)}</td>                <td className="mono">{t.hitRatePct === null ? '—' : pct(t.hitRatePct, 2)}</td>
                <td className="mono">
                  {t.hitRateCi ? `${t.hitRateCi[0].toFixed(1)}–${t.hitRateCi[1].toFixed(1)}%` : '—'}
                </td>
                <td className="mono">{dash(t.netR, 3)}</td>
                <td className="lab-why">{t.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── 7. The controls ─────────────────────────────────────────────────────────

function ControlsSection({
  status,
  onAction,
  busy,
  message,
}: {
  status: LabStatus | null;
  onAction: (action: string, arg?: string) => void;
  busy: boolean;
  message: string | null;
}) {
  const versions = status?.challenger ? [status.challenger.version] : [];
  return (
    <div className="lab-section">
      <div className="lab-controls">
        <button
          type="button"
          className="lab-btn"
          disabled={busy}
          onClick={() => onAction('start')}
          data-testid="lab-start"
        >
          Start
        </button>
        <button
          type="button"
          className="lab-btn"
          disabled={busy}
          onClick={() => onAction('stop')}
          data-testid="lab-stop"
        >
          Stop
        </button>
        <button
          type="button"
          className="lab-btn"
          disabled={busy}
          onClick={() => onAction(status?.killSwitch ? 'kill-switch-off' : 'kill-switch-on')}
          data-testid="lab-kill-switch"
          style={
            status?.killSwitch
              ? { borderColor: 'var(--color-down)', color: 'var(--color-down)' }
              : undefined
          }
        >
          Kill switch: {status?.killSwitch ? 'ON' : 'off'}
        </button>
        <button
          type="button"
          className="lab-btn"
          disabled={busy}
          onClick={() => onAction(status?.shadowOnly ? 'shadow-only-off' : 'shadow-only-on')}
          data-testid="lab-shadow-only"
        >
          Shadow-only: {status?.shadowOnly ? 'ON' : 'off'}
        </button>
        <button
          type="button"
          className="lab-btn"
          disabled={busy}
          onClick={() => onAction('retrain')}
          data-testid="lab-retrain"
        >
          Retrain now
        </button>
        <button
          type="button"
          className="lab-btn"
          disabled={busy || !status}
          onClick={() => onAction('mode', status?.mode === 'PAPER' ? 'SHADOW' : 'PAPER')}
          data-testid="lab-mode"
        >
          Mode: {status?.mode ?? '—'}
        </button>
      </div>

      {message && (
        <p className="lab-note" data-testid="lab-control-message">
          {message}
        </p>
      )}

      {versions.length > 0 && (
        <div className="lab-controls">
          {versions.map((v) => (
            <button
              key={v}
              type="button"
              className="lab-btn"
              disabled={busy}
              onClick={() => onAction('rollback', v)}
              data-testid={`lab-rollback-${v}`}
            >
              Roll back to {v}
            </button>
          ))}
        </div>
      )}

      <p className="lab-note">
        The kill switch is checked before any adapter, so it works even when the adapter is broken.
        Shadow-only records the decisions and executes nothing. A retrain needs a full batch of new
        resolved trades first; the Lab refuses to fit a model on a single loss.
      </p>
    </div>
  );
}

// ─── The page ────────────────────────────────────────────────────────────────

export function EngineLabView() {
  const status = usePolling<LabStatus>((s) => api.labStatus(s), 15_000);
  const decisions = usePolling<{ decisions: LabDecision[] }>((s) => api.labDecisions(s), 30_000);
  const account = usePolling<LabAccount>((s) => api.labAccount(s), 30_000);
  const reviews = usePolling<{ reviews: LabReview[] }>((s) => api.labReviews(s), 30_000);
  const learning = usePolling<LabLearning>((s) => api.labLearning(s), 60_000);
  const calibration = usePolling<LabCalibration>((s) => api.labCalibration(s), 60_000);
  const alert = usePolling<{ message: LabOverview['alertMessage'] }>((s) => api.labAlertMessage(s), 30_000);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onAction = useCallback(async (action: string, arg?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.labControl(action, arg);
      setMessage(res.message);
      status.refresh();
      decisions.refresh();
      account.refresh();
      reviews.refresh();
      learning.refresh();
      calibration.refresh();
    } catch (err) {
      setMessage(`The control failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [status, decisions, account, reviews, learning, calibration]);

  const error = status.error ?? decisions.error ?? account.error;

  return (
    <div className="lab-page">
      <div className="lab-header">
        <div>
          <h2 className="text-[15px] font-bold tracking-tight">Engine Lab</h2>
          <p className="text-[11.5px] mt-0.5" style={{ color: 'var(--muted)' }}>
            The engine is tested, trained and supervised here. Paper and testnet only — real-money
            execution is not built.
          </p>
        </div>
      </div>

      {error && <Empty message="The Lab could not be reached." hint={error} />}

      <div className="lab-grid">
        <Panel
          title="Status"
          subtitle="Mode, model, drift, kill switch and the daily-loss halt"
          className="lab-span-2"
        >
          <StatusSection status={status.data} />
        </Panel>

        <Panel
          title="Controls"
          subtitle="Start, stop, kill switch, shadow-only, rollback"
          className="lab-span-2"
        >
          <ControlsSection status={status.data} onAction={onAction} busy={busy} message={message} />
        </Panel>

        <Panel
          title="Live decisions"
          subtitle="What the engine is considering right now"
          className="lab-span-2"
          bodyClass="overflow-y-auto"
        >
          <DecisionsSection decisions={decisions.data?.decisions ?? null} />
        </Panel>

        <Panel
          title="Paper account"
          subtitle="Equity, open positions and fills"
          className="lab-span-2"
          bodyClass="overflow-y-auto"
        >
          <AccountSection account={account.data} />
        </Panel>

        <Panel
          title="Post-trade reviews"
          subtitle="Every resolved trade, with its classification"
          className="lab-span-2"
          bodyClass="overflow-y-auto"
        >
          <ReviewsSection reviews={reviews.data?.reviews ?? null} />
        </Panel>

        <Panel
          title="Learning history"
          subtitle="Model versions, promotions, rejections, rollbacks and the walk-forward folds"
          className="lab-span-2"
          bodyClass="overflow-y-auto"
        >
          <LearningSection learning={learning.data} />
        </Panel>

        <Panel
          title="Calibration"
          subtitle="Reliability, confidence tiers, Brier and log loss"
          className="lab-span-2"
          bodyClass="overflow-y-auto"
        >
          <CalibrationSection cal={calibration.data} />
        </Panel>

        <Panel
          title="Outbound alert message"
          subtitle="For a TradingView alert or a chart note — nothing is sent by this app"
          className="lab-span-2"
        >
          {alert.data?.message ? (
            <div className="lab-section">
              <p className="lab-note">
                {alert.data.message.symbol} · {alert.data.message.side} · entry{' '}
                {alert.data.message.entry} · stop {alert.data.message.stop} · P(win){' '}
                {alert.data.message.pWin === null
                  ? '—'
                  : `${(alert.data.message.pWin * 100).toFixed(1)}%`}{' '}
                · model {alert.data.message.modelVersion}
              </p>
              <pre className="lab-json" data-testid="lab-alert-json">
                {alert.data.message.json}
              </pre>
              <p className="lab-note">
                TradingView&apos;s paper-trading account is a manual UI simulator with no public
                order-placement API. Its only automation is an outbound alert webhook, so this message
                is for you to paste into an alert or a chart note.
              </p>
            </div>
          ) : (
            <p className="lab-note" data-testid="lab-alert-empty">
              There is no actionable decision to turn into an alert message right now.
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}
