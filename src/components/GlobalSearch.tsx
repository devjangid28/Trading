import { useEffect, useRef, useState } from 'react';
import { api, type SearchHit } from '../lib/api';
import { fmtPct, fmtPrice } from '../lib/format';

const DEBOUNCE_MS = 220;

/**
 * Global coin search, mounted in the app header.
 *
 * Searches the whole tracked universe — not just the rows on the current
 * board — over the server's `/api/search`, which attaches the newest exchange
 * price and change where one has arrived. That makes the search a place to go
 * when a coin is NOT on the board, rather than a duplicate of the row list it
 * is already visible next to.
 *
 * Behaviours:
 *   - debounced query, aborted in-flight request on keystroke
 *   - keyboard nav (Up/Down/Enter/Escape), mouse hover mirrors the active row
 *   - Enter opens the winning hit via the app's open-symbol path
 *   - `price === null` (exchange has not ticked the symbol yet) renders a dash,
 *     never an invented number — same Rule 2 as everywhere else
 */
export function GlobalSearch({ onOpen }: { onOpen: (base: string) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);

  // "/" or Ctrl+K focuses the search from anywhere, unless the user is already
  // typing in a field. This is the shortcut traders expect from every terminal,
  // and it is what makes "search for a coin that is not on the board" a
  // first-class action rather than a scroll-and-hunt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (typing) return;
      if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    abort.current?.abort();
    if (!q.trim()) {
      setOpen(false);
      setHits(null);
      setSearching(false);
      setError(null);
      return;
    }
    setOpen(true);
    setError(null);
    setSearching(true);
    timer.current = setTimeout(() => {
      const ctl = new AbortController();
      abort.current = ctl;
      api
        .search(q.trim(), ctl.signal)
        .then((r) => {
          setHits(r.hits);
          setSearching(false);
          setActive(0);
        })
        .catch((e: unknown) => {
          const err = e as Error;
          if (err?.name === 'AbortError') return; // superseded by a newer keypress
          setError('Search unavailable');
          setHits([]);
          setSearching(false);
        });
    }, DEBOUNCE_MS);
  }, [q]);

  // Close when the user clicks anywhere outside the box.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const list = hits ?? [];

  const openHit = (hit: SearchHit) => {
    setOpen(false);
    setQ('');
    setHits(null);
    onOpen(hit.base);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Escape must close whatever is open even before (or without) any results:
    // during the debounce window the list is empty, and a panel that ignores
    // Escape reads as a stuck UI.
    if (e.key === 'Escape') {
      setOpen(false);
      setHits(null);
      return;
    }
    if (!open || list.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % list.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + list.length) % list.length);
    } else if (e.key === 'Enter') {
      const hit = list[active];
      if (hit) {
        e.preventDefault();
        openHit(hit);
      }
    }
  };

  return (
    <div className="global-search" ref={boxRef}>
      <input
        ref={inputRef}
        data-testid="global-search"
        className="global-search-input"
        placeholder="Search all coins  ( / )"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => q.trim() && setOpen(true)}
        aria-label="Search all coins"
        role="combobox"
        aria-expanded={open}
        aria-controls="global-search-results"
        aria-activedescendant={open && list[active] ? `search-hit-${list[active].pair ?? list[active].base}` : undefined}
      />
      {open && (
        <div
          id="global-search-results"
          className="global-search-results"
          data-testid="search-results"
          role="listbox"
        >
          {searching && <div className="global-search-note">Searching…</div>}
          {!searching && !error && list.length === 0 && (
            <div className="global-search-note">No matches for “{q.trim()}”</div>
          )}
          {error && <div className="global-search-note">{error}</div>}
          {!searching &&
            list.map((hit, i) => (
              <button
                key={hit.pair ?? hit.base}
                id={`search-hit-${hit.pair ?? hit.base}`}
                data-testid="search-hit"
                data-base={hit.base}
                data-on-board={hit.onBoard ? 'yes' : 'no'}
                role="option"
                aria-selected={i === active}
                className={`global-search-hit ${i === active ? 'is-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => openHit(hit)}
              >
                <span className="global-search-hit-ticker">{hit.displayTicker}</span>
                {hit.kind === 'perp' && (
                  <span
                    style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: 0.4, padding: '1px 4px',
                      borderRadius: 4, background: 'var(--panel-2)', color: 'var(--muted)',
                    }}
                    title="Perpetual futures market (no spot tick on this board)"
                  >
                    PERP
                  </span>
                )}
                <span className="global-search-hit-name">{hit.name}</span>
                {!hit.onBoard && (
                  <span
                    data-testid="search-off-board"
                    style={{ fontSize: 9.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}
                    title="This coin is not on today's bullish/bearish board. Opening it shows its chart."
                  >
                    Not on the board
                  </span>
                )}
                <span className="global-search-hit-price">
                  {hit.price != null ? fmtPrice(hit.price) : '—'}
                  {hit.changePct != null && (
                    <span className={hit.changePct >= 0 ? 'is-up' : 'is-down'}>
                      {fmtPct(hit.changePct)}
                    </span>
                  )}
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}