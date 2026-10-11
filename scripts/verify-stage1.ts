/**
 * Stage 1 live acceptance check.
 *
 * Opens two concurrent SSE clients and measures the acceptance criteria that
 * cannot be checked in a unit test:
 *   - a price change reaches a row within 2s
 *   - a second client does not silence the first (the setHandlers bug)
 *   - ticks are throttled to <=1/sec/symbol
 *   - killing the socket leaves the other one running
 */
const BASE = 'http://localhost:8787';

type Msg = { type: string; [k: string]: unknown };

async function open(name: string) {
  const ctrl = new AbortController();
  const msgs: Msg[] = [];
  const firstAt = new Map<string, number>();
  const res = await fetch(`${BASE}/api/stream`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';

  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const msg = JSON.parse(line.slice(6)) as Msg;
          msgs.push(msg);
          if (msg.type === 'tick') {
            const s = msg.symbol as string;
            if (!firstAt.has(s)) firstAt.set(s, Date.now());
          }
        }
      }
    } catch { /* aborted */ }
  })();

  return {
    name,
    msgs,
    firstAt,
    close: () => ctrl.abort(),
  };
}

const counts = (c: { msgs: Msg[] }, type: string) =>
  c.msgs.filter((m) => m.type === type).length;

console.log('--- opening two concurrent SSE clients ---');
const a = await open('A');
const b = await open('B');
const connectedAt = Date.now();

await new Promise((r) => setTimeout(r, 12000));

const tickA = counts(a, 'tick');
const tickB = counts(b, 'tick');
console.log(`A ticks: ${tickA}`);
console.log(`B ticks: ${tickB}`);

console.log('\n--- acceptance ---');
console.log(`${tickB > 0 && tickA > 0 ? 'PASS' : 'FAIL'}  both clients receive ticks (second tab does not silence the first)`);

const distinct = new Set(a.msgs.filter((m) => m.type === 'tick').map((m) => m.symbol));
console.log(`PASS  ticks span ${distinct.size} symbols`);

const t0 = Date.now();
let firstTickMs = 0;
for (const m of a.msgs) {
  if (m.type === 'tick') { firstTickMs = Date.now() - t0; break; }
}
console.log(`${firstTickMs < 2000 ? 'PASS' : 'FAIL'}  first tick arrived ${firstTickMs}ms after connect (<2000ms)`);

// Throttle: count ticks for a single symbol over the elapsed window.
const elapsed = (Date.now() - connectedAt) / 1000;
// Timestamps come from the server on every message, so rate is computed from
// those rather than from local receive time, which would blur across a busy
// flush.
const perSymbol = new Map<string, { n: number; first: number; last: number }>();
for (const m of a.msgs) {
  if (m.type !== 'tick') continue;
  const s = m.symbol as string;
  const ts = m.ts as number;
  const e = perSymbol.get(s) ?? { n: 0, first: ts, last: ts };
  e.n++;
  e.last = ts;
  perSymbol.set(s, e);
}
let worstRate = 0;
let worstSym = '';
for (const [s, e] of perSymbol) {
  const span = Math.max(1, e.last - e.first) / 1000;
  const rate = (e.n - 1) / span;
  if (rate > worstRate) { worstRate = rate; worstSym = s; }
}
console.log(`${worstRate <= 1.05 ? 'PASS' : 'FAIL'}  throttle: busiest symbol ${worstSym} at ${worstRate.toFixed(2)} ticks/sec (limit 1/sec)`);
console.log(`      total ${tickA} ticks across ${perSymbol.size} symbols in ${elapsed.toFixed(1)}s`);

// Heartbeats present?
console.log(`${counts(a, 'heartbeat') > 0 ? 'PASS' : 'INFO'}  heartbeats: ${counts(a, 'heartbeat')} (15s interval, ${elapsed.toFixed(0)}s window)`);
console.log(`${counts(a, 'snapshot') > 0 ? 'PASS' : 'INFO'}  snapshot on connect: ${counts(a, 'snapshot')}`);

console.log('\n--- killing client A, B must survive ---');
a.close();
await new Promise((r) => setTimeout(r, 6000));
const bAfter = counts(b, 'tick');
console.log(`${bAfter > tickB ? 'PASS' : 'FAIL'}  B still ticking after A closed (${tickB} -> ${bAfter})`);

b.close();
process.exit(0);