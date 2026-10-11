import { useEffect, useMemo, useState } from 'react';
import type { JournalTrade } from '../../shared/types';
import { fmtPrice } from '../lib/format';
import { Chip } from './ui';

const KEY = 'orderflow:journal:v1';

function load(): JournalTrade[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as JournalTrade[]) : [];
  } catch {
    return [];
  }
}

function save(trades: JournalTrade[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(trades));
  } catch {
    /* storage full or blocked */
  }
}

const SETUP_TAGS = ['Order block', 'Break & retest', 'Liquidity sweep', 'News catalyst', 'Range fade', 'Other'];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Calendar heatmap of daily P&L. Each cell is one trading day. */
function PnlHeatmap({ trades }: { trades: JournalTrade[] }) {
  const days = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const t of trades) {
      if (t.pnl === null) continue;
      const day = t.to || t.from;
      byDay.set(day, (byDay.get(day) ?? 0) + t.pnl);
    }
    const entries = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (!entries.length) return [];

    const end = new Date(`${entries[entries.length - 1][0]}T00:00:00Z`);
    const start = new Date(`${entries[0][0]}T00:00:00Z`);
    // Pad to whole weeks starting Monday.
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    end.setUTCDate(end.getUTCDate() + (6 - ((end.getUTCDay() + 6) % 7)));

    const cells: { date: string; pnl: number | null }[] = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      cells.push({ date: iso, pnl: byDay.get(iso) ?? null });
    }
    return cells;
  }, [trades]);

  if (!days.length) return null;

  const max = Math.max(...days.map((d) => Math.abs(d.pnl ?? 0)), 1);

  return (
    <div className="px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--faint)' }}>
        Daily P&amp;L
      </div>
      <div
        className="grid gap-[3px]"
        style={{ gridTemplateRows: 'repeat(7, 12px)', gridAutoFlow: 'column', gridAutoColumns: '12px' }}
      >
        {days.map((d) => {
          if (d.pnl === null) {
            return <div key={d.date} style={{ background: 'var(--panel-2)', borderRadius: 2 }} />;
          }
          const intensity = Math.min(1, Math.abs(d.pnl) / max);
          const up = d.pnl >= 0;
          return (
            <div
              key={d.date}
              title={`${d.date}: ${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}`}
              style={{
                background: up ? 'rgba(22,163,74,0.85)' : 'rgba(220,38,38,0.85)',
                opacity: 0.25 + intensity * 0.75,
                borderRadius: 2,
              }}
            />
          );
        })}
      </div>
      <div className="flex justify-between mt-1.5 text-[9px] mono" style={{ color: 'var(--faint)' }}>
        <span>{days[0].date}</span>
        <span>{days[days.length - 1].date}</span>
      </div>
    </div>
  );
}

export function Journal() {
  const [trades, setTrades] = useState<JournalTrade[]>(load);
  const [form, setForm] = useState({
    symbol: 'BTCUSDT',
    side: 'bullish' as 'bullish' | 'bearish',
    qty: 1,
    entry: 0,
    exit: null as number | null,
    setupTag: SETUP_TAGS[0],
    note: '',
  });

  useEffect(() => save(trades), [trades]);

  const stats = useMemo(() => {
    const closed = trades.filter((t) => t.pnl !== null);
    const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
    const losses = closed.filter((t) => (t.pnl ?? 0) < 0);
    const grossWin = wins.reduce((a, t) => a + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + (t.pnl ?? 0), 0));
    return {
      count: closed.length,
      total: closed.reduce((a, t) => a + (t.pnl ?? 0), 0),
      winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
      expectancy: closed.length ? closed.reduce((a, t) => a + (t.pnl ?? 0), 0) / closed.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    };
  }, [trades]);

  const add = () => {
    if (!form.symbol || !form.entry) return;
    const pnl =
      form.exit !== null && form.qty
        ? (form.exit - form.entry) * form.qty * (form.side === 'bullish' ? 1 : -1)
        : null;
    const t: JournalTrade = {
      id: crypto.randomUUID(),
      symbol: form.symbol.toUpperCase(),
      side: form.side,
      qty: form.qty,
      entry: form.entry,
      exit: form.exit,
      from: todayISO(),
      to: form.exit !== null ? todayISO() : todayISO(),
      setupTag: form.setupTag,
      note: form.note,
      openedAt: Date.now(),
      closedAt: form.exit !== null ? Date.now() : null,
      pnl,
      signalId: null,
      netAfterTax: null,
    };
    setTrades((x) => [t, ...x]);
    setForm((f) => ({ ...f, exit: null, note: '' }));
  };

  const input =
    'w-full px-2 py-1.5 rounded-md text-[12px] mono border outline-none focus:ring-1 focus:ring-[var(--accent)]';
  const inputStyle = {
    background: 'var(--panel-2)',
    borderColor: 'var(--border)',
    color: 'var(--text)',
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 space-y-3">
        <div className="grid grid-cols-4 gap-px rounded-lg overflow-hidden" style={{ background: 'var(--border)' }}>
          <Stat label="Net P&L" value={`${stats.total >= 0 ? '+' : ''}${stats.total.toFixed(2)}`} color={stats.total >= 0 ? 'var(--color-up)' : 'var(--color-down)'} />
          <Stat label="Win rate" value={`${stats.winRate.toFixed(0)}%`} />
          <Stat label="Expectancy" value={stats.expectancy.toFixed(2)} />
          <Stat
            label="Profit factor"
            value={stats.profitFactor === Infinity ? 'âˆž' : stats.profitFactor.toFixed(2)}
            color={stats.profitFactor >= 1.5 ? 'var(--color-up)' : stats.profitFactor < 1 ? 'var(--color-down)' : undefined}
          />
        </div>

        <div className="rounded-lg p-2" style={{ background: 'var(--panel-2)' }}>
          <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--faint)' }}>
            Log a trade
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              className={input}
              style={inputStyle}
              placeholder="Symbol"
              value={form.symbol}
              onChange={(e) => setForm({ ...form, symbol: e.target.value })}
            />
            <select
              className={input}
              style={inputStyle}
              value={form.side}
              onChange={(e) => setForm({ ...form, side: e.target.value as 'bullish' | 'bearish' })}
            >
              <option value="bullish">Long</option>
              <option value="bearish">Short</option>
            </select>
            <input
              className={input}
              style={inputStyle}
              type="number"
              step="any"
              placeholder="Qty"
              value={form.qty || ''}
              onChange={(e) => setForm({ ...form, qty: Number(e.target.value) || 0 })}
            />
            <input
              className={input}
              style={inputStyle}
              type="number"
              step="any"
              placeholder="Entry"
              value={form.entry || ''}
              onChange={(e) => setForm({ ...form, entry: Number(e.target.value) || 0 })}
            />
            <input
              className={input}
              style={inputStyle}
              type="number"
              step="any"
              placeholder="Exit (blank = open)"
              value={form.exit ?? ''}
              onChange={(e) => setForm({ ...form, exit: e.target.value === '' ? null : Number(e.target.value) })}
            />
            <select
              className={input}
              style={inputStyle}
              value={form.setupTag}
              onChange={(e) => setForm({ ...form, setupTag: e.target.value })}
            >
              {SETUP_TAGS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <input
            className={`${input} mt-2`}
            style={inputStyle}
            placeholder="Note â€” what did you see?"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
          <button
            type="button"
            onClick={add}
            className="mt-2 w-full py-1.5 rounded-md text-[12px] font-semibold text-white"
            style={{ background: 'var(--accent)' }}
          >
            Add to journal
          </button>
        </div>

        {stats.count > 0 && (
          <div className="rounded-lg" style={{ background: 'var(--panel-2)' }}>
            <PnlHeatmap trades={trades} />
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>
              {trades.length} trades
            </span>
            {trades.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (confirm('Clear the whole journal?')) setTrades([]);
                }}
                className="text-[10px]"
                style={{ color: 'var(--faint)' }}
              >
                Clear all
              </button>
            )}
          </div>

          {trades.length === 0 ? (
            <p className="text-[11px] py-4 text-center" style={{ color: 'var(--muted)' }}>
              No trades logged yet. A month of honest entries is worth more than any indicator.
            </p>
          ) : (
            trades.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-2 py-1.5 border-b last:border-0"
                style={{ borderColor: 'var(--border)' }}
              >
                <span className="font-semibold text-[12px] w-24 truncate">{t.symbol}</span>
                <Chip color={t.side === 'bullish' ? 'var(--color-up)' : 'var(--color-down)'}>
                  {t.side === 'bullish' ? 'Long' : 'Short'}
                </Chip>
                <span className="mono text-[11px]" style={{ color: 'var(--muted)' }}>
                  {fmtPrice(t.entry)}
                  {t.exit !== null && ` â†’ ${fmtPrice(t.exit)}`}
                  <span className="ml-1">Ã—{t.qty}</span>
                </span>
                <span
                  className={`mono text-[12px] font-semibold ml-auto ${(t.pnl ?? 0) >= 0 ? 'up' : 'down'}`}
                >
                  {t.pnl === null ? 'open' : `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}`}
                </span>
                <span className="text-[10px]" style={{ color: 'var(--faint)' }}>
                  {t.setupTag}
                </span>
                <button
                  type="button"
                  onClick={() => setTrades((x) => x.filter((y) => y.id !== t.id))}
                  className="text-[13px] leading-none px-1"
                  style={{ color: 'var(--faint)' }}
                  aria-label="Delete trade"
                >
                  Ã—
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="px-2 py-1.5" style={{ background: 'var(--panel)' }}>
      <div className="text-[9px] uppercase tracking-wider truncate" style={{ color: 'var(--faint)' }}>
        {label}
      </div>
      <div className="mono text-[13px] font-semibold" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}
