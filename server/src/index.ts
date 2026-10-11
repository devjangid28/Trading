import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { forceScan, getScan, warmScan, currentScan } from './engine/scanner.js';
import { fetchAllNews } from './data/rss.js';
import { buildFeed } from './engine/news/score.js';
import { macroState } from './data/macro.js';
import { indianMarket } from './data/nse.js';
import { yahooChartCached } from './data/yahoo.js';
import { fetchKlines } from './data/binance.js';
import { detectOrderBlock, averageRange, choppiness, strengthScore, percentileOf } from './engine/orderblock.js';
import { attribute, rollingBeta } from './engine/attribution.js';
import { UNIVERSE_BY_BASE } from './data/universe.js';
import { cacheStats } from './lib/cache.js';
import { formatIst, IST_OFFSET_MIN } from './lib/time.js';
import { LiveIngest } from './live/ingest.js';
import { buildDerivatives } from './data/derivatives/build.js';
import { dbSizeBytes, gapSummary, lastProcessedCandleAt, listSignals, ledgerStats, openSignals, signalCount, DB_PATH } from './ledger/store.js';
import { backfillOnStartup } from './ledger/backfill.js';
import { eventCalendar, nextTier1 } from './data/calendar.js';
import { freezeFromScan, startLedgerWorker } from './ledger/worker.js';
import { LIVE } from './config.js';
import * as streamHub from './live/streamHub.js';
import { cached } from './lib/cache.js';
import type {
  Attribution, Candle, NewsFeed, ScanResult, StreamMsg,
} from '../../shared/types.js';

const LIVE_HEARTBEAT_MS = LIVE.SSE_HEARTBEAT_MS;

/**
 * Trailing debounce for the close-triggered rescan. Long enough to coalesce
 * every symbol's close, short enough that the board is fresh almost
 * immediately after the bar.
 */
const RESCAN_DEBOUNCE_MS = 900;

// ── Live ingest (Phase 1) ────────────────────────────────────────────
const streamSymbols = [...new Set(
  [...UNIVERSE_BY_BASE.keys()].map((b) => `${b}USDT`),
)];

/**
 * Single registration point for the ingest handlers.
 *
 * The tick and kline-close hooks are passed straight through because they are
 * per-process concerns (coalescing, debouncing) rather than per-subscriber
 * concerns. Only liq and status are broadcast by the hub, because those are
 * meaningful to every connected client and are low frequency.
 */
streamHub.setIngestHandlers({
  onTick: (symbol, price, changePct) => {
    // Coalesced; streamHub flushes once per second so a symbol that ticks 40
    // times in that window still yields exactly one update, with the newest
    // price rather than whichever arrived first.
    streamHub.stageTick(symbol, price, changePct);
  },
  onKlineClose: (symbol) => {
    // The board re-ranks on candle close. Running the scan here rather than on
    // a timer is what makes "re-ranks without refresh" true: the rank changes
    // exactly when the underlying 5m bar changes.
    void onCandleClosed(symbol);
  },
});

const live = new LiveIngest(streamSymbols.slice(0, LIVE.MAX_STREAMS_PER_CONN), {
  ...streamHub.ingestHandlers(),
});

live.start();


// Load .env if present. Every value in it is optional — the app runs keyless.
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    console.warn('[orderflow] could not read .env, continuing with defaults');
  }
}

const PORT = Number(process.env.PORT ?? 8787);
const app = express();
app.use(compression());
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.get('/api/derivatives', async (_req, res) => {
  try {
    const result = await derivativesWithCache();
    res.json(result);
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

const derivativesWithCache = () =>
  cached('api:derivatives', 30_000, () =>
    buildDerivatives(
      live
        ? {
            candles: (s: string) => fetchKlines(s, '5m', 60),
            liqTally: (s: string) =>
              live.liquidations.tally(s, 3, 20),
          }
        : undefined,
    ),
  );

app.get('/api/liquidations', (req, res) => {
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.toUpperCase() : null;
  res.json({
    recent: live ? live.liquidations.recent(symbol, 60) : [],
    note: 'Sampled from !forceOrder@arr, which pushes at most one liquidation per symbol per second. Totals are a LOWER BOUND.',
    asOf: Date.now(),
  });
});

/**
 * Phase 1 — Server-Sent Events.
 *
 * A full snapshot on connect, then deltas. Polling stays as the fallback so a
 * proxy that strips SSE still works.
 */
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Tell EventSource how long to wait before reconnecting, so a server restart
  // is recovered from in seconds rather than the browser's default ~3s of
  // jittered backoff stacking up.
  res.write('retry: 2000\n\n');

  const send = (msg: StreamMsg) => {
    res.write(`data: ${JSON.stringify(msg)}\n\n`);
  };

  send({ type: 'status', connection: live.statuses(), ts: Date.now() });
  const existing = currentScan();
  if (existing) {
    send({
      type: 'snapshot',
      scan: existing,
      derivatives: [],
      regime: existing.regime,
      blackedOut: existing.blackedOut,
      ts: Date.now(),
    });
  }

  const heartbeat = setInterval(() => {
    send({ type: 'heartbeat', ts: Date.now() });
  }, LIVE_HEARTBEAT_MS);

  const unsubscribe = streamHub.subscribe(send);

  let closed = false;
  req.on('close', () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

app.get('/api/ledger', (req, res) => {
  const shadow = req.query.shadow === 'shadow' ? true
    : req.query.shadow === 'real' ? false
      : 'all';
  try {
    const signals = listSignals(200, shadow);
    res.json({
      updatedAt: Date.now(),
      signals,
      stats: ledgerStats(shadow),
      open: openSignals().length,
      counts: signalCount(),
    });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/calendar', async (_req, res) => {
  try {
    const cal = await eventCalendar();
    res.json({ ...cal, nextTier1: nextTier1(cal.events, Date.now()) });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ist: formatIst(Date.now()),
    istOffsetMin: IST_OFFSET_MIN,
    cache: cacheStats(),
    uptimeSec: Math.round(process.uptime()),

    // Stage 8 — the diagnostics you actually need when the app has been up
    // overnight and something looks wrong. Each one answers a question that
    // used to require attaching a debugger.
    live: {
      ...streamHub.streamStats(),
      /** ms since the last flushed tick; >5s means the sockets are dead. */
      lastTickAgeSec: streamHub.lastTickAt()
        ? Math.round((Date.now() - streamHub.lastTickAt()) / 1000)
        : null,
      sockets: live.statuses(),
    },
    ledger: (() => {
      try {
        const counts = signalCount();
        return {
          dbPath: DB_PATH,
          dbSizeBytes: dbSizeBytes(),
          total: counts.total,
          open: counts.open,
          resolved: counts.resolved,
          shadow: counts.shadow,
          lastProcessedCandleAt: lastProcessedCandleAt(),
          gaps: gapSummary(),
        };
      } catch (err) {
        return { error: (err as Error).message };
      }
    })(),
    process: {
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      node: process.version,
    },
  });
});

/**
 * Recompute and push the board when a 5m candle closes.
 *
 * Debounced rather than per-symbol: a single close fires for every tracked
 * pair within a second of each other, and each close alone would trigger a
 * full multi-timeframe + derivatives scan. Coalescing into one trailing run
 * means one scan per close boundary instead of ~90.
 */
let rescanTimer: NodeJS.Timeout | null = null;
let rescanQueued = false;

async function onCandleClosed(symbol: string): Promise<void> {
  if (rescanTimer) {
    rescanQueued = true;
    return;
  }
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    void (async () => {
      try {
        // A candle just closed, so the board must be recomputed from live data,
        // not served from the cache or the persisted snapshot.
        const scan = await forceScan();
        freezeFromScan([...scan.bullish, ...scan.bearish], scan.updatedAt);
        streamHub.send({ type: 'scan', scan, ts: Date.now() });
      } catch (err) {
        console.warn(`[stream] rescan after ${symbol} close failed: ${(err as Error).message}`);
      } finally {
        if (rescanQueued) {
          rescanQueued = false;
          void onCandleClosed(symbol);
        }
      }
    })();
  }, RESCAN_DEBOUNCE_MS);
}

app.get('/api/scan', async (_req, res) => {
  try {
    const scan = await getScan();
    // Freeze whatever is worth recording BEFORE responding, so the ledger is
    // current the moment the client renders. A stale (cached or persisted)
    // board is skipped: its levels are not current, so freezing them would
    // record trades the market has already moved past.
    if (!scan.stale) {
      const frozen = freezeFromScan([...scan.bullish, ...scan.bearish], scan.updatedAt);
      if (frozen.frozen > 0) {
        console.log(
          `[ledger] froze ${frozen.frozen} (${frozen.real} real, ${frozen.shadow} shadow), ` +
          `${frozen.skippedExisting} already open`,
        );
      }
    }
    res.json(scan);
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/news', async (_req, res) => {
  try {
    const articles = await fetchAllNews();
    const items = buildFeed(articles, Date.now());
    const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, NOISE: 0 };
    for (const i of items) counts[i.severityClass]++;
    const catMap = new Map<string, number>();
    for (const i of items) for (const c of i.categories) catMap.set(c, (catMap.get(c) ?? 0) + 1);
    const feed: NewsFeed = {
      updatedAt: Date.now(),
      items: items.slice(0, 120),
      counts,
      clusters: [],
      byCategory: [...catMap.entries()]
        .map(([category, count]) => ({ category: category as NewsFeed['byCategory'][number]['category'], count }))
        .sort((a, b) => b.count - a.count),
    };
    res.json(feed);
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/macro', async (_req, res) => {
  try {
    res.json(await macroState());
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/india', async (_req, res) => {
  try {
    res.json(await indianMarket());
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

/** Per-asset chart + setup. Works for crypto pairs and Indian NSE symbols. */
app.get('/api/asset/:id', async (req, res) => {
  const id = req.params.id.toUpperCase();
  try {
    const isCrypto = id.endsWith('USDT') || UNIVERSE_BY_BASE.has(id.replace(/USDT$/, ''));
    const base = id.replace(/USDT$/, '');
    const pair = `${base}USDT`;
    const meta = UNIVERSE_BY_BASE.get(base);

    let candles: Candle[];
    if (isCrypto) {
      candles = await fetchKlines(pair, '5m', 320);
    } else {
      const chart = await yahooChartCached(`${id}.NS`, '5m', '5d', 60_000);
      if (!chart) {
        res.status(404).json({ error: `No data for ${id}` });
        return;
      }
      candles = chart.candles;
    }

    const closed = candles.filter((c) => c.closed);
    if (closed.length < 30) {
      res.status(404).json({ error: `Not enough closed candles for ${id}` });
      return;
    }

    const setup = detectOrderBlock(candles, { range: averageRange(closed, 20) });
    const last = candles[candles.length - 1];
    const dayAgo = candles[Math.max(0, candles.length - 289)];
    const changePct = dayAgo.c > 0 ? ((last.c - dayAgo.c) / dayAgo.c) * 100 : 0;
    const side = changePct >= 0 ? 'bullish' : 'bearish';
    const directionalSetup =
      setup && setup.side === side
        ? setup
        : detectOrderBlock(candles, { range: averageRange(closed, 20), prefer: side });
    const dayHigh = Math.max(...closed.slice(-289).map((c) => c.h));
    const dayLow = Math.min(...closed.slice(-289).map((c) => c.l));
    const rangePct = dayLow > 0 ? ((dayHigh - dayLow) / last.c) * 100 : 0;

    res.json({
      id,
      pair: isCrypto ? pair : id,
      name: meta?.name ?? id,
      sector: meta?.sector ?? (isCrypto ? 'Crypto' : 'Indian equity'),
      candles,
      setup: directionalSetup,
      side,
      choppiness: choppiness(closed),
      strength: strengthScore(changePct, rangePct),
      rangePct: Math.round(rangePct * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      price: last.c,
      updatedAt: Date.now(),
    });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

/** Attribute an asset's move to recent news. */
app.get('/api/attribution/:id', async (req, res) => {
  const id = req.params.id.toUpperCase().replace(/USDT$/, '');
  const horizon = Math.min(240, Math.max(5, Number(req.query.horizon ?? 60)));
  try {
    const [articles, assetK, btcK] = await Promise.all([
      fetchAllNews(),
      fetchKlines(`${id}USDT`, '5m', 400),
      fetchKlines('BTCUSDT', '5m', 400),
    ]);

    const news = buildFeed(articles, Date.now());
    const assetCloses = assetK.map((c) => c.c);
    const btcCloses = btcK.map((c) => c.c);
    const periods = Math.round(horizon / 5);

    const btcReturnPct =
      btcCloses.length > periods && btcCloses[btcCloses.length - 1 - periods] > 0
        ? ((btcCloses[btcCloses.length - 1] - btcCloses[btcCloses.length - 1 - periods]) /
            btcCloses[btcCloses.length - 1 - periods]) * 100
        : 0;

    const beta = rollingBeta(assetCloses, btcCloses, periods);
    const meta = UNIVERSE_BY_BASE.get(id);

    const result: Attribution | null = attribute(
      id,
      meta?.name ?? id,
      assetK,
      news,
      { horizonMinutes: horizon, btcBeta: beta, btcReturnPct },
    );

    res.json({ attribution: result, beta, btcReturnPct: Math.round(btcReturnPct * 100) / 100 });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

/** Full market attribution for every coin currently on the board. */
app.get('/api/attribution', async (_req, res) => {
  try {
    const [articles, scan] = await Promise.all([fetchAllNews(), getScan()]);
    const news = buildFeed(articles, Date.now());

    const symbols = [
      'BTC', 'ETH', 'SOL',
      ...scan.bullish.slice(0, 6).map((r) => r.base),
      ...scan.bearish.slice(0, 6).map((r) => r.base),
    ].filter((v, i, a) => a.indexOf(v) === i);

    const horizon = 60;
    const btcK = await fetchKlines('BTCUSDT', '5m', 400);
    const btcCloses = btcK.map((c) => c.c);
    const periods = Math.round(horizon / 5);
    const btcReturnPct =
      btcCloses.length > periods && btcCloses[btcCloses.length - 1 - periods] > 0
        ? ((btcCloses[btcCloses.length - 1] - btcCloses[btcCloses.length - 1 - periods]) /
            btcCloses[btcCloses.length - 1 - periods]) * 100
        : 0;

    const out: Attribution[] = [];
    const CONC = 5;
    for (let i = 0; i < symbols.length; i += CONC) {
      const batch = symbols.slice(i, i + CONC);
      const results = await Promise.allSettled(
        batch.map(async (sym) => {
          const k = await fetchKlines(`${sym}USDT`, '5m', 400);
          const beta = rollingBeta(k.map((c) => c.c), btcCloses, periods);
          const meta = UNIVERSE_BY_BASE.get(sym);
          return attribute(sym, meta?.name ?? sym, k, news, {
            horizonMinutes: horizon,
            btcBeta: beta,
            btcReturnPct,
          });
        }),
      );
      results.forEach((r) => {
        if (r.status === 'fulfilled' && r.value) out.push(r.value);
      });
    }

    out.sort((a, b) => Math.abs(b.abnormalReturnPct) - Math.abs(a.abnormalReturnPct));
    res.json({ updatedAt: Date.now(), horizon, attributions: out });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

/** Live chart percentile across the board, used by the board header. */
app.get('/api/percentile/:id', async (req, res) => {
  const id = req.params.id.toUpperCase();
  const scan: ScanResult = await getScan();
  const row = [...scan.bullish, ...scan.bearish].find((r) => r.id === id);
  res.json({ id, percentile: row?.percentile ?? percentileOf([], 0), rank: row?.rank ?? null, total: row ? scan.bullish.length + scan.bearish.length : 0 });
});

// Serve the production build when it exists.
const dist = path.resolve(__dirname, '../../dist');
app.use(express.static(dist));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'), (err) => {
    if (err) {
      res.status(200).send('API running. Frontend dev server is on http://localhost:5173');
    }
  });
});

app.listen(PORT, () => {
  console.log(`[orderflow] API listening on http://localhost:${PORT}`);
  console.log('[orderflow] warming scan in the background...');
  warmScan();

  // Restart recovery FIRST: pull the candles we missed while the process was
  // down, resolve anything that hit its stop or target in the meantime, and
  // record any hole so downtime is visible rather than silently shrinking
  // every MFE/MAE.
  backfillOnStartup()
    .then((r) => {
      const gaps = gapSummary();
      console.log(
        `[ledger] recovery: ${r.openSignals} open, ${r.candlesFetched} candles backfilled, ` +
        `${r.resolved} resolved, ${r.gaps.length} gap(s) found`,
      );
      if (gaps.count > 0) {
        console.log(
          `[ledger] downtime recorded: ${gaps.count} gaps totalling ${gaps.totalMinutes} minutes ` +
          `(last at ${new Date(gaps.lastAt!).toISOString()})`,
        );
      }
    })
    .catch((err) => console.error('[ledger] backfill failed:', (err as Error).message));

  startLedgerWorker((r) => {
    console.log(`[ledger] resolved ${r.resolved}:`, JSON.stringify(r.outcomes));
  });
});
