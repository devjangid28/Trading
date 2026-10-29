import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { forceScan, getScan, warmScan, currentScan, setMindBaseRateProvider } from './engine/scanner.js';
import {
  buildCalibrationReport,
  featureCoverage,
  isWin,
} from './engine/mind/index.js';
import { computeVolumeProfile, computeFootprint, confluenceScore } from './engine/volumeProfile.js';
import { getAllGex } from './engine/gex.js';
import { buildPreMoveRadar } from './engine/preMoveRadar.js';
import { getFan } from './engine/fan.js';
import { fetchAllNews } from './data/rss.js';
import { buildFeed } from './engine/news/score.js';
import { macroState } from './data/macro.js';
import { indianMarket } from './data/nse.js';
import { yahooChartCached } from './data/yahoo.js';
import { fetchKlines, primeKlines } from './data/binance.js';
import {
  normalizeTerminalSymbol, parseTerminalInterval, terminalBook, terminalCandles,
} from './terminal/data.js';
import { historyWindow, parseTerminalSpan } from './terminal/history.js';
import { readTerminalHistory } from './terminal/historyStore.js';
import { startTerminalRecorder, touchTerminalSymbol } from './terminal/recorder.js';
import {
  detectOrderBlock, averageRange, choppiness, strengthScore, percentileOf,
  sessionStartIndex, sessionStartTime, sessionVwap,
} from './engine/orderblock.js';
import { attribute, rollingBeta } from './engine/attribution.js';
import { UNIVERSE_BY_BASE } from './data/universe.js';
import { resolveUniverse, currentUniverse } from './data/universeBuilder.js';
import { symbolIndex } from './data/symbolIndex.js';
import { cacheStats } from './lib/cache.js';
import { formatIst, IST_OFFSET_MIN } from './lib/time.js';
import { LiveIngest } from './live/ingest.js';
import { mockRequested, installMockTransport } from './mock/transport.js';
import { MockLive } from './mock/mockLive.js';
import { buildDataset, setFixtureSymbols, type MockDataset } from './mock/dataset.js';
import type { MarketState } from './live/marketState.js';
import type { LiquidationTracker } from './live/marketState.js';
import type { ConnectionStatus } from '../../shared/types.js';

/**
 * The surface index.ts needs from the live layer.
 *
 * Declared rather than inferred so mock mode cannot silently drift from
 * production: adding a method to LiveIngest without adding it here is a
 * compile error, which is exactly the guarantee wanted.
 */
interface LiveLike {
  market: MarketState;
  liquidations: LiquidationTracker;
  start(): void;
  stop(): void;
  setSymbols(symbols: string[]): void;
  statuses(): Record<string, ConnectionStatus>;
  attemptStats(): { remainingInWindow: number; suppressed: number; cap: number; windowMs: number };
  killForTest(): void;
}
import { buildDerivatives } from './data/derivatives/build.js';
import { refreshCoinIdentities, stripMultiplier } from './data/coinIdentity.js';
import { dbSizeBytes, gapSummary, lastProcessedCandleAt, listSignals, ledgerStats, openSignals, signalCount, DB_PATH } from './ledger/store.js';
import { backfillOnStartup } from './ledger/backfill.js';
import { eventCalendar, nextTier1 } from './data/calendar.js';
import { inBlackout as nowBlackout } from './data/calendar.js';
import { freezeFromScan, startLedgerWorker } from './ledger/worker.js';
import { bindPriceClock } from './engine/scanner.js';
import { LIVE, NETWORK, UNIVERSE_REFRESH_MS } from './config.js';
import { searchEntries } from './lib/search.js';
import {
  labOverview,
  labStatus,
  labDecisions,
  labAccount,
  labReviews,
  labLearning,
  labCalibration,
  labAlertMessage,
  runControl,
  championModel,
} from './engine/lab/service.js';
import { labRunner, startLabWorker } from './engine/lab/runner.js';
import * as streamHub from './live/streamHub.js';
import * as aggregate from './live/aggregate.js';
import { cached } from './lib/cache.js';
import { bootRateLimiter } from './lib/rateLimitBoot.js';
import { bans, currentTransportName, hostOf } from './lib/http.js';
import { acquireLock, LOCK_PATH } from './runtime/lock.js';
import { ClockWatch } from './runtime/clock.js';
import { runSelfCheck, printSelfCheck } from './runtime/selfCheck.js';
import {
recordRunStart, recordRunEnd, restartsSince, downtimeSince, gapSummarySince,
  processGaps, recordProcessGap, countStoredCandles, ledgerCoverage, logoDir,
} from './ledger/store.js';
import type {
  Attribution, Candle, MindSignal, NewsFeed, ScanResult, StreamMsg,
} from '../../shared/types.js';

const LIVE_HEARTBEAT_MS = LIVE.SSE_HEARTBEAT_MS;

/**
 * Trailing debounce for the close-triggered rescan. Long enough to coalesce
 * every symbol's close, short enough that the board is fresh almost
 * immediately after the bar.
 */
const RESCAN_DEBOUNCE_MS = 900;

// â”€â”€ Fix 1: restore ban state BEFORE anything can make a request â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Order matters and is not stylistic. This runs before `live.start()` opens a
// socket and before `warmScan()` fires a klines request. A restart during an
// active ban has to be a silent one, and the only way to guarantee that is to
// read the ban out of SQLite before the first byte goes out.
const restoredBans = bootRateLimiter();

// The Mind layer's probability anchor comes from the ledger's observed win rate.
// Installed here — after the limiter, before the first scan — so the scanner can
// read it without importing `node:sqlite`. Until the ledger has enough resolved
// signals the provider reports null and the model uses its prior blend.
setMindBaseRateProvider(() => ledgerBaseRate());

// Part XV: the data-integrity gate needs to know how old the newest price is.
// `streamHub.lastTickAt()` is the same value `/api/health` already reports, so
// this adds no new source of truth — it only hands it to the scanner so the gate
// can distinguish a live price from a dead socket.
bindPriceClock(() => streamHub.lastTickAt() ?? null);

/**
 * Last successfully loaded calendar, kept for /api/health.
 *
 * Held in a module variable rather than re-fetched per health call because
 * `eventCalendar()` scrapes bea.gov, and a health endpoint that triggers an
 * outbound scrape is a health endpoint that can itself be rate-limited.
 */
let lastCalendar: Awaited<ReturnType<typeof eventCalendar>> | null = null;
let lastCalendarAt: number | null = null;

// â”€â”€ Fix 2: single-instance lock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Must be taken before anything opens a socket. Two servers each running a
// full scan double the Binance request weight, and neither sees the other's
// rate-limit response in time â€” that is how the original 418 happened.
const PORT = Number(process.env.PORT ?? 8787);
const lock = acquireLock({ port: PORT, label: 'orderflow-api' });
if (!lock.ok) {
  console.error('');
  console.error('  REFUSING TO START â€” another OrderFlow instance is already running.');
  console.error(`  ${lock.reason}`);
  console.error('');
  process.exit(11);
}

// â”€â”€ Fix 2: record this run, and watch for sleep/wake â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const runId = recordRunStart(process.pid);
let shuttingDown = false;
let runEndRecorded = false;
const endRun = (reason: string): void => {
  if (runEndRecorded) return;
  runEndRecorded = true;
  try {
    recordRunEnd(runId, reason);
  } catch {
    /* the DB may already be closed during a hard exit */
  }
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    endRun(`signal:${sig}`);
    lock.release?.();
  });
}
// A graceful exit (or a watcher that lets the loop drain) records `exit`; a hard
// kill records nothing. That asymmetry is deliberate data: it is how the ledger
// distinguishes a SIGTERM reload from a process that died with no chance to say
// goodbye. On Windows, `tsx watch` hard-kills its child, which is why the run
// rows in this repo carry a null end_reason.
process.on('exit', () => endRun('exit'));

const clockWatch = new ClockWatch({
  intervalMs: 5_000,
  onGap: (gap) => {
    // Record the hole rather than smoothing over it. A signal whose candles
    // were never seen would otherwise understate MFE/MAE with no way to know
    // which rows were affected.
    recordProcessGap(gap.fromTs, gap.toTs, gap.minutes, gap.kind);
    console.warn(
      `[clock] ${gap.kind} â€” ${gap.minutes}m of downtime recorded; backfilling now`,
    );
    void backfillOnStartup()
      .then((r) => {
        console.log(
          `[clock] backfill after gap: ${r.candlesFetched} candles, ${r.resolved} resolved`,
        );
      })
      .catch((err) => console.error('[clock] backfill failed:', (err as Error).message));
  },
});
clockWatch.start();

// â”€â”€ Live ingest (Phase 1) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Mock mode swaps the socket layer for a fixture replayer and the REST layer for
// a replay transport. Everything between them â€” parsers, engine, conviction,
// SSE â€” is the production code, unchanged.
// Base list used only until the live universe resolves. The metadata file is
// no longer the universe; it is a name/sector/tags lookup (see
// data/universeBuilder.ts).
const FALLBACK_STREAM_SYMBOLS = [...new Set(
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
  onTick: (symbol, price, changePct, exchangeTs) => {
    // Coalesced; streamHub flushes once per second so a symbol that ticks 40
    // times in that window still yields exactly one update, with the newest
    // price rather than whichever arrived first.
    streamHub.stageTick(symbol, price, changePct, exchangeTs);
    // The aggregate keeps a persistent last-tick map (stageTick's is cleared
    // each flush), so the 1s snapshot can bucket the whole universe.
    aggregate.recordTick(symbol, price, changePct);
    recoverScanAfterPrice();
  },
  onKlineClose: (symbol) => {
    // The board re-ranks on candle close. Running the scan here rather than on
    // a timer is what makes "re-ranks without refresh" true: the rank changes
    // exactly when the underlying 5m bar changes.
    void onCandleClosed(symbol);
  },
});

const MOCK = mockRequested();
let mockDataset: MockDataset | null = null;
if (MOCK) {
  // Installed before anything else so no outbound request can slip through the
  // real transport.
  const st = installMockTransport();
  mockDataset = buildDataset(st.index);
  setFixtureSymbols(mockDataset.symbols);
  console.log(
    `[orderflow] MOCK MODE: ${st.index.entries.length} fixtures, ` +
    `${mockDataset.symbols.length} symbols, coverage ${JSON.stringify(mockDataset.coverage)}. No outbound network.`,
  );
  if (!st.index.entries.length) {
    console.error('[orderflow] MOCK MODE but fixtures/ is empty. Run `npm run record-fixtures` first.');
    process.exit(3);
  }
}

// Resolve the live universe once the transport is in place (mock or real).
// This is the SET of pairs the scanner scans and the spot socket subscribes
// klines for. It is refreshed hourly below; a failure falls back to the
// metadata list so the app still boots.
const universeResolution = await resolveUniverse().catch((err: Error) => {
  console.warn('[universe] resolution failed at boot; using the metadata fallback:', err.message);
  return null;
});
const streamSymbols = universeResolution
  ? universeResolution.entries.map((e) => e.pair)
  : FALLBACK_STREAM_SYMBOLS;

// Build the every-symbol search index in the background so the first search is
// not a cold 6-hour-cache miss. Failure is non-fatal: `/api/search` falls back
// to the tracked universe.
void symbolIndex().catch((err: Error) =>
  console.warn('[search] symbol index build failed; search falls back to the universe:', err.message),
);

const live: LiveLike = MOCK  ? new MockLive({
    symbols: streamSymbols.slice(0, LiveIngest.maxSymbolsPerConnection()),
    handler: streamHub.ingestHandlers(),
    candlesBySymbol: mockDataset!.candlesBySymbol,
    priceBySymbol: mockDataset!.priceBySymbol,
    changeBySymbol: mockDataset!.changeBySymbol,
  })
  : new LiveIngest(streamSymbols.slice(0, LiveIngest.maxSymbolsPerConnection()), {
    ...streamHub.ingestHandlers(),
  });

live.start();


// Load .env if present. Every value in it is optional â€” the app runs keyless.
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    console.warn('[orderflow] could not read .env, continuing with defaults');
  }
}

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

/**
 * The forceOrder stream is the only source of liquidation prints. When its
 * socket is not open, the tracker still returns an all-zero "sample", which
 * reads on the board as "no liquidations happened". Hand `buildDerivatives` no
 * live source in that case so each row carries the honest unavailable reason.
 */
const liquidationFeedOpen = () =>
  live
    ? Object.entries(live.statuses()).some(
        ([name, status]) => name.startsWith('binance-futures') && status.state === 'open',
      )
    : false;

const derivativesWithCache = () =>
  cached('api:derivatives', 30_000, () =>
    buildDerivatives(
      live && liquidationFeedOpen()
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
 * Phase 1 â€” Server-Sent Events.
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
  /**
   * Tick sink. The hub hands over one pre-serialised string covering the whole
   * flush, so this is ONE `res.write` per flush per client instead of one per
   * moved symbol. At 1 Hz that difference was invisible; with a real-time
   * upstream it is the difference between a responsive stream and an event
   * loop that spends its time in `res.write`.
   */
  const sendRaw = (frame: string) => {
    res.write(frame);
  };

  // Optional per-connection scoping. `cid` must be unique per connection; the
  // client generates one when it opens the socket.
  const cid = typeof req.query.cid === 'string' && req.query.cid ? req.query.cid.slice(0, 64) : undefined;
  const symbolsParam = typeof req.query.symbols === 'string' ? req.query.symbols : undefined;
  const symbols = symbolsParam
    ? symbolsParam
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z0-9]{1,32}$/.test(s))
    : undefined;

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

  const unsubscribe = streamHub.subscribeRaw(sendRaw, { cid, symbols });

  let closed = false;
  req.on('close', () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

/**
 * Narrow an open SSE subscription's tick set.
 *
 * Body: `{ cid: string, symbols: string[] }`. The server only pushes ticks for
 * these symbols to that connection from now on (capped per client). Returns
 * 404 when the cid is not an open connection, so a dead client is not silently
 * ignored either.
 */
app.post('/api/stream/visible', (req, res) => {
  const cid = (req.body as { cid?: unknown } | undefined)?.cid;
  const symbols = (req.body as { symbols?: unknown } | undefined)?.symbols;
  if (typeof cid !== 'string' || !cid || cid.length > 64) {
    res.status(400).json({ error: 'client id (cid) required' });
    return;
  }
  if (!Array.isArray(symbols)) {
    res.status(400).json({ error: 'symbols must be an array of symbols' });
    return;
  }
  // Sanitise: uppercase, keep only plausible symbols, then cap. A huge array is
  // bounded by the config's per-client budget, never honoured wholesale.
  const clean = [...new Set(
    symbols
      .filter((s): s is string => typeof s === 'string' && /^[A-Za-z0-9]{1,32}$/.test(s))
      .map((s) => s.toUpperCase()),
  )];
  if (clean.length !== symbols.length) {
    res.status(400).json({ error: 'symbols contains an invalid value; expected plain symbols' });
    return;
  }
  if (!streamHub.setVisibleForCid(cid, clean)) {
    res.status(404).json({ error: 'unknown client id; reconnect the stream first' });
    return;
  }
  res.json({ ok: true, cid, symbols: clean.length, cap: LIVE.MAX_VISIBLE_SYMBOLS_PER_CLIENT });
});

// ─────────────────────────────────────────────────────────────────────────────
// The Mind layer — helpers for the /api/mind/* routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ledger's observed win rate and its sample size.
 *
 * This is what anchors every Mind probability (see `confluence.ts`). It is read
 * from the ledger rather than a constant so the anchor moves with the data.
 *
 * `ledgerStats` already returns `winRate: null` below its own sample floor, so a
 * thin ledger yields `observedWinRate: null` and the model falls back to its
 * prior blend rather than pretending to know a rate.
 */
export function ledgerBaseRate(): { observedWinRate: number | null; resolvedSamples: number } {
  try {
  // Part XV: this used to read `ledgerStats().winRate`, whose denominator is
  // every resolved signal — EXPIRED included, counted as a non-win. But
  // `buildCalibrationReport` scores the model over a DIFFERENT population: only
  // TP-hit versus STOP, with EXPIRED excluded entirely.
  //
  // So the probability was anchored to one population and then judged against a
  // bar drawn from another. Anything containing a meaningful share of expiries
  // was being measured against a bar that was too easy. Both sides now share one
  // definition, exported from `calibrate.ts` so they cannot drift apart again.
  const signals = listSignals(20_000, 'all');
  const decided = signals.filter((s) => {
    const o = s.outcome;
    return o !== 'OPEN' && (isWin(o) || o === 'STOP');
  });
  if (decided.length === 0) return { observedWinRate: null, resolvedSamples: 0 };
  const wins = decided.filter((s) => isWin(s.outcome)).length;
  return {
    observedWinRate: wins / decided.length,
    resolvedSamples: decided.length,
  };
  } catch {
  // A locked or absent ledger degrades to "no anchor measured", not to zero.
  return { observedWinRate: null, resolvedSamples: 0 };
  }
}

/** Empty bands, for the "no scan yet" response. */
function emptyBands() {
  return { high: 0, medium: 0, low: 0, actionable: 0, vetoed: 0 };
}

/** Count bands and vetoes across a set of Mind signals. */
function tallyBands(signals: MindSignal[]) {
  const vetoCounts = new Map<string, number>();
  for (const s of signals) {
    for (const v of s.vetoes) vetoCounts.set(v.code, (vetoCounts.get(v.code) ?? 0) + 1);
  }
  return {
    bands: {
    ...emptyBands(),
    high: signals.filter((s) => s.confidenceBand === 'high').length,
    medium: signals.filter((s) => s.confidenceBand === 'medium').length,
    low: signals.filter((s) => s.confidenceBand === 'low').length,
    actionable: signals.filter((s) => s.actionable).length,
    vetoed: signals.filter((s) => s.vetoes.length > 0).length,
    },
    vetoCounts: [...vetoCounts.entries()]
    .map(([code, n]) => ({ code, n }))
    .sort((a, b) => b.n - a.n || a.code.localeCompare(b.code)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/mind/health', (_req, res) => {
  try {
  const scan = currentScan();
  const calibration = buildCalibrationReport(listSignals(2000, 'all'), Date.now());
  if (!scan) {
  // Not an error: the board has not landed yet. The client shows "waiting for the
  // first scan", which is true, rather than a 503 it would have to guess at.
  res.json({
  ok: false,
  updatedAt: Date.now(),
  reason: 'no scan yet — the first scan has not completed',
  regime: 'quiet',
  regimeEvidence: [],
  calibration,
  bands: emptyBands(),
  vetoCounts: [],
  model: { id: 'mind-1', usingShippedWeights: true, baseRateSamples: 0, baseRateSource: 'prior' },
  });
  return;
  }
  const rows = [...scan.bullish, ...scan.bearish];
  const signals = rows.map((r) => r.mind).filter((s): s is MindSignal => Boolean(s));
  const { bands, vetoCounts } = tallyBands(signals);
  res.json({
  ok: true,
  updatedAt: scan.updatedAt,
  regime: scan.mind?.regime ?? 'quiet',
  regimeEvidence: scan.mind?.regimeEvidence ?? [],
  calibration,
  bands,
  vetoCounts,
  model: {
  id: 'mind-1',
  usingShippedWeights: true,
  baseRateSamples: scan.mind?.base.samples ?? 0,
  baseRateSource: scan.mind?.base.source ?? 'prior',
  },
  });
  } catch (err) {
  res.status(503).json({ error: (err as Error).message });
  }
  });

app.get('/api/mind/signals', (_req, res) => {
  try {
  const scan = currentScan();
  if (!scan) {
  res.json({
  updatedAt: Date.now(),
  ready: false,
  reason: 'no scan yet — the first scan has not completed',
  regime: 'quiet',
  regimeEvidence: [],
  signals: [],
  base: null,
  ...emptyBands(),
  });
  return;
  }
  const rows = [...scan.bullish, ...scan.bearish];
  // Read straight off the rows. The pass already ran during the scan; running it
  // again here would produce a second answer to the same question.
  const signals = rows
  .map((r) => r.mind)
  .filter((s): s is MindSignal => Boolean(s))
  .sort((a, b) => b.rank - a.rank);
  res.json({
  updatedAt: scan.updatedAt,
  ready: true,
  regime: scan.mind?.regime ?? 'quiet',
  regimeEvidence: scan.mind?.regimeEvidence ?? [],
  signals,
  base: scan.mind?.base ?? null,
  ...tallyBands(signals).bands,
  vetoCounts: tallyBands(signals).vetoCounts,
  });
  } catch (err) {
  res.status(503).json({ error: (err as Error).message });
  }
  });

app.get('/api/mind/features/:id', (req, res) => {
  const want = req.params.id.toUpperCase();
  const id = want.replace(/USDT$/, '');
  try {
  const scan = currentScan();
  const row = scan
  ? [...scan.bullish, ...scan.bearish].find((r) => r.base === id || r.pair === want)
  : null;
  if (!row) {
  // 404 rather than an empty vector: "not on the board" is a different answer
  // from "no features", and the client needs to say which.
  res.status(404).json({ error: `${id} is not on the board right now` });
  return;
  }
  res.json({
  updatedAt: scan!.updatedAt,
  symbol: row.pair,
  base: row.base,
  side: row.side,
  regime: scan!.mind?.regime ?? 'quiet',
  regimeEvidence: scan!.mind?.regimeEvidence ?? [],
  mind: row.mind ?? null,
  features: row.mindFeatures ?? null,
  // Coverage is what makes a thin vector legible. Reported even when the Mind
  // pass did not run, so the client can say "no vector" rather than "nothing
  // measured".
  coverage: row.mindFeatures ? featureCoverage(row.mindFeatures) : null,
  });
  } catch (err) {
  res.status(503).json({ error: (err as Error).message });
  }
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

// ─── The Engine Lab (Part XX) ────────────────────────────────────────────────
//
// Seven read endpoints and one write endpoint. Every read answers from real
// data or says `null`; the write endpoint runs a control and returns a
// sentence describing what happened.
//
// The Lab NEVER returns a LIVE mode, and there is no live adapter behind it.
// The status payload says so in words, in `executors.live.reason`.

app.get('/api/lab/overview', (_req, res) => {
  try {
    res.json(labOverview(currentScan(), championModel()));
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/lab/status', (_req, res) => {
  try {
    res.json(labStatus());
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/lab/decisions', (_req, res) => {
  try {
    res.json({
      updatedAt: Date.now(),
      decisions: labDecisions(currentScan(), championModel()),
    });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/lab/account', (_req, res) => {
  try {
    res.json(labAccount());
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/lab/reviews', (_req, res) => {
  try {
    res.json({ updatedAt: Date.now(), reviews: labReviews() });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/lab/learning', (_req, res) => {
  try {
    res.json(labLearning());
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/lab/calibration', (_req, res) => {
  try {
    res.json(labCalibration());
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

/**
 * The outbound alert-style message.
 *
 * TradingView's paper-trading account is a manual UI simulator with no public
 * order-placement API, so this is a message to PASTE into a TradingView alert
 * or a chart note. Nothing is sent anywhere by this application.
 */
app.get('/api/lab/alert-message', (_req, res) => {
  try {
    res.json({ updatedAt: Date.now(), message: labAlertMessage(currentScan(), championModel()) });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.post('/api/lab/controls', (req, res) => {
  try {
    const action = String(req.body?.action ?? '') as Parameters<typeof runControl>[0];
    const arg = req.body?.arg === undefined ? undefined : String(req.body.arg);
    const out = runControl(action, arg);
    res.json({ ...out, status: labStatus() });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/calendar', async (_req, res) => {
  try {
    const cal = await eventCalendar();
    lastCalendar = cal;
    lastCalendarAt = Date.now();
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

    /**
     * Fix 3. The UI keys its banner off this, so mock data can never be
     * mistaken for live data even if someone opens the app in the wrong mode.
     */
    mock: MOCK
      ? { active: true, fixtures: mockDataset?.symbols.length ?? 0, notice: 'MOCK DATA — fixtures, not the market' }
      : { active: false, fixtures: 0, notice: '' },

    // Fix 1 â€” per-host ban state. `banned` is the headline: a host under an
    // active ban serves cached data marked STALE and issues no requests at all.
    banGuard: {
      restoredFromDiskAtBoot: restoredBans,
      ...bans.snapshot(),
      transport: currentTransportName(),
    },

    // Stage 8 â€” the diagnostics you actually need when the app has been up
    // overnight and something looks wrong. Each one answers a question that
    // used to require attaching a debugger.
    live: {
      ...streamHub.streamStats(),
      /** ms since the last flushed tick; >5s means the sockets are dead. */
      lastTickAgeSec: streamHub.lastTickAt()
        ? Math.round((Date.now() - streamHub.lastTickAt()) / 1000)
        : null,
      sockets: live.statuses(),
      connections: live.attemptStats(),
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
          storedCandles: countStoredCandles(),
        };
      } catch (err) {
        return { error: (err as Error).message };
      }
    })(),

    /**
     * Fix 2 â€” "is the app actually running?" answered as numbers rather than
     * vibes. Every field here is something that, when wrong, silently costs
     * data instead of raising an error.
     */
    supervision: (() => {
      const DAY = 86_400_000;
      const sevenDaysAgo = Date.now() - 7 * DAY;
      const dayAgo = Date.now() - DAY;
      const lastCandle = (() => {
        try { return lastProcessedCandleAt(); } catch { return null; }
      })();
      return {
        supervised: process.env.ORDERFLOW_SUPERVISED === '1',
        runId,
        pid: process.pid,
        /** Seconds this process has been up. */
        uptimeSec: Math.round(process.uptime()),
        /** Launches in the trailing 24h, excluding this one. */
        restarts24h: restartsSince(dayAgo, false),
        /** Recorded process-level downtime (sleep/crash/stall) in 7 days. */
        gaps7d: gapSummarySince(sevenDaysAgo),
        downtimeMinutes7d: downtimeSince(sevenDaysAgo),
        recentGaps: processGaps(5),
        /**
         * Age of the newest candle the resolver actually looked at. This is the
         * honest "is the ledger keeping up" number â€” the process can be alive
         * with a resolver that is stuck.
         */
lastLedgerCandleAt: lastCandle,
        lastLedgerCandleAgeSec: lastCandle ? Math.round((Date.now() - lastCandle) / 1000) : null,
        /**
         * What downtime actually cost. Read this before quoting any win rate:
         * it is the denominator the sample-coverage claim rests on.
         */
        coverage: ledgerCoverage(),
      };
    })(),
    process: {
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      node: process.version,
    },

    /**
     * "Are tonight's macro blackout windows loaded?" â€” asked because a calendar
     * that failed to load is the quietest possible failure in this app: nothing
     * errors, the countdown simply never appears, and the veto never fires.
     */
    calendar: {
      loaded: lastCalendar !== null,
      loadedAt: lastCalendarAt,
      loadedAgeSec: lastCalendarAt ? Math.round((Date.now() - lastCalendarAt) / 1000) : null,
      eventCount: lastCalendar?.events.length ?? 0,
      sources: lastCalendar?.sources.map((s) => ({ name: s.name, ok: s.ok, reason: s.reason })) ?? [],
      nextBlackout: lastCalendar
        ? (() => {
            const now = Date.now();
            const next = lastCalendar!.events.find((e) => e.importance === 1 && e.blackout && e.t > now);
            if (!next) return null;
            return {
              kind: next.kind,
              title: next.title,
              ist: formatIst(next.t),
              minutesUntil: Math.round((next.t - now) / 60_000),
              blackoutActive: nowBlackout(lastCalendar!.events, now),
            };
          })()
        : null,
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

/** Record and push a freshly computed board. */
function publishScan(scan: Awaited<ReturnType<typeof forceScan>>): void {
  freezeFromScan([...scan.bullish, ...scan.bearish], scan.updatedAt, scan.regime, {
    mindRegime: scan.mind?.regime,
    health: scan.dataHealth ?? null,
    breadth: scan.breadthBias,
  });
  streamHub.send({ type: 'scan', scan, ts: Date.now() });
}

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
        publishScan(await forceScan());
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

/**
 * A boot scan can finish before the spot socket delivers its first tick. The
 * health gate then caches "price unavailable / NO TRADE" for a full minute even
 * though ticks are arriving. Once price is flowing, re-run once and push the
 * board so an already-open client sees the recovery without a manual refresh.
 * Two attempts only: if the stream really is down, the gate is telling the
 * truth and must not turn into a scan loop.
 */
let priceRecoveryScheduled = false;
function recoverScanAfterPrice(): void {
  if (process.env.ORDERFLOW_MOCK === '1' || priceRecoveryScheduled) return;
  priceRecoveryScheduled = true;
  let attempts = 0;
  const attempt = async (): Promise<void> => {
    attempts++;
    const health = currentScan()?.dataHealth;
    if (health && health.price_stream !== 'unavailable') return;
    try {
      const scan = await forceScan();
      publishScan(scan);
      if (scan.dataHealth?.price_stream === 'unavailable' && attempts < 2) {
        setTimeout(attempt, 10_000).unref();
      }
    } catch (err) {
      console.warn(`[scan] price-recovery rescan failed: ${(err as Error).message}`);
    }
  };
  setTimeout(attempt, 5_000).unref();
}

app.get('/api/scan', async (_req, res) => {
  try {
    const scan = await getScan();
    // Freeze whatever is worth recording BEFORE responding, so the ledger is
    // current the moment the client renders. A stale (cached or persisted)
    // board is skipped: its levels are not current, so freezing them would
    // record trades the market has already moved past.
    if (!scan.stale) {
      const frozen = freezeFromScan([...scan.bullish, ...scan.bearish], scan.updatedAt, scan.regime, {
    mindRegime: scan.mind?.regime,
    health: scan.dataHealth ?? null,
    breadth: scan.breadthBias,
  });
      if (frozen.frozen > 0) {
        console.log(
          `[ledger] froze ${frozen.frozen} (${frozen.real} real, ${frozen.shadow} shadow), ` +
          `${frozen.skippedExisting} already open`,
        );
      }
      // The Lab considers the same board. In SHADOW mode it decides and
      // records; in PAPER mode it may open a position. The risk gate runs
      // inside `consider`, so a blocked trade never reaches the broker.
      try {
        const considered = labRunner.consider([...scan.bullish, ...scan.bearish], scan.updatedAt);
        if (considered.submitted > 0) {
          console.log(`[lab] submitted ${considered.submitted} paper order(s)`);
        }
      } catch (err) {
        console.warn(`[lab] consider failed: ${(err as Error).message}`);
      }
    }
    res.json(scan);
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

/**
 * The Order Block fan — 15m/24h cumulative-% series for the scanned universe.
 *
 * Cached ~60s server-side, so the fan refreshes on the same cadence as the
 * board and a client polling it does not multiply the Binance request weight.
 */
app.get('/api/fan', async (_req, res) => {
  try {
    res.json(await getFan());
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

/**
 * Global coin search.
 *
 * Searches the tracked universe (the names we can attach a live price to) and
 * attaches the newest exchange price/change from the live socket when one has
 * arrived. `price` is null until the first tick, so the UI never invents one;
 * `ageMs` (null when never ticked) is what lets the row say "live" vs "from
 * the last scan" honestly.
 */
app.get('/api/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const scan = currentScan();
  const onBoard = new Set(
    scan ? [...scan.bullish, ...scan.bearish].map((r) => r.base) : [],
  );

  // EVERY exchange symbol (spot + perp), not just the tracked universe. If the
  // venue index cannot be built, fall back to the universe so the box still
  // works rather than returning an empty list.
  let entries;
  try {
    entries = await symbolIndex();
  } catch (err) {
    console.warn('[search] symbol index unavailable; falling back to the universe:', (err as Error).message);
    entries = [...UNIVERSE_BY_BASE.entries()].map(([base, u]) => ({
      base, displayTicker: stripMultiplier(base), name: u.name, sector: u.sector,
      pair: `${base}USDT`, quote: 'USDT', kind: 'spot' as const,
    }));
  }

  const hits = searchEntries(q, entries, 12).map((h) => {
    const pair = h.pair ?? `${h.base}USDT`;
    // Only the spot book feeds the tick stream, so perp rows carry no live price
    // here and render a dash rather than a fabricated number.
    const state = h.kind === 'spot' ? live.market.symbols.get(pair) : undefined;
    return {
      base: h.base,
      displayTicker: h.displayTicker,
      name: h.name,
      sector: h.sector,
      pair,
      quote: h.quote ?? 'USDT',
      kind: h.kind ?? 'spot',
      price: state && state.lastPrice > 0 ? state.lastPrice : null,
      changePct: state ? state.changePct : null,
      ageMs: state && state.lastTickAt ? Date.now() - state.lastTickAt : null,
      onBoard: onBoard.has(h.base),
      matchedOn: h.matchedOn,
    };
  });

  res.json({ q, ts: Date.now(), hits });
});

/**
 * Every pair in the scanned universe with its newest live value.
 *
 * Backs the Markets tab: unlike the boards (top 20 per side), this returns the
 * whole universe so a coin that is simply quiet still has a row. Sorted by 24h
 * quote volume, which is the order a trader scans them in.
 */
app.get('/api/markets', (_req, res) => {
  const uni = currentUniverse();
  if (!uni) {
    res.status(503).json({ error: 'universe not ready' });
    return;
  }
  const rows = uni.entries
    .map((e) => {
      const state = live.market.symbols.get(e.pair);
      return {
        base: e.base,
        pair: e.pair,
        name: e.name,
        sector: e.sector,
        price: state && state.lastPrice > 0 ? state.lastPrice : e.ticker.lastPrice,
        changePct: state ? state.changePct : e.ticker.priceChangePercent,
        volumeUsd: Math.round(e.ticker.quoteVolume),
        live: Boolean(state && state.lastTickAt),
      };
    })
    .sort((a, b) => b.volumeUsd - a.volumeUsd);

  res.json({ ts: Date.now(), n: rows.length, rows });
});

/**
 * Terminal chart + order-book heatmap.
 *
 * These are the only routes that expose a full spot book. They are deliberately
 * separate from `/api/markets` and the derivatives depth summary: a heatmap
 * needs every returned level, not four walls and a notional total.
 */
app.get('/api/terminal/book', async (req, res) => {
  const symbol = normalizeTerminalSymbol(req.query.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'symbol must be an uppercase USDT spot pair' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  touchTerminalSymbol(symbol);
  try {
    res.json(await terminalBook(symbol));
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/terminal/history', async (req, res) => {
  const symbol = normalizeTerminalSymbol(req.query.symbol);
  const span = parseTerminalSpan(req.query.span) ?? '15m';
  if (!symbol) {
    res.status(400).json({ error: 'symbol must be an uppercase USDT spot pair' });
    return;
  }
  const requested = Number(req.query.maxFrames);
  const maxFrames = Number.isFinite(requested)
    ? Math.min(2_000, Math.max(60, Math.round(requested)))
    : undefined;
  const now = Date.now();
  const window = historyWindow(span, now);
  res.setHeader('Cache-Control', 'no-store');
  touchTerminalSymbol(symbol);
  try {
    res.json(readTerminalHistory(
      symbol,
      window.from,
      Math.max(window.from + 1, now - 5_000),
      maxFrames,
    ));
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.get('/api/terminal/candles', async (req, res) => {
  const symbol = normalizeTerminalSymbol(req.query.symbol);
  const interval = parseTerminalInterval(req.query.interval);
  if (!symbol) {
    res.status(400).json({ error: 'symbol must be an uppercase USDT spot pair' });
    return;
  }
  if (!interval) {
    res.status(400).json({ error: 'unsupported interval' });
    return;
  }
  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? requested : undefined;
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json(await terminalCandles(symbol, interval, limit));
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
    const dayAgo = candles[sessionStartIndex(candles)];
    const changePct = dayAgo.c > 0 ? ((last.c - dayAgo.c) / dayAgo.c) * 100 : 0;
    const side = changePct >= 0 ? 'bullish' : 'bearish';
    const directionalSetup =
      setup && setup.side === side
        ? setup
        : detectOrderBlock(candles, { range: averageRange(closed, 20), prefer: side });
    const sessionClosed = closed.slice(sessionStartIndex(closed));
    const dayHigh = Math.max(...sessionClosed.map((c) => c.h));
    const dayLow = Math.min(...sessionClosed.map((c) => c.l));
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
      // The engine's session VWAP, over the same window and the same candles
      // the chart draws. The popup used to read VWAP only off the board row,
      // so every surface that opens the chart without one - Signals, Radar -
      // rendered "n/a" and failed its own VWAP alignment tick while the board
      // row right above it had the number. One definition, one source.
      vwap: sessionVwap(closed, sessionStartTime(closed)),
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

/**
 * Signals endpoint — the board rows enriched with volume profile, footprint
 * delta, confluence score and GEX context. Cached 60s server-side.
 */
app.get('/api/signals', async (_req, res) => {
  try {
    const [scan, gex] = await Promise.all([
      getScan(),
      getAllGex().catch(() => ({ btc: null, eth: null })),
    ]);

    const allRows = [...scan.bullish, ...scan.bearish];
    const CONC = 8;
    const enriched: unknown[] = [];

    for (let i = 0; i < allRows.length; i += CONC) {
      const batch = allRows.slice(i, i + CONC);
      const results = await Promise.allSettled(
        batch.map(async (row) => {
          const candles = await fetchKlines(row.symbol, '5m', 320).catch(() => [] as Candle[]);
          const vp = computeVolumeProfile(candles);
          const fp = computeFootprint(candles, 30);
          const lastFp = fp[fp.length - 1];
          const price = row.price;

          const pocAbove = vp
            ? (row.side === 'bullish' ? price > vp.poc : price < vp.poc)
            : false;
          const inVA = vp ? price >= vp.val && price <= vp.vah : false;
          const deltaPositive = lastFp ? lastFp.delta > 0 : false;
          const recentDivergence = fp.slice(-5).some((f) => f.deltaDiv);

          const d = row.derivatives;
          const score = confluenceScore({
            side: row.side,
            hasOB: row.setup !== null,
            obRetest: row.setup?.retest ?? 'none',
            pocAbove,
            inValueArea: inVA,
            deltaPositive,
            cvdSlope: d?.cvdSlope ?? 0,
            vwapSide: row.vwap !== null
              ? (row.side === 'bullish' ? price > row.vwap : price < row.vwap)
              : false,
            htfAligned: row.setup?.htf.aligned ?? false,
            fundingFavorable: d
              ? !(d.fundingLabel === 'CROWDED_LONG' && row.side === 'bullish') &&
                !(d.fundingLabel === 'CROWDED_SHORT' && row.side === 'bearish')
              : true,
            domImbalance: d?.depth?.imbalance ?? 0,
            newsAligned: row.newsDot
              ? (row.side === 'bullish' ? row.newsDot.direction >= 0 : row.newsDot.direction <= 0)
              : true,
            convictionScore: row.conviction?.score ?? 50,
          });

          return {
            base: row.base,
            symbol: row.symbol,
            displayTicker: row.displayTicker,
            displayName: row.displayName,
            logoUrl: row.logoUrl,
            sector: row.sector,
            side: row.side,
            price: row.price,
            changePct: row.changePct,
            volumeUsd: row.volumeUsd,
            strength: row.strength,
            percentile: row.percentile,
            // Carried through so a card opened here can answer "is this near
            // the top of its board?" - these rows ARE the scan board rows, so
            // the answer exists; the popup used to be told "no row" instead.
            rank: row.rank,
            isPick: row.isPick,
            conviction: row.conviction,
            setup: row.setup,
            vwap: row.vwap,
            derivatives: row.derivatives,
            newsDot: row.newsDot,
            plan: row.plan,
            // New fields
            volumeProfile: vp ? { poc: vp.poc, vah: vp.vah, val: vp.val, totalVolume: vp.totalVolume, buckets: vp.buckets } : null,
            footprint: fp.slice(-20),
            confluenceScore: score,
            recentDeltaDivergence: recentDivergence,
            updatedAt: row.updatedAt,
          };
        }),
      );
      results.forEach((r) => {
        if (r.status === 'fulfilled') enriched.push(r.value);
      });
    }

    // Sort by confluence score descending within each side
    const bullSignals = enriched
      .filter((r: unknown) => (r as { side: string }).side === 'bullish')
      .sort((a, b) => (b as { confluenceScore: number }).confluenceScore - (a as { confluenceScore: number }).confluenceScore);
    const bearSignals = enriched
      .filter((r: unknown) => (r as { side: string }).side === 'bearish')
      .sort((a, b) => (b as { confluenceScore: number }).confluenceScore - (a as { confluenceScore: number }).confluenceScore);

    res.json({
      updatedAt: Date.now(),
      bullish: bullSignals,
      bearish: bearSignals,
      gex,
      regime: scan.regime,
      breadthBias: scan.breadthBias,
      blackedOut: scan.blackedOut,
    });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

/** Pre-move radar — coins coiling/accumulating before a move. */
app.get('/api/radar', async (_req, res) => {
  try {
    const [signals, scan] = await Promise.all([
      buildPreMoveRadar(),
      getScan(),
    ]);
    res.json({
      updatedAt: Date.now(),
      signals,
      regime: scan.regime,
      breadthBias: scan.breadthBias,
    });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

/** GEX snapshot for BTC and ETH from Deribit. */
app.get('/api/gex', async (_req, res) => {
  try {
    res.json(await getAllGex());
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

/**
 * Logos, served locally.
 *
 * Images are downloaded once by the identity refresher and served from disk.
 * Hotlinking an aggregator from the browser would leak a request per row per
 * render and put our IP in someone else's rate limiter, which is the exact
 * failure mode Fix 1 exists to prevent.
 */
app.use('/static/logos', express.static(logoDir(), {
  maxAge: '7d',
  immutable: true,
  fallthrough: false,
}));

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

/**
 * Fix 1 requirement 5 — restart safety.
 *
 * The original startup re-downloaded 320 candles for ~56 symbols, which is both
 * slow and a large share of the request weight implicated in the original 418.
 * This reads the stored series and fetches only the genuinely missing tail.
 *
 * Staggered on purpose: firing 56 requests at once is the exact shape of burst
 * that produces a 429, and this runs at the same moment as the warm scan.
 */
async function primeCandlesOnStartup(): Promise<void> {
  // In mock mode the fixture set IS the candle store, and MockLive already
  // seeds the ring buffers from it. Priming here would fire 56 requests for
  // symbols the fixture set does not contain and log 56 refusals on every boot,
  // which is noise rather than information.
  if (MOCK) {
    console.log('[startup] MOCK MODE: skipping candle priming, the fixture set is the store');
    return;
  }

  const symbols = streamSymbols.slice(0, 56);
  const BATCH = 4;
  const BATCH_DELAY_MS = 400;
  let fetched = 0;
  let fromDisk = 0;
  let skipped = 0;

  console.log(
    `[startup] priming ${symbols.length} symbols from SQLite (only missing candles will be fetched)`,
  );

  for (let i = 0; i < symbols.length; i += BATCH) {
    if (bans.isBanned(hostOf(NETWORK.BINANCE_SPOT_HOST))) {
      console.warn('[startup] candle priming stopped: the primary host is banned');
      skipped = symbols.length - i;
      break;
    }
    const batch = symbols.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((s) => primeKlines(s, '5m', 320)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        fetched += r.value.fetched;
        fromDisk += r.value.fromDisk;
      } else {
        skipped++;
      }
    }
    if (i + BATCH < symbols.length) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  // `fromDisk` counts CANDLES across all series, so the share of the window
  // served locally is measured against the full requested window, not the
  // symbol count.
  const windowCandles = symbols.length * 320;
  const pct = windowCandles ? Math.min(100, Math.round((fromDisk / windowCandles) * 100)) : 0;
  console.log(
    `[startup] prime done: ${fromDisk} candles read from SQLite across ` +
    `${symbols.length - skipped} symbols, ${fetched} newly fetched` +
    `${skipped ? `, ${skipped} skipped` : ''} — ` +
    `${pct}% of the ${windowCandles}-candle window came off disk, ` +
    `${fetched} request-weight units of the original full-history download avoided`,
  );
}

app.listen(PORT, () => {
  console.log(`[orderflow] API listening on http://localhost:${PORT}`);
  console.log('[orderflow] warming scan in the background...');

  // Fix 2 â€” print PASS/FAIL for the five things whose failure is silent.
  void runSelfCheck({
    lockAcquired: lock.ok,
    lockDetail: lock.ok ? `acquired by PID ${process.pid} (${LOCK_PATH})` : 'not acquired',
    restoredBans,
  })
    .then((report) => {
      printSelfCheck(report);
      return eventCalendar().catch(() => null);
    })
    .then((cal) => {
      if (cal) { lastCalendar = cal; lastCalendarAt = Date.now(); }
    })
    .catch((err) => console.error('[selfcheck] threw:', (err as Error).message));

  if (!MOCK) startTerminalRecorder(['BTCUSDT']);
  warmScan();
  primeCandlesOnStartup();

  // Universe refresh: exchangeInfo + 24h volume move over the day, so the
  // scanned set (and the spot kline subscriptions) is rebuilt hourly rather
  // than frozen at boot. `resolveUniverse` is cached, so this is the only
  // forced refresh; a failure keeps the last good universe.
  setInterval(() => {
    void resolveUniverse(true)
      .then((u) => {
        live.setSymbols(u.entries.map((e) => e.pair).slice(0, LiveIngest.maxSymbolsPerConnection()));
      })
      .catch((err: Error) => {
        console.warn('[universe] hourly refresh failed:', err.message);
      });
  }, UNIVERSE_REFRESH_MS).unref();

  // Live aggregate: one `agg` event per second while anyone is listening. It is
  // a single pass over the universe's map lookups, so it stays cheap at 1 Hz.
  setInterval(() => {
    if (streamHub.subscriberCount() === 0) return;
    const agg = aggregate.computeAggregate();
    if (agg) streamHub.send({ type: 'agg', agg, ts: agg.asOf });
  }, 1000).unref();

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

  // The Lab's clock: advance the paper book and write the reviews.
  startLabWorker((r) => {
    console.log(`[lab] resolved ${r.resolved}, wrote ${r.reviews} review(s)`);
  });

  // D2/D3: refresh coin names and download logos once a day at most. Never on
  // the critical path, never fatal — the board falls back to the universe file
  // and then to the ticker alone.
  void refreshCoinIdentities()
    .then((r) => console.log(`[identity] ${r.reason}`))
    .catch((err) => console.warn('[identity] refresh failed:', (err as Error).message));
});



