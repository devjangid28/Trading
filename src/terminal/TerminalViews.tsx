import { useMemo, useState } from 'react';
import type { AssetRow, TerminalTrade } from '../../shared/types';
import { isUnavailable } from '../../shared/types';
import type { BookFrame, PullEvent } from './math';
import { pullEvents } from './math';
import { fmtPct, fmtPrice, fmtUsd, istClock } from '../lib/format';
import type { GexSnapshot, PlanContext } from './levels';

const DASH = '\u2014';

export function TapeView({ trades }: { trades: TerminalTrade[] }) {
  const list = [...trades].sort((a, b) => b.t - a.t).slice(0, 240);
  return (
    <section className="terminal-simple">
      <header className="terminal-simple__head">
        <div>
          <h2>Tape</h2>
          <p>Every print this browser captured: aggressor, price, size and exact time. Server history is sampled, so gaps are real capture gaps.</p>
        </div>
        <span className="terminal-chip">{trades.length.toLocaleString()} captured</span>
      </header>
      <div className="terminal-table-wrap">
        <table className="terminal-table">
          <thead>
            <tr><th>Time</th><th>Side</th><th className="num">Price</th><th className="num">Notional</th><th className="num">Qty</th></tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id}>
                <td className="mono">{istClock(t.t)}</td>
                <td><span className={t.side === 'buy' ? 'is-up' : 'is-down'}>{t.side.toUpperCase()}</span></td>
                <td className="num mono">{fmtPrice(t.price)}</td>
                <td className={`num mono ${t.side === 'buy' ? 'is-up' : 'is-down'}`}>{fmtUsd(t.usd)}</td>
                <td className="num mono">{t.qty.toFixed(5)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="terminal-empty-inline">No prints captured yet. An empty tape is not the same as no trades.</div>}
      </div>
    </section>
  );
}

export function WhalesView({ trades }: { trades: TerminalTrade[] }) {
  const whales = useMemo(() => [...trades].sort((a, b) => b.usd - a.usd).slice(0, 80), [trades]);
  return (
    <section className="terminal-simple">
      <header className="terminal-simple__head">
        <div>
          <h2>Whales</h2>
          <p>The largest aggregate prints in the captured tape. Size is exact for the print; it is not a claim about a single order.</p>
        </div>
        <span className="terminal-chip">{whales.filter((t) => t.usd >= 50_000).length} over $50K</span>
      </header>
      <div className="whale-grid">
        {whales.slice(0, 24).map((t) => (
          <article key={t.id} className={`whale-card ${t.side === 'buy' ? 'is-up' : 'is-down'}`}>
            <div className="whale-card__size">{fmtUsd(t.usd)}</div>
            <div className="whale-card__meta">
              <span>{t.side.toUpperCase()}</span>
              <span>{fmtPrice(t.price)}</span>
              <span>{istClock(t.t)}</span>
            </div>
            <div className="whale-card__qty">{t.qty.toFixed(5)} executed</div>
          </article>
        ))}
      </div>
      {!whales.length && <div className="terminal-empty-inline">No prints captured yet.</div>}
    </section>
  );
}

interface ProfileRow {
  price: number;
  buy: number;
  sell: number;
  total: number;
}

export function VolumeProfileView({ trades, mid }: { trades: TerminalTrade[]; mid: number | null }) {
  const profile = useMemo(() => {
    if (!trades.length) return { rows: [] as ProfileRow[], poc: null as number | null, vah: null as number | null, val: null as number | null };
    const ref = mid && mid > 0 ? mid : trades[trades.length - 1].price;
    const bin = Math.max(ref * 0.0002, 1e-9);
    const map = new Map<number, ProfileRow>();
    for (const t of trades) {
      const key = Math.round(t.price / bin);
      const row = map.get(key) ?? { price: key * bin, buy: 0, sell: 0, total: 0 };
      if (t.side === 'buy') row.buy += t.usd; else row.sell += t.usd;
      row.total += t.usd;
      map.set(key, row);
    }
    const all = [...map.values()].sort((a, b) => b.price - a.price);
    const total = all.reduce((sum, row) => sum + row.total, 0);
    const poc = all.reduce<ProfileRow | null>((top, row) => (!top || row.total > top.total ? row : top), null);
    const sorted = [...all].sort((a, b) => b.total - a.total);
    let running = 0;
    const area: ProfileRow[] = [];
    for (const row of sorted) {
      area.push(row);
      running += row.total;
      if (running >= total * 0.7) break;
    }
    const prices = area.map((row) => row.price);
    return { rows: all, poc: poc?.price ?? null, vah: prices.length ? Math.max(...prices) : null, val: prices.length ? Math.min(...prices) : null };
  }, [trades, mid]);
  const shown = profile.rows.slice(0, 60);
  const max = Math.max(1, ...profile.rows.map((r) => r.total));
  return (
    <section className="terminal-simple">
      <header className="terminal-simple__head">
        <div>
          <h2>Volume profile</h2>
          <p>Notional traded at each price in the captured tape. POC, VAH and VAL use a 70% value area. This is captured volume, not exchange lifetime volume.</p>
        </div>
        <div className="terminal-chip-row">
          <span className="terminal-chip">POC {profile.poc === null ? DASH : fmtPrice(profile.poc)}</span>
          <span className="terminal-chip">VAH {profile.vah === null ? DASH : fmtPrice(profile.vah)}</span>
          <span className="terminal-chip">VAL {profile.val === null ? DASH : fmtPrice(profile.val)}</span>
        </div>
      </header>
      <div className="profile-list">
        {shown.map((row) => {
          const width = (row.total / max) * 100;
          return (
            <div key={row.price} className={`profile-row${profile.poc === row.price ? ' is-poc' : ''}`}>
              <span className="mono profile-row__price">{fmtPrice(row.price)}</span>
              <div className="profile-row__bar">
                <i className="is-buy" style={{ width: `${(row.buy / max) * 100}%` }} />
                <i className="is-sell" style={{ width: `${(row.sell / max) * 100}%` }} />
              </div>
              <span className="mono profile-row__total" style={{ opacity: 0.5 + 0.5 * (width / 100) }}>{fmtUsd(row.total)}</span>
            </div>
          );
        })}
      </div>
      {!shown.length && <div className="terminal-empty-inline">No captured volume profile for this market yet.</div>}
    </section>
  );
}

export function GammaView({ snapshot, error, base }: { snapshot: GexSnapshot | null; error: string | null; base: string }) {
  if (!snapshot) {
    return (
      <section className="terminal-simple">
        <header className="terminal-simple__head"><div><h2>Gamma</h2><p>{base === 'BTC' || base === 'ETH' ? error ?? 'The Deribit GEX request returned no snapshot.' : `Deribit GEX is published for BTC and ETH only. ${base} has no gamma snapshot here.`}</p></div></header>
        <div className="terminal-empty-inline">No gamma numbers are shown rather than a made-up zero.</div>
      </section>
    );
  }
  const max = Math.max(1, ...snapshot.strikes.map((s) => Math.abs(s.netGex)));
  return (
    <section className="terminal-simple">
      <header className="terminal-simple__head">
        <div>
          <h2>Gamma · {snapshot.symbol}</h2>
          <p>Deribit open interest, refreshed every five minutes. Max pain is the largest-OI strike; walls are the largest call/put OI strikes; Γ flip is where cumulative net GEX crosses zero.</p>
        </div>
        <div className="terminal-chip-row">
          <span className="terminal-chip">pin {snapshot.maxPainStrike.toLocaleString()}</span>
          <span className="terminal-chip">call wall {snapshot.callWall.toLocaleString()}</span>
          <span className="terminal-chip">put wall {snapshot.putWall.toLocaleString()}</span>
          <span className="terminal-chip">flip {snapshot.zeroGamma.toFixed(0)}</span>
          <span className={`terminal-chip ${snapshot.dealersShortGamma ? 'is-down' : 'is-up'}`}>{snapshot.dealersShortGamma ? 'dealers short Γ' : 'dealers long Γ'}</span>
        </div>
      </header>
      <div className="terminal-table-wrap">
        <table className="terminal-table">
          <thead><tr><th>Strike</th><th className="num">Net GEX</th><th className="num">Call OI</th><th className="num">Put OI</th><th>Share</th></tr></thead>
          <tbody>
            {snapshot.strikes.map((s) => (
              <tr key={s.strike}>
                <td className="mono">{s.strike.toLocaleString()}</td>
                <td className={`num mono ${s.netGex >= 0 ? 'is-up' : 'is-down'}`}>{fmtUsd(Math.abs(s.netGex))}</td>
                <td className="num mono">{s.callOi.toLocaleString()}</td>
                <td className="num mono">{s.putOi.toLocaleString()}</td>
                <td><div className="gex-bar"><i style={{ width: `${(Math.abs(s.netGex) / max) * 100}%` }} className={s.netGex >= 0 ? 'is-buy' : 'is-sell'} /></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function L3EventsView({ frames, trades }: { frames: BookFrame[]; trades: TerminalTrade[] }) {
  const events = useMemo(() => pullEvents(frames, trades, 5_000, 120).slice().reverse(), [frames, trades]);
  return (
    <section className="terminal-simple">
      <header className="terminal-simple__head">
        <div>
          <h2>L3 events</h2>
          <p>Resting levels that disappeared between captured snapshots without a trade at that price. Binance's public stream is diff-depth, not raw L3: this is an event log sampled at roughly one second, not every add/cancel.</p>
        </div>
        <span className="terminal-chip">{events.length} pulls</span>
      </header>
      <div className="terminal-table-wrap">
        <table className="terminal-table">
          <thead><tr><th>Time</th><th>Side</th><th className="num">Price</th><th className="num">Size pulled</th><th className="num">Stood for</th></tr></thead>
          <tbody>
            {events.map((event: PullEvent, i) => (
              <tr key={`${event.t}-${event.price}-${i}`}>
                <td className="mono">{istClock(event.t)}</td>
                <td><span className={event.side === 'bid' ? 'is-up' : 'is-down'}>{event.side.toUpperCase()}</span></td>
                <td className="num mono">{fmtPrice(event.price)}</td>
                <td className="num mono">{fmtUsd(event.usd)}</td>
                <td className="num mono">{event.standingMs >= 1_000 ? `${Math.round(event.standingMs / 1_000)}s` : '<1s'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!events.length && (
          <div className="terminal-empty-inline">
            No quiet pulls recorded. A level consumed by a trade is intentionally not listed as a pull.
          </div>
        )}
      </div>
    </section>
  );
}

export function FuturesView({ row, base }: { row: AssetRow | null; base: string }) {
  const deriv = row?.derivatives ?? null;
  if (!row || !deriv) {
    return (
      <section className="terminal-simple">
        <header className="terminal-simple__head"><div><h2>Futures · {base}</h2><p>No derivatives row for this market in the current scan. The spot book still works; funding and OI are shown only when the exchange published them.</p></div></header>
      </section>
    );
  }
  const liq = deriv.liq;
  return (
    <section className="terminal-simple">
      <header className="terminal-simple__head"><div><h2>Futures · {base}</h2><p>Exchange-published derivatives, not derived from the spot tape. Funding is normalised to an 8-hour basis.</p></div></header>
      <div className="terminal-stat-grid">
        <div><small>Funding 8h</small><b className={deriv.funding8h >= 0 ? 'is-up' : 'is-down'}>{fmtPct(deriv.funding8h * 100, 4)}</b><em>{deriv.fundingLabel.replaceAll('_', ' ')}</em></div>
        <div><small>Funding z</small><b>{deriv.fundingZ === null ? DASH : deriv.fundingZ.toFixed(2)}</b><em>{deriv.fundingZ === null ? 'no history' : 'vs 30d'}</em></div>
        <div><small>Open interest</small><b>{fmtUsd(deriv.oiUsd)}</b><em>{deriv.openInterest.toLocaleString()} contracts</em></div>
        <div><small>Basis</small><b>{deriv.basisPct === null ? DASH : fmtPct(deriv.basisPct, 3)}</b><em>mark vs index</em></div>
        <div><small>OI quadrant</small><b>{deriv.quadrant}</b><em>{deriv.quadrantLabel}</em></div>
        <div><small>Long/short</small><b>{deriv.longShortAccountRatio === null ? DASH : deriv.longShortAccountRatio.toFixed(2)}</b><em>top traders {deriv.topTraderPositionRatio === null ? DASH : deriv.topTraderPositionRatio.toFixed(2)}</em></div>
        <div><small>Liquidations 1h</small><b>{isUnavailable(liq) ? DASH : `${fmtUsd(liq.longH1)} long / ${fmtUsd(liq.shortH1)} short`}</b><em>{isUnavailable(liq) ? liq.reason : 'forceOrder sample · lower bound'}</em></div>
        <div><small>Liquidation pressure</small><b>{isUnavailable(liq) ? DASH : fmtPct(liq.longH1 + liq.shortH1 > 0 ? ((liq.longH1 - liq.shortH1) / (liq.longH1 + liq.shortH1)) * 100 : 0, 1)}</b><em>positive = longs flushed</em></div>
      </div>
      <div className="terminal-simple__note">
        Mark {fmtPrice(deriv.markPrice)} · index {fmtPrice(deriv.indexPrice)} · taker ratio {deriv.takerRatio === null ? DASH : deriv.takerRatio.toFixed(2)} · CVD proxy {fmtUsd(deriv.cvd)}
        {deriv.cvdDivergence ? ' · CVD divergence flagged' : ''}
      </div>
    </section>
  );
}

export function SentimentView({ row, plan, base }: { row: AssetRow | null; plan: PlanContext; base: string }) {
  const conviction = row?.conviction ?? null;
  const mind = row?.mind ?? null;
  return (
    <section className="terminal-simple">
      <header className="terminal-simple__head">
        <div><h2>Sentiment · {base}</h2><p>Only engine-derived evidence: conviction, checklist, Mind probability and event risk. No social score is invented.</p></div>
        <div className="terminal-chip-row">
          <span className={`terminal-chip ${plan.signal === 'BUY' ? 'is-up' : plan.signal === 'SELL' ? 'is-down' : ''}`}>{plan.signal}</span>
          <span className="terminal-chip">{conviction ? `grade ${conviction.grade}` : 'no grade'}</span>
          {mind && <span className="terminal-chip">P(win) {(mind.probability * 100).toFixed(0)}%</span>}
        </div>
      </header>
      <div className="sentiment-grid">
        <article className="sentiment-card">
          <h3>Plan state</h3>
          <p>{plan.reason}</p>
          <dl>
            <div><dt>Entry</dt><dd>{plan.entry === null ? DASH : fmtPrice(plan.entry)}</dd></div>
            <div><dt>Stop</dt><dd>{plan.stop === null ? DASH : fmtPrice(plan.stop)}</dd></div>
            <div><dt>R:R</dt><dd>{plan.rr > 0 ? plan.rr.toFixed(2) : DASH}</dd></div>
            <div><dt>Targets</dt><dd>{plan.targets.length ? plan.targets.map(fmtPrice).join(' · ') : DASH}</dd></div>
          </dl>
        </article>
        <article className="sentiment-card">
          <h3>Conviction {conviction ? `· ${conviction.score}` : ''}</h3>
          {conviction ? (
            <>
              <p>{conviction.rule.replaceAll('_', ' ')} · {conviction.isPick ? 'pick' : 'not a pick'}</p>
              <ul className="sentiment-list">
                {conviction.checklist.map((tick) => (
                  <li key={tick.key} className={tick.ok ? 'is-up' : 'is-down'}>
                    <b>{tick.ok ? '\u2713' : '\u2715'} {tick.label}</b>
                    <span>{tick.reason}</span>
                  </li>
                ))}
              </ul>
              {conviction.vetoes.length > 0 && <p className="is-down">Vetoes: {conviction.vetoes.join(' · ')}</p>}
            </>
          ) : <p>No conviction was run for this row.</p>}
        </article>
        <article className="sentiment-card">
          <h3>Mind</h3>
          {mind ? (
            <>
              <p>{mind.regime} · {mind.confidenceBand} confidence · net {mind.netExpectedR.toFixed(2)}R</p>
              <p>{mind.actionable ? 'Actionable under the Mind gates.' : 'Not actionable under the Mind gates.'}</p>
              <ul className="sentiment-list">
                {mind.drivers.slice(0, 6).map((d) => (
                  <li key={d.feature}><b>{d.feature}</b><span>{d.reason}</span></li>
                ))}
              </ul>
              {mind.vetoes.length > 0 && <p className="is-down">Vetoes: {mind.vetoes.map((v) => v.code).join(' · ')}</p>}
            </>
          ) : <p>No Mind verdict for this row.</p>}
        </article>
        <article className="sentiment-card">
          <h3>Event risk</h3>
          <p>{row?.eventRisk ? 'An event is inside the look-ahead window.' : 'No event risk flagged for this row.'}</p>
          <p>News dot: {row?.newsDot ? `${row.newsDot.direction > 0 ? 'positive' : row.newsDot.direction < 0 ? 'negative' : 'neutral'} · NIS ${row.newsDot.nis.toFixed(2)} · ${row.newsDot.count} items` : DASH}</p>
          <p>Unlock: {row?.unlock ? `${row.unlock.pct.toFixed(2)}% on ${row.unlock.date}${row.unlock.cliff ? ' · cliff' : ''}` : DASH}</p>
        </article>
      </div>
    </section>
  );
}

export function GuideView() {
  const [section, setSection] = useState<'heatmap' | 'columns' | 'data'>('heatmap');
  return (
    <section className="terminal-simple guide-view">
      <header className="terminal-simple__head">
        <div><h2>Guide</h2><p>How to read this terminal, and what it refuses to pretend to know.</p></div>
        <div className="terminal-chip-row">
          <button type="button" className={section === 'heatmap' ? 'is-on' : ''} onClick={() => setSection('heatmap')}>Heatmap</button>
          <button type="button" className={section === 'columns' ? 'is-on' : ''} onClick={() => setSection('columns')}>Columns</button>
          <button type="button" className={section === 'data' ? 'is-on' : ''} onClick={() => setSection('data')}>Data honesty</button>
        </div>
      </header>
      {section === 'heatmap' && (
        <div className="guide-grid">
          <article><h3>Heat</h3><p>Resting bid and ask notional. Brighter and yellower is more size. An empty cell means no recorded level, never a filled zero.</p></article>
          <article><h3>Bubbles</h3><p>Executed size. Green is bought, red is sold. A split bubble means both sides traded in the same step. Yellow rings mark the largest prints.</p></article>
          <article><h3>Chevrons</h3><p>A double chevron marks a large aggressor print that failed to move the mid over the following step: absorption, not a directional signal by itself.</p></article>
          <article><h3>Pulls</h3><p>A white ✕ means a resting level disappeared between snapshots with no trade at that price. Hover it for the notional and how long it stood.</p></article>
          <article><h3>Plan line</h3><p>The engine's own trigger. Buy above and sell below are drawn from the reviewed setup; if the row has no setup, the Plan layer says so instead of inventing a line.</p></article>
          <article><h3>Grid</h3><p>Cyan dashed verticals are time, not events. The right axis is price. The last price is the white dashed horizontal, and the tag is the exact mid or last print used.</p></article>
        </div>
      )}
      {section === 'columns' && (
        <div className="guide-grid">
          <article><h3>Book</h3><p>Live resting bid and ask at each price row, with a half-and-half bar. The header totals are across the captured book, not a made-up depth.</p></article>
          <article><h3>Delta</h3><p>Bought minus sold at each price. A green bar means buyers were the aggressor there; red means sellers were.</p></article>
          <article><h3>COB / Cum / Size</h3><p>Current order book and cumulative resting size added up from the spread outward. Cum is the ladder view; Size is the same notional without the cumulative walk.</p></article>
          <article><h3>SVP / Volume</h3><p>Volume at price. SVP is cumulative over the captured session or span, volume is the active span. Both are labelled as captured, not exchange lifetime volume.</p></article>
          <article><h3>SuperDOM</h3><p>sold | bid | price | ask | bought. It is the ladder at a glance; the price column is the row midpoint, never a guessed tick.</p></article>
          <article><h3>CQC</h3><p>Quote counter: how many times the resting size at a price changed between snapshots. High counts mean the level is being refreshed, not that it is a wall.</p></article>
        </div>
      )}
      {section === 'data' && (
        <div className="guide-grid">
          <article><h3>Book</h3><p>Binance spot diff-depth at 100 ms plus a REST snapshot for the initial sync. Gaps trigger a resync; the header counter says how many.</p></article>
          <article><h3>History</h3><p>The server samples the terminal book every 3 s and stores compact 0.5 bps lattices for 27 hours. History is drawn as captured bands, not individual levels.</p></article>
          <article><h3>Trades</h3><p>The tape is the public aggTrade stream plus captured history. The sample count is shown in diagnostics; it is not the whole market's tape.</p></article>
          <article><h3>Gamma</h3><p>Deribit option open interest, cached for five minutes. Only BTC and ETH have a snapshot. Walls and the Γ flip are computed from the published strikes.</p></article>
          <article><h3>Liquidations</h3><p>!forceOrder@arr pushes at most one print per symbol per second. Liq lines and totals are explicitly a lower bound.</p></article>
          <article><h3>No mock fill</h3><p>If the venue does not answer, the chart shows the error. It never silently replaces the live market with generated candles or a simulated book.</p></article>
        </div>
      )}
    </section>
  );
}
