import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { fmtUsd, SEVERITY_STYLE } from '../lib/format';
import type { NewsItem } from '../../shared/types';

/**
 * News impact mini feed (B5).
 *
 * Replaces the community/social feed the reference shows. There is no community
 * feature in OrderFlow and there is not going to be one; what the space is
 * better spent on is the top stories by News Impact Score, because that is the
 * same information the terminal already computes and the one thing a trader
 * checks before acting on a move.
 */

export function NewsMiniFeed() {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      api.news()
        .then((f) => { if (live) { setItems(f.items ?? []); setError(null); } })
        .catch((e: Error) => { if (live) setError(e.message); });
    load();
    const id = setInterval(load, 300_000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const top = useMemo(
    () => [...(items ?? [])].sort((a, b) => b.nis - a.nis).slice(0, 3),
    [items],
  );

  return (
    <section className="of-card of-news" data-testid="news-mini">
      <header className="of-sec-h">
        <h2>News impact</h2>
      </header>
      {error && !items ? (
        <p className="of-news-unavail">Unavailable — {error}</p>
      ) : top.length === 0 ? (
        <p className="of-news-unavail">No scored stories in the current feed window.</p>
      ) : (
        <ol className="of-news-list">
          {top.map((n) => {
            const sev = SEVERITY_STYLE[n.severityClass];
            return (
              <li key={n.id} className="of-news-i" data-testid="news-item">
                <span className="sev" style={{ background: sev.bg, color: sev.fg, borderColor: sev.border }}>
                  {sev.label}
                </span>
                <a href={n.url} target="_blank" rel="noreferrer noopener" className="hl">{n.headline}</a>
                <span className="meta">
                  {n.source}
                  {n.assets.length > 0 && <> · <b>{n.assets.slice(0, 3).join(', ')}</b></>}
                  <u>{Math.round(n.nis)}</u>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export { fmtUsd };