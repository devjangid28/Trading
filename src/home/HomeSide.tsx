import { useEffect, useMemo, useState } from 'react';
import type { JournalTrade } from '../../shared/types';
import { fmtUsd } from '../lib/format';

/**
 * Sidebar (B6): journal, a learn card, and quick actions.
 *
 * "Tracked assets" lives here rather than in the macro strip's tile alone,
 * because A8 was a bare dash: a number the user cannot source is worse than an
 * explicit "unavailable with a reason". This card shows the count together with
 * where it came from, or says plainly that it is unavailable.
 */

const JOURNAL_KEY = 'orderflow:journal:v1';

function readJournal(): JournalTrade[] {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    return raw ? (JSON.parse(raw) as JournalTrade[]) : [];
  } catch {
    return [];
  }
}

export interface HomeSideProps {
  onNavigate: (tab: 'journal' | 'learn') => void;
  trackedAssets?: number;
  trackedSource?: string;
}

export function HomeSide({ onNavigate, trackedAssets, trackedSource }: HomeSideProps) {
  const [trades, setTrades] = useState<JournalTrade[]>([]);
  useEffect(() => {
    setTrades(readJournal());
    // The journal can change in another tab; re-read on focus so the sidebar
    // never disagrees with the Journal tab.
    const onFocus = () => setTrades(readJournal());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const stats = useMemo(() => {
    const closed = trades.filter((t) => t.pnl !== null && t.pnl !== undefined);
    const net = closed.reduce((a, t) => a + (t.pnl ?? 0), 0);
    const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
    return { count: trades.length, closed: closed.length, net, winRate: closed.length ? (wins / closed.length) * 100 : null };
  }, [trades]);

  return (
    <div className="of-side-stack">
      <section className="of-card of-journal" data-testid="journal-card">
        <span className="of-tile"><Ic name="book" /></span>
        <h3>Trading journal</h3>
        {stats.count === 0 ? (
          <>
            <b className="of-journal-lead">Log your first trade</b>
            <p className="of-muted">
              Every A/B pick the engine freezes is a hypothesis. Logging what you actually took is the
              only way to find out whether the score means anything.
            </p>
            <button type="button" className="of-btn" onClick={() => onNavigate('journal')}>Open journal</button>
          </>
        ) : (
          <>
            <b className="of-journal-lead">{stats.net >= 0 ? 'Net profit' : 'Net loss'} {fmtUsd(stats.net)}</b>
            <div className="of-journal-stats">
              <span><b>{stats.closed}</b> closed</span>
              <span><b>{stats.winRate === null ? '—' : `${stats.winRate.toFixed(0)}%`}</b> win rate</span>
            </div>
            <EquityLine trades={trades} />
            <button type="button" className="of-btn" onClick={() => onNavigate('journal')}>Open journal</button>
          </>
        )}
      </section>

      <section className="of-card of-learn" data-testid="learn-card">
        <h3>Read the board in 10 seconds</h3>
        <ol className="of-learn-steps">
          <li><b>Rank</b> is strength — a big move that went nowhere scores zero and never reaches the board.</li>
          <li><b>The zone</b> is the order block. Price reacting there is the setup; price through it is not.</li>
          <li><b>Grade</b> A/B are the picks. Greyed-out rows were vetoed, and the chip says why.</li>
        </ol>
        <div className="of-learn-bar" aria-hidden="true"><i style={{ width: '100%' }} /></div>
        <button type="button" className="of-btn" onClick={() => onNavigate('learn')}>How it works</button>
      </section>

      <section className="of-card of-actions" data-testid="quick-actions">
        <h3>Quick actions</h3>
        <ul>
          <li>
            <span className="of-tile sm up"><Ic name="book" /></span>
            <span><b>Log a trade</b><em>Add it to your journal</em></span>
            <button type="button" onClick={() => onNavigate('journal')} aria-label="Log a trade" />
          </li>
          <li>
            <span className="of-tile sm dn"><Ic name="bell" /></span>
            <span><b>Set an alert</b><em>Price, funding or news</em></span>
            <button type="button" onClick={() => onNavigate('learn')} aria-label="Set an alert" />
          </li>
          <li>
            <span className="of-tile sm violet"><Ic name="play" /></span>
            <span><b>Learn</b><em>Grades, checklist, vetoes</em></span>
            <button type="button" onClick={() => onNavigate('learn')} aria-label="Learn" />
          </li>
          <li>
            <span className="of-tile sm amber"><Ic name="mail" /></span>
            <span><b>Send feedback</b><em>Ideas, bugs, data issues</em></span>
            <button type="button" onClick={() => onNavigate('learn')} aria-label="Send feedback" />
          </li>
        </ul>
      </section>

      <section className="of-card of-tracked" data-testid="tracked-card">
        <h3>Tracked assets</h3>
        {trackedAssets === undefined || trackedAssets === null ? (
          <p className="of-muted" data-testid="tracked-unavailable">
            Unavailable — the scan has not reported a universe size yet.
          </p>
        ) : (
          <>
            <b className="of-tracked-n" data-testid="tracked-count">{trackedAssets}</b>
            <em className="of-muted">{trackedSource ?? 'order flow universe'}</em>
          </>
        )}
      </section>
    </div>
  );
}

function EquityLine({ trades }: { trades: JournalTrade[] }) {
  const pts = useMemo(() => {
    let eq = 0;
    return trades
      .filter((t) => t.pnl !== null && t.pnl !== undefined)
      .map((t) => { eq += t.pnl ?? 0; return eq; });
  }, [trades]);
  if (pts.length < 2) return null;
  const min = Math.min(0, ...pts);
  const max = Math.max(0, ...pts);
  const span = max - min || 1;
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (pts.length - 1)) * 100},${28 - ((v - min) / span) * 24}`).join(' ');
  return (
    <svg className="of-equity" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Equity line">
      <line x1="0" x2="100" y1={28 - ((0 - min) / span) * 24} y2={28 - ((0 - min) / span) * 24} className="eq-zero" />
      <path d={d} className={pts[pts.length - 1] >= 0 ? 'eq-up' : 'eq-dn'} />
    </svg>
  );
}

const PATHS: Record<string, string> = {
  book: 'M4 19V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zm0 0a2 2 0 0 0 2 2h14',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  play: 'M8 5.14v13.72L19 12 8 5.14z',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2 8 6 8-6',
};

function Ic({ name }: { name: string }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? 'M12 5v14M5 12h14'} />
    </svg>
  );
}