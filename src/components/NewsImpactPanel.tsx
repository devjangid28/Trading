import { useMemo, useState } from 'react';
import type { NewsCategory, NewsFeed, NewsItem, SeverityClass } from '../../shared/types';
import { fmtAge, SEVERITY_STYLE, tierColor } from '../lib/format';
import { Chip } from './ui';

const CATEGORIES: (NewsCategory | 'ALL')[] = [
  'ALL', 'MACRO', 'ETF', 'HACK', 'STABLE', 'REG', 'TECH', 'LIST', 'WHALE', 'ADOPT', 'DISTRESS', 'LIQ',
];

const CAT_LABEL: Record<NewsCategory, string> = {
  ETF: 'ETF', HACK: 'Security', STABLE: 'Stablecoin', REG: 'Regulation', TECH: 'Protocol',
  LIST: 'Listing', WHALE: 'On-chain', ADOPT: 'Adoption', DISTRESS: 'Distress',
  LIQ: 'Derivatives', MACRO: 'Macro', GENERAL: 'General',
};

function DirectionArrow({ d }: { d: -1 | 0 | 1 }) {
  if (d === 0) {
    return (
      <span className="chip" style={{ background: 'var(--panel-2)', color: 'var(--faint)' }} title="No directional view — too unconfirmed">
        ●
      </span>
    );
  }
  const up = d > 0;
  return (
    <span
      className="chip"
      style={{
        background: up ? 'rgba(22,163,74,0.16)' : 'rgba(220,38,38,0.16)',
        color: up ? 'var(--color-up)' : 'var(--color-down)',
      }}
      title={up ? 'Expected to push price up' : 'Expected to push price down'}
    >
      {up ? '▲' : '▼'}
      {Math.abs(d)}
    </span>
  );
}

function NewsRow({ item, onOpen }: { item: NewsItem; onOpen?: (i: NewsItem) => void }) {
  const sev = SEVERITY_STYLE[item.severityClass];
  return (
    <button
      type="button"
      onClick={() => onOpen?.(item)}
      className="w-full text-left border-b px-3 py-2.5 hover:bg-[var(--panel-2)] transition-colors of-in"
      style={{ borderColor: 'var(--border)' }}
    >
      <div className="flex items-start gap-2">
        <span
          className="shrink-0 mono text-[11px] font-bold rounded px-1.5 py-0.5 mt-0.5"
          style={{ background: sev.bg, color: sev.fg, border: `1px solid ${sev.border}` }}
          title={`News Impact Score (${sev.label})`}
        >
          {Math.round(item.nis)}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] leading-snug font-medium line-clamp-2">{item.headline}</p>

          <div className="flex flex-wrap items-center gap-1 mt-1.5">
            <span className="text-[10px] flex items-center gap-1" style={{ color: 'var(--muted)' }}>
              <span
                style={{ width: 6, height: 6, borderRadius: 999, background: tierColor(item.tier) }}
                title={`Source tier ${item.tier} of 15`}
              />
              {item.source}
            </span>
            <span style={{ color: 'var(--faint)' }}>·</span>
            <span className="text-[10px]" style={{ color: 'var(--faint)' }}>
              {fmtAge(item.ageMinutes)}
            </span>

            {item.categories.slice(0, 2).map((c) => (
              <Chip key={c}>{CAT_LABEL[c]}</Chip>
            ))}

            {item.assets.slice(0, 4).map((a) => (
              <Chip
                key={a}
                color="var(--accent)"
                bg="color-mix(in srgb, var(--accent) 14%, transparent)"
              >
                {a}
              </Chip>
            ))}

            {item.jurisdiction !== 'GLOBAL' && (
              <Chip>{item.jurisdiction === 'IN' ? '🇮🇳 India' : item.jurisdiction === 'US' ? '🇺🇸 US' : '🇪🇺 EU'}</Chip>
            )}

            {item.noveltyLabel === 'NEW' && (
              <Chip color="#8b5cf6" bg="rgba(139,92,246,0.14)">
                NEW
              </Chip>
            )}

            {item.reversalRisk >= 0.6 && (
              <Chip color="#d97706" bg="rgba(217,119,6,0.14)" title="Scheduled macro reactions historically reverse over the following hours">
                ↩ reversal risk
              </Chip>
            )}
          </div>

          <div className="flex items-center gap-2 mt-1.5">
            <DirectionArrow d={item.direction} />
            <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'var(--panel-2)' }}>
              <div
                style={{
                  width: `${item.nis}%`,
                  height: '100%',
                  background: sev.fg,
                }}
              />
            </div>
            {item.direction !== 0 && (
              <span className="mono text-[10px] shrink-0" style={{ color: 'var(--muted)' }}>
                {item.expectedBps > 0 ? '+' : ''}
                {item.expectedBps}bp
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

export function NewsImpactPanel({ feed, onOpen }: { feed: NewsFeed | null; onOpen?: (i: NewsItem) => void }) {
  const [cat, setCat] = useState<NewsCategory | 'ALL'>('ALL');
  const [minSev, setMinSev] = useState<SeverityClass | 'ALL'>('ALL');

  const items = useMemo(() => {
    if (!feed) return [];
    return feed.items.filter((i) => {
      if (cat !== 'ALL' && !i.categories.includes(cat)) return false;
      if (minSev !== 'ALL') {
        const order: SeverityClass[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NOISE'];
        if (order.indexOf(i.severityClass) > order.indexOf(minSev)) return false;
      }
      return true;
    });
  }, [feed, cat, minSev]);

  const counts = feed?.counts;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        className="flex flex-wrap gap-1 px-2 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--border)' }}
      >
        {CATEGORIES.map((c) => {
          const active = cat === c;
          const n = c === 'ALL' ? feed?.items.length : feed?.byCategory.find((x) => x.category === c)?.count;
          if (!active && !n) return null;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              className="chip"
              style={
                active
                  ? { background: 'var(--accent)', color: '#fff' }
                  : { background: 'var(--panel-2)', color: 'var(--muted)' }
              }
            >
              {c === 'ALL' ? 'All' : CAT_LABEL[c]}
              {n ? <span style={{ opacity: 0.7 }}>{n}</span> : null}
            </button>
          );
        })}
      </div>

      {counts && (
        <div className="flex gap-1.5 px-3 py-1.5 shrink-0">
          {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as SeverityClass[]).map((s) => {
            const st = SEVERITY_STYLE[s];
            const active = minSev === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setMinSev(active ? 'ALL' : s)}
                className="chip"
                style={
                  active
                    ? { background: st.fg, color: '#fff' }
                    : { background: st.bg, color: st.fg }
                }
                title={`Show ${st.label.toLowerCase()} and below`}
              >
                {st.label} {counts[s]}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!feed ? (
          <div className="p-6 text-center text-[12px]" style={{ color: 'var(--muted)' }}>
            Loading headlines…
          </div>
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-[12px]" style={{ color: 'var(--muted)' }}>
            Nothing matches that filter right now.
          </div>
        ) : (
          items.map((i) => <NewsRow key={i.id} item={i} onOpen={onOpen} />)
        )}
      </div>

      {feed && (
        <p className="px-3 py-1.5 text-[10px] shrink-0 border-t" style={{ color: 'var(--faint)', borderColor: 'var(--border)' }}>
          Impact = severity + relevance + positive sentiment + source tier + urgency, decayed by a
          per-class half-life. A strong negative story still scores high.
        </p>
      )}
    </div>
  );
}
