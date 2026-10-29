import { useCallback, useEffect, useRef, useState } from 'react';
import type { NextBlackout } from '../components/BlackoutCountdown';

/** Shape returned by GET /api/calendar. */
export interface CalendarResult {
  updatedAt: number;
  events: import('../../shared/types').MarketEvent[];
  sources: import('../../shared/types').EventCalendar['sources'];
  nextBlackout: NextBlackout | null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A global-search hit. The server searches the whole tracked universe, not just
 * the rows on the board, and attaches the newest live price when one exists.
 * `price` is null until the first tick for that symbol, so a result never
 * shows a made-up number; `ageMs` (null = never ticked) is what lets the row
 * say "live" versus "last scan" honestly.
 */
export interface SearchHit {
  base: string;
  displayTicker: string;
  name: string;
  sector: string;
  /** Exact traded symbol; perps share the base but not the price feed. */
  pair?: string;
  quote?: string;
  kind?: 'spot' | 'perp';
  price: number | null;
  changePct: number | null;
  ageMs: number | null;
  onBoard: boolean;
  matchedOn: 'base' | 'ticker' | 'name';
}

export interface MarketRow {
  base: string;
  pair: string;
  name: string;
  sector: string;
  price: number;
  changePct: number;
  volumeUsd: number;
  live: boolean;
}

export interface MarketsResponse {
  ts: number;
  n: number;
  rows: MarketRow[];
}

export interface SearchResponse {
  q: string;
  ts: number;
  hits: SearchHit[];
}

/**
 * The subset of GET /api/health this client reads.
 *
 * Declared explicitly rather than typed as `any`, so a rename on the server is a
 * compile error here instead of a silently undefined banner.
 */
export interface HealthState {
  ok: boolean;
  ist: string;
  uptimeSec: number;
  mock: { active: boolean; fixtures: number; notice: string };
  banGuard: {
    transport: string;
    hosts: { host: string; banned: boolean; remainingMs: number; budget: string }[];
  };
  supervision: {
    supervised: boolean;
    restarts24h: number;
    lastLedgerCandleAgeSec: number | null;
    gaps7d: { count: number; totalMinutes: number };
  };
  calendar: { loaded: boolean; eventCount: number };
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api${path}`, { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

/**
 * POST a JSON body and read the same shaped reply.
 *
 * The Lab's controls are the only writes this client makes, and they all go
 * through here so the error handling is the same as the reads.
 */
async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

/**
 * The Mind layer's client types.
 *
 * Deliberately hand-written rather than imported from `shared/types`, because the
 * server sends only the parts a screen needs: the feature vector is fetched once
 * per asset on demand, not carried on every board row the client already has.
 * The shapes that ARE shared — `MindSignal`'s fields — are structurally identical
 * to `shared/types.ts`, and `MindSignalRow` below is the subset the UI renders.
 */

export type MindRegime =
  | 'trending-bull' | 'trending-bear' | 'range'
  | 'high-vol-cascade' | 'macro-blackout' | 'quiet';

export interface MindSignalRow {
  id: string;
  symbol: string;
  side: 'bullish' | 'bearish';
  probability: number;
  expectedR: number;
  netExpectedR: number;
  regime: MindRegime;
  drivers: Array<{ feature: string; contribution: number; reason: string; disclosure?: boolean }>;
  vetoes: Array<{ code: string; reason: string; rule: string }>;
  confidenceBand: 'high' | 'medium' | 'low';
  actionable: boolean;
  rank: number;
  asOf: number;
}

export interface CalibrationReportView {
  updatedAt: number;
  n: number;
  suppressed: boolean;
  suppressReason: string | null;
  brier: number | null;
  brierBaseRate: number | null;
  brierDelta: number | null;
  baseRate: number | null;
  beatsBaseRate: boolean;
  lastRefitAt: number | null;
  decomposition: {
    reliability: number | null;
    resolution: number | null;
    uncertainty: number | null;
    forecastSpread: number | null;
    residual: number | null;
    brierSkill: number | null;
  } | null;
  buckets: Array<{ lo: number; hi: number; n: number; meanPredicted: number | null; realised: number | null }>;
}

export interface MindHealthView {
  ok: boolean;
  reason?: string;
  updatedAt: number;
  regime: MindRegime;
  regimeEvidence: Array<{ input: string; value: number | string | null; reading: string }>;
  calibration: CalibrationReportView;
  bands: { high: number; medium: number; low: number; actionable: number; vetoed: number };
  vetoCounts: Array<{ code: string; n: number }>;
  model: {
    id: string;
    usingShippedWeights: boolean;
    baseRateSamples: number;
    baseRateSource: 'ledger' | 'prior';
  };
}

export interface MindSignalsView {
  updatedAt: number;
  ready: boolean;
  reason?: string;
  regime: MindRegime;
  regimeEvidence: Array<{ input: string; value: number | string | null; reading: string }>;
  signals: MindSignalRow[];
  base: { rate: number; samples: number; source: 'ledger' | 'prior' } | null;
  high: number;
  medium: number;
  low: number;
  actionable: number;
  vetoed: number;
  vetoCounts: Array<{ code: string; n: number }>;
}

/** `/api/mind/features/:id`. `features` is null when the pass did not run. */
export interface MindFeaturesView {
  updatedAt: number;
  symbol: string;
  base: string;
  side: 'bullish' | 'bearish';
  regime: MindRegime;
  regimeEvidence: Array<{ input: string; value: number | string | null; reading: string }>;
  mind: MindSignalRow | null;
  features: import('../../shared/types').FeatureVector | null;
  coverage: { measured: number; total: number } | null;
}

export const api = {
  health: (s?: AbortSignal) => get<HealthState>('/health', s),
  scan: (s?: AbortSignal) => get<import('../../shared/types').ScanResult>('/scan', s),
  fan: (s?: AbortSignal) => get<import('../../shared/types').FanPayload>('/fan', s),
  search: (q: string, s?: AbortSignal) =>
    get<SearchResponse>(`/search?q=${encodeURIComponent(q)}`, s),
  markets: (s?: AbortSignal) => get<MarketsResponse>('/markets', s),
  terminalBook: (symbol: string, s?: AbortSignal) =>
    get<import('../../shared/types').TerminalBook>(
      `/terminal/book?symbol=${encodeURIComponent(symbol)}`,
      s,
    ),
  terminalHistory: (
    symbol: string,
    span: import('../../shared/types').TerminalSpan,
    maxFrames = 900,
    s?: AbortSignal,
  ) =>
    get<import('../../shared/types').TerminalHistory>(
      `/terminal/history?symbol=${encodeURIComponent(symbol)}&span=${span}&maxFrames=${maxFrames}`,
      s,
    ),
  terminalCandles: (
    symbol: string,
    interval: import('../../shared/types').TerminalInterval,
    limit = 320,
    s?: AbortSignal,
  ) =>
    get<import('../../shared/types').TerminalCandles>(
      `/terminal/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
      s,
    ),
  news: (s?: AbortSignal) => get<import('../../shared/types').NewsFeed>('/news', s),
  macro: (s?: AbortSignal) => get<import('../../shared/types').MacroState>('/macro', s),
  calendar: (s?: AbortSignal) => get<CalendarResult>('/calendar', s),
  india: (s?: AbortSignal) => get<import('../../shared/types').IndianMarket>('/india', s),
  asset: <T = unknown>(id: string, s?: AbortSignal) => get<T>(`/asset/${id}`, s),
  mindHealth: (s?: AbortSignal) => get<MindHealthView>('/mind/health', s),
  mindSignals: (s?: AbortSignal) => get<MindSignalsView>('/mind/signals', s),
  mindFeatures: (id: string, s?: AbortSignal) =>
    get<MindFeaturesView>(`/mind/features/${encodeURIComponent(id)}`, s),
  attributionAll: (s?: AbortSignal) =>
    get<{ updatedAt: number; horizon: number; attributions: import('../../shared/types').Attribution[] }>(
      '/attribution',
      s,
    ),
  attributionOne: (id: string, horizon: number, s?: AbortSignal) =>
    get<{ attribution: import('../../shared/types').Attribution | null; beta: number }>(
      `/attribution/${id}?horizon=${horizon}`,
      s,
    ),
  signals: (s?: AbortSignal) => get<unknown>('/signals', s),
  gex: (s?: AbortSignal) => get<import('../terminal/levels').GammaResponse>('/gex', s),
  liquidations: (symbol: string, s?: AbortSignal) =>
    get<{ recent: import('../../shared/types').LiqEvent[]; note: string; asOf: number }>(
      `/liquidations?symbol=${encodeURIComponent(symbol)}`,
      s,
    ),
  radar: (s?: AbortSignal) => get<unknown>('/radar', s),

  // ── The Engine Lab ───────────────────────────────────────────────────────
  /** The whole Lab page in one payload: status, decisions, account, reviews, learning, calibration. */
  labOverview: (s?: AbortSignal) => get<import('../../shared/types').LabOverview>('/lab/overview', s),
  labStatus: (s?: AbortSignal) => get<import('../../shared/types').LabStatus>('/lab/status', s),
  labDecisions: (s?: AbortSignal) =>
    get<{ updatedAt: number; decisions: import('../../shared/types').LabDecision[] }>('/lab/decisions', s),
  labAccount: (s?: AbortSignal) => get<import('../../shared/types').LabAccount>('/lab/account', s),
  labReviews: (s?: AbortSignal) =>
    get<{ updatedAt: number; reviews: import('../../shared/types').LabReview[] }>('/lab/reviews', s),
  labLearning: (s?: AbortSignal) => get<import('../../shared/types').LabLearning>('/lab/learning', s),
  labCalibration: (s?: AbortSignal) => get<import('../../shared/types').LabCalibration>('/lab/calibration', s),
  labAlertMessage: (s?: AbortSignal) =>
    get<{ updatedAt: number; message: import('../../shared/types').LabAlertMessage | null }>(
      '/lab/alert-message',
      s,
    ),
  /** Run a Lab control. Returns what happened, in words. */
  labControl: (action: string, arg?: string) =>
    post<import('../../shared/types').LabControlResult>('/lab/controls', { action, arg }),
};

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Poll an endpoint on an interval while the tab is visible. Polling pauses on
 * hidden tabs so a backgrounded terminal does not keep hammering the upstream
 * APIs.
 */
export function usePolling<T>(
  fetcher: (signal?: AbortSignal) => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
  enabled = true,
): AsyncState<T> & { refresh: () => void } {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: enabled,
  });
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    // Deferred until the caller needs it. This keeps heavy, tab-specific feeds
    // (India, attribution) off the initial page load so the first scan is not
    // competing with them for the network and the engine.
    if (!enabled) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }

    const ac = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const run = async () => {
      try {
        const data = await fetcherRef.current(ac.signal);
        if (!cancelled) setState({ data, error: null, loading: false });
      } catch (err) {
        if (cancelled || ac.signal.aborted) return;
        setState((s) => ({
          data: s.data,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        }));
      }
    };

    const start = () => {
      if (timer) return;
      void run();
      timer = setInterval(run, intervalMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        stop();
        start();
      }
    };

    setState((s) => ({ ...s, loading: true }));
    start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      stop();
      ac.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, tick, ...deps]);

  return { ...state, refresh };
}

/**
 * Shape returned by GET /api/asset/:id.
 *
 * It lives here rather than inside a component because two surfaces read it:
 * the detail popup and the row ticket. Both must draw the SAME real candles ΓÇö
 * the type exists so nobody can quietly rebuild OHLC from a close-only series
 * on one side of the product while the other side reads the truth.
 */
export interface AssetDetail {
  id: string;
  pair: string;
  name: string;
  sector: string;
  candles: import('../../shared/types').Candle[];
  setup: import('../../shared/types').Setup | null;
  side: 'bullish' | 'bearish';
  choppiness: number;
  strength: number;
  rangePct: number;
  changePct: number;
  price: number;
  /**
   * Session VWAP, computed by the engine over the same closed candles this
   * payload carries. `null` only when the window had no volume at all, which
   * for a live pair means the feed is broken rather than that VWAP is zero.
   *
   * This is what the chart popup draws its VWAP line from. It used to read VWAP
   * off the board row instead, which meant every surface that opens the popup
   * without a board row in hand rendered `n/a`.
   */
  vwap: number | null;
  updatedAt: number;
}

/**
 * One-shot fetch, used for on-demand panels like the asset chart popup.
 *
 * `key` lets a caller swap the subject (e.g. the selected symbol) without
 * remounting. Without it, swapping A ΓåÆ B while `enabled` stays true would keep
 * showing A's data.
 */
export function useLazy<T>(
  fetcher: (signal?: AbortSignal) => Promise<T>,
  enabled: boolean,
  key?: unknown,
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: false,
  });

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    let cancelled = false;
    setState({ data: null, error: null, loading: true });

    fetcher(ac.signal)
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((err) => {
        if (cancelled || ac.signal.aborted) return;
        setState({ data: null, error: err instanceof Error ? err.message : String(err), loading: false });
      });

    return () => {
      cancelled = true;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  return state;
}

/**
 * Real candles + the engine's own setup for one instrument, fetched on demand.
 *
 * This exists so there is exactly one way to get real OHLC in the client.
 *
 * Do NOT reconstruct candles from `AssetRow.spark`. `spark` is a close-only
 * series, so `open = previous close` and `high/low = max/min of two closes`
 * produce wicks that never happened in the market ΓÇö a chart that looks right
 * and is wrong, which is the one failure mode this product is built to avoid.
 * While this is loading, say so; on failure, say why.
 */
export function useAssetDetail(assetId: string | null): AsyncState<AssetDetail> {
  return useLazy<AssetDetail>(
    (signal) =>
      fetch(`/api/asset/${assetId}`, { signal }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    !!assetId,
    assetId,
  );
}
