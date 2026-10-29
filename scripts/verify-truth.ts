/**
 * Truth check — do the numbers on the wire match the exchange, and does each
 * one carry an honest timestamp?
 *
 * `verify-stage1.ts` proves the STREAM behaves (two clients, throttle, latency).
 * This proves the VALUES are true:
 *
 *   1. Every ticked symbol's SSE price is compared against Binance's public
 *      REST ticker for the same symbol. A price that is not the exchange's is
 *      a lie regardless of how fresh the badge looks.
 *   2. Each tick carries a server `ts` that is close to the receive time, so
 *      "fresh" means fresh at the source, not merely fresh in the browser.
 *   3. Server timestamps advance: a symbol's newest tick is never older than
 *      the window, and prices are positive finite numbers.
 *   4. `/api/search` (the global coin search) returns the same live price the
 *      stream is carrying — the search must not invent a stale number of its own.
 *
 * STAGE 5 TIGHTENING
 *
 * The old check accepted a flat 0.5% on 8 symbols, which is loose enough to
 * pass a stream that is quietly a minute behind. Now:
 *
 *   - BTC/ETH/BNB/SOL must be within TRUTH_MAJOR_DELTA_PCT (default 0.03%).
 *   - Every other symbol must be within max(TRUTH_OTHER_DELTA_PCT, its own
 *     1-second price range). The range is the honest explanation for a delta:
 *     if the coin moved 0.4% within one second, a REST call taken a moment
 *     later is *supposed* to disagree by up to that much. Anything beyond it is
 *     a stale price, not timing.
 *   - At least TRUTH_MIN_SYMBOLS (default 25) symbols must be compared, with at
 *     least 5 of them outside the old hard-coded sample.
 *   - Latency is measured from the exchange's own event time (`E`) to the
 *     moment the client receives the tick, reported as p50/p95/max.
 *
 * Runs against a live stack:  npm run dev:api   (then)  npx tsx scripts/verify-truth.ts
 */
const BASE = process.env.ORDERFLOW_BASE ?? 'http://localhost:8787';
const WINDOW_MS = Number(process.env.TRUTH_WINDOW_MS ?? 20_000);
/** Fixed ceiling for the majors. */
const MAJOR_DELTA_PCT = Number(process.env.TRUTH_MAJOR_DELTA_PCT ?? 0.03);
/** Floor for every other symbol, widened by its own 1s range. */
const OTHER_DELTA_PCT = Number(process.env.TRUTH_OTHER_DELTA_PCT ?? 0.15);
const MIN_SYMBOLS = Number(process.env.TRUTH_MIN_SYMBOLS ?? 25);
const MIN_OUTSIDE_OLD = Number(process.env.TRUTH_MIN_OUTSIDE_OLD ?? 5);
const MAX_COMPARE = Number(process.env.TRUTH_MAX_COMPARE ?? 45);
/** A tick whose exchange `E` is older than this at receive time is not "live". */
const MAX_TICK_AGE_MS = 5_000;

const MAJORS = new Set(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT']);
const OLD_LIST = new Set(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'UNIUSDT', 'AAVEUSDT', 'LINKUSDT', 'DOGEUSDT']);

interface Tick { symbol: string; price: number; changePct: number; ts: number; E?: number }

async function collectStream(ms: number): Promise<{ ticks: Tick[]; receivedAt: Map<string, number[]> }> {
  const ctrl = new AbortController();
  const ticks: Tick[] = [];
  const receivedAt = new Map<string, number[]>();
  const res = await fetch(`${BASE}/api/stream`, { signal: ctrl.signal });
  if (!res.body) throw new Error('no response body');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  const pump = (async () => {
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
          let msg: { type?: string };
          try { msg = JSON.parse(line.slice(6)); } catch { continue; }
          if (msg.type === 'tick') {
            const t = msg as unknown as Tick;
            ticks.push(t);
            const arr = receivedAt.get(t.symbol) ?? [];
            arr.push(Date.now());
            receivedAt.set(t.symbol, arr);
          }
        }
      }
    } catch { /* aborted */ }
  })();

  await new Promise((r) => setTimeout(r, ms));
  ctrl.abort();
  await pump.catch(() => {});
  return { ticks, receivedAt };
}

async function binanceRest(symbol: string): Promise<number | null> {
  // Same public host the server's data layer uses (`data-api.binance.vision`),
  // so the comparison is not made against a different mirror/region.
  try {
    const r = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { price?: string };
    const p = Number(j.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

function pct(a: number, b: number): number {
  return Math.abs(a - b) / ((a + b) / 2) * 100;
}

/** Widest high-low within any one-second span, as a percent of the mid. */
function range1sPct(ticks: Tick[]): number {
  let best = 0;
  for (let i = 0; i < ticks.length; i++) {
    let lo = ticks[i].price;
    let hi = ticks[i].price;
    for (let j = i; j < ticks.length && ticks[j].ts - ticks[i].ts <= 1000; j++) {
      lo = Math.min(lo, ticks[j].price);
      hi = Math.max(hi, ticks[j].price);
    }
    const mid = (hi + lo) / 2;
    if (mid > 0) best = Math.max(best, ((hi - lo) / mid) * 100);
  }
  return best;
}

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const fails: string[] = [];
const line = (ok: boolean, text: string) => {
  if (!ok) fails.push(text);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`);
};

(async () => {
  console.log(`--- truth check against ${BASE} (${(WINDOW_MS / 1000).toFixed(0)}s window) ---`);
  const { ticks, receivedAt } = await collectStream(WINDOW_MS);

  if (ticks.length === 0) {
    console.log('FAIL  no ticks received — is the live API running and connected?');
    process.exit(1);
  }

  // 1. Sanity of every tick: finite, positive price and change, present ts.
  const bad = ticks.filter((t) =>
    !Number.isFinite(t.price) || t.price <= 0 ||
    !Number.isFinite(t.changePct) || !Number.isFinite(t.ts));
  line(bad.length === 0, `all ${ticks.length} ticks carry a finite price, change and ts` + (bad.length ? ` (${bad.length} bad)` : ''));

  const bySym = new Map<string, Tick[]>();
  for (const t of ticks) {
    const arr = bySym.get(t.symbol) ?? [];
    arr.push(t);
    bySym.set(t.symbol, arr);
  }

  // 2. Freshness at the source: newest tick's ts vs receive time.
  let worstAge = 0;
  let worstAgeSym = '';
  for (const [sym, arr] of bySym) {
    const age = receivedAt.get(sym)!.at(-1)! - arr.at(-1)!.ts;
    if (age > worstAge) { worstAge = age; worstAgeSym = sym; }
  }
  line(worstAge <= MAX_TICK_AGE_MS,
    `newest tick is at most ${MAX_TICK_AGE_MS}ms old at receive (worst ${worstAge}ms on ${worstAgeSym})`);

  // 3. Timestamps advance per symbol (monotonic, never older than the window).
  let nonMonotonic = 0;
  for (const arr of bySym.values()) {
    for (let i = 1; i < arr.length; i += 1) if (arr[i].ts < arr[i - 1].ts) nonMonotonic += 1;
  }
  line(nonMonotonic === 0, `server timestamps advance per symbol (${nonMonotonic} regressions)`);

  // 4. The real check: SSE price vs the exchange's own REST ticker.
  const ranked = [...bySym.entries()].sort((a, b) => b[1].length - a[1].length);
  const chosen = ranked
    .map(([sym]) => sym)
    .filter((sym) => MAJORS.has(sym) || true)
    .slice(0, MAX_COMPARE);

  console.log(`\n--- wire price vs Binance REST (${chosen.length} symbols, majors <= ${MAJOR_DELTA_PCT}%) ---`);
  let compared = 0;
  let unavailable = 0;
  let outsideOld = 0;
  let worstRatio = 0;
  let worstRatioText = '';
  let majorFails = 0;

  for (const sym of chosen) {
    const arr = bySym.get(sym)!;
    const ours = arr.at(-1)!.price;
    const theirs = await binanceRest(sym);
    if (theirs === null) { unavailable += 1; continue; }

    const d = pct(ours, theirs);
    const range = range1sPct(arr);
    const limit = MAJORS.has(sym) ? MAJOR_DELTA_PCT : Math.max(OTHER_DELTA_PCT, range);
    const ratio = d / limit;
    compared += 1;
    if (!OLD_LIST.has(sym)) outsideOld += 1;
    if (ratio > worstRatio) { worstRatio = ratio; worstRatioText = sym; }
    if (ratio > 1 && MAJORS.has(sym)) majorFails += 1;

    console.log(
      `  ${sym.padEnd(12)} ours ${String(ours).padEnd(14)} REST ${String(theirs).padEnd(14)} ` +
      `Δ ${d.toFixed(4)}%  1s-range ${range.toFixed(4)}%  limit ${limit.toFixed(4)}%  ${ratio <= 1 ? 'ok' : 'OVER'}`,
    );
  }

  if (compared === 0) {
    console.log('FAIL  could not compare any symbol against Binance REST (network/ban?)');
    fails.push('no REST comparisons');
  } else {
    line(compared >= MIN_SYMBOLS, `compared ${compared} symbols (need >= ${MIN_SYMBOLS})`);
    line(outsideOld >= MIN_OUTSIDE_OLD, `${outsideOld} compared symbols are outside the old 8-symbol list (need >= ${MIN_OUTSIDE_OLD})`);
    line(worstRatio <= 1, `every symbol within its allowance (worst ${(worstRatio * 100).toFixed(0)}% of limit on ${worstRatioText})`);
    if (majorFails > 0) console.log(`INFO  ${majorFails} major(s) exceeded the ${MAJOR_DELTA_PCT}% ceiling`);
  }
  if (unavailable > 0) console.log(`INFO  ${unavailable} symbols had no REST quote (rate limit or no pair)`);

  // 5. Latency: the exchange's own event time `E` -> the moment this client
  //    received the tick. The server coalesces ticks on a 1s flush, so expect
  //    roughly one flush interval plus network; the distribution is the point.
  console.log('\n--- exchange E -> client receive latency ---');
  const latencies: number[] = [];
  for (const [sym, arr] of bySym) {
    if (!MAJORS.has(sym) && latencies.length > 400) break;
    const times = receivedAt.get(sym)!;
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i].E;
      if (e && e > 0) {
        const lat = times[i] - e;
        if (lat >= 0 && lat < 30_000) latencies.push(lat);
      }
    }
  }
  if (latencies.length === 0) {
    console.log('INFO  no ticks carried an exchange E field; latency not measurable');
  } else {
    latencies.sort((a, b) => a - b);
    const p50 = quantile(latencies, 0.5);
    const p95 = quantile(latencies, 0.95);
    const max = latencies.at(-1)!;
    console.log(`  n=${latencies.length}  p50=${p50.toFixed(0)}ms  p95=${p95.toFixed(0)}ms  max=${max}ms`);
    line(p95 < 5_000, `p95 exchange->client latency under 5s (${p95.toFixed(0)}ms)`);
  }

  // 6. Global search must carry the same live price the stream has. The search
  //    now indexes every exchange symbol, so compare against symbols the stream
  //    is actually carrying.
  console.log('\n--- global search price consistency ---');
  const searchSyms = [...chosen].slice(0, 4);
  for (const sym of searchSyms) {
    const base = sym.replace(/USDT$/, '');
    const arr = bySym.get(sym);
    if (!arr) continue;
    try {
      const r = await fetch(`${BASE}/api/search?q=${encodeURIComponent(base)}`);
      const j = (await r.json()) as { hits: { base: string; kind?: string; price: number | null; ageMs: number | null }[] };
      const hit = j.hits.find((h) => h.base === base && h.kind !== 'perp') ?? j.hits.find((h) => h.base === base);
      if (!hit) { line(false, `search(${base}) returned no hit for a streamed symbol`); continue; }
      if (hit.price == null) { line(false, `search(${base}) hit has null price while streaming`); continue; }
      const stream = arr.at(-1)!.price;
      const d = pct(hit.price, stream);
      line(d <= Math.max(OTHER_DELTA_PCT, range1sPct(arr)), `search(${base}) price ${hit.price} matches stream ${stream} (Δ ${d.toFixed(4)}%, age ${hit.ageMs}ms)`);
    } catch (e) {
      line(false, `search(${base}) failed: ${(e as Error).message}`);
    }
  }

  console.log(`\n--- summary: ${fails.length === 0 ? 'ALL CHECKS PASS' : `${fails.length} FAILURE(S)`} ---`);
  for (const f of fails) console.log(`  • ${f}`);
  process.exit(fails.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('verify-truth crashed:', e);
  process.exit(1);
});
