import { useEffect, useRef, useState } from 'react';
import type { TerminalBook, TerminalTrade } from '../../shared/types';
import { api } from '../lib/api';
import {
  appendBookFrame, BOOK_HISTORY_LIMIT, frameFromBook, mergeTrades, type BookFrame,
} from './math';
import {
  applyDepthUpdate, bookFromDepth, parseAggTrade, seedDepth,
  type DepthBook, type DepthUpdate,
} from './liveBook';

const FALLBACK_POLL_MS = 3_000;
const LIVE_SAMPLE_MS = 1_000;
const STALE_AFTER_MS = 3_000;
const RECONNECT_BASE_MS = 600;
const RECONNECT_MAX_MS = 15_000;
const PENDING_LIMIT = 1_000;

export type TerminalStreamState = 'CONNECTING' | 'LIVE' | 'STALE' | 'DISCONNECTED';

export interface TerminalBookStats {
  messagesPerSec: number;
  resyncs: number;
  reconnects: number;
  lastEventAt: number | null;
  lastTradeAt: number | null;
}

export interface TerminalBookState {
  book: TerminalBook | null;
  frames: BookFrame[];
  trades: TerminalTrade[];
  loading: boolean;
  error: string | null;
  tapeError: string | null;
  streamState: TerminalStreamState;
  stats: TerminalBookStats;
}

function wsUrl(symbol: string): string {
  const pair = symbol.toLowerCase();
  return `wss://data-stream.binance.vision/stream?streams=${pair}@depth@100ms/${pair}@aggTrade`;
}

export function useTerminalBook(symbol: string, enabled = true, live = true): TerminalBookState {
  const [book, setBook] = useState<TerminalBook | null>(null);
  const [frames, setFrames] = useState<BookFrame[]>([]);
  const [trades, setTrades] = useState<TerminalTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tapeError, setTapeError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<TerminalStreamState>('CONNECTING');
  const [stats, setStats] = useState<TerminalBookStats>({
    messagesPerSec: 0,
    resyncs: 0,
    reconnects: 0,
    lastEventAt: null,
    lastTradeAt: null,
  });
  const resetRef = useRef(symbol);

  useEffect(() => {
    resetRef.current = symbol;
    setBook(null);
    setFrames([]);
    setTrades([]);
    setLoading(true);
    setError(null);
    setTapeError(null);
    setStreamState('CONNECTING');
    setStats({ messagesPerSec: 0, resyncs: 0, reconnects: 0, lastEventAt: null, lastTradeAt: null });
  }, [symbol]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let ws: WebSocket | null = null;
    let wsOpen = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let sampleTimer: ReturnType<typeof setInterval> | undefined;
    let healthTimer: ReturnType<typeof setInterval> | undefined;
    let resyncing = false;
    let base: TerminalBook | null = null;
    let depth: DepthBook | null = null;
    let pending: DepthUpdate[] = [];
    let newTrades: TerminalTrade[] = [];
    let lastEventAt = 0;
    let lastSampleAt = 0;
    let publishedUpdateId = -1;
    let resyncCount = 0;
    let reconnectCount = 0;
    let lastTradeAt: number | null = null;
    let messageTimes: number[] = [];
    const controller = new AbortController();

    const publish = (force = false) => {
      if (cancelled || !base || !depth) return;
      const now = Date.now();
      const due = force || now - lastSampleAt >= LIVE_SAMPLE_MS - 80;
      if (!due) return;
      lastSampleAt = now;
      if (force || depth.lastUpdateId !== publishedUpdateId) {
        const next = bookFromDepth(base, depth, now, LIVE_SAMPLE_MS);
        if (!next) return;
        publishedUpdateId = depth.lastUpdateId;
        setBook(next);
        setFrames((prev) => appendBookFrame(prev, frameFromBook(next), BOOK_HISTORY_LIMIT));
      }
      if (newTrades.length) {
        const incoming = newTrades;
        newTrades = [];
        lastTradeAt = incoming[incoming.length - 1].t;
        setTrades((prev) => mergeTrades(prev, incoming, 5_000));
      }
      messageTimes = messageTimes.filter((t) => now - t <= 5_000);
      setStats({
        messagesPerSec: messageTimes.length / 5,
        resyncs: resyncCount,
        reconnects: reconnectCount,
        lastEventAt: lastEventAt || null,
        lastTradeAt,
      });
      setLoading(false);
      setError(null);
      if (wsOpen) {
        setStreamState(Date.now() - lastEventAt > STALE_AFTER_MS ? 'STALE' : 'LIVE');
      }
    };

    const applySnapshot = (snapshot: TerminalBook) => {
      base = snapshot;
      depth = seedDepth(snapshot);
      setBook(snapshot);
      setTrades((prev) => mergeTrades(prev, snapshot.trades ?? [], 5_000));
      setTapeError(snapshot.tradesAvailable ? null : snapshot.tradeError ?? 'trade tape unavailable');
      setLoading(false);
      setError(null);
      const queued = pending;
      pending = [];
      for (const update of queued) {
        if (!depth) break;
        const result = applyDepthUpdate(depth, update);
        if (result === 'gap') {
          pending = queued.slice(queued.indexOf(update));
          depth = null;
          base = null;
          resyncing = false;
          scheduleResync(250);
          return;
        }
      }
      publish(true);
    };

    const fetchSnapshot = async (retry = 0) => {
      if (cancelled || resyncing) return;
      resyncing = true;
      if (!base) setStreamState('CONNECTING');
      try {
        const snapshot = await api.terminalBook(symbol, controller.signal);
        if (cancelled) return;
        applySnapshot(snapshot);
        resyncing = false;
        if (!wsOpen) setStreamState('DISCONNECTED');
      } catch (err) {
        if (cancelled || (err as Error).name === 'AbortError') return;
        resyncing = false;
        setError((err as Error).message);
        setLoading(false);
        if (!wsOpen) setStreamState('DISCONNECTED');
        if (retry < 6) reconnectTimer = setTimeout(() => void fetchSnapshot(retry + 1), 1_500);
      }
    };

    function scheduleResync(delay = 0) {
      if (cancelled) return;
      resyncCount += 1;
      setStreamState('CONNECTING');
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void fetchSnapshot();
      }, delay);
    }

    const startFallback = () => {
      if (cancelled || fallbackTimer) return;
      const tick = async () => {
        fallbackTimer = undefined;
        if (cancelled || wsOpen) return;
        try {
          const snapshot = await api.terminalBook(symbol, controller.signal);
          if (cancelled || wsOpen) return;
          applySnapshot(snapshot);
          if (!ws) setStreamState('DISCONNECTED');
        } catch (err) {
          if (!cancelled && (err as Error).name !== 'AbortError') {
            setError((err as Error).message);
            setLoading(false);
          }
        } finally {
          if (!cancelled && !wsOpen) fallbackTimer = setTimeout(tick, FALLBACK_POLL_MS);
        }
      };
      fallbackTimer = setTimeout(tick, 0);
    };

    const stopFallback = () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
    };

    const connect = () => {
      if (cancelled) return;
      if (typeof WebSocket === 'undefined') {
        setStreamState('DISCONNECTED');
        startFallback();
        return;
      }
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl(symbol));
      } catch {
        setStreamState('DISCONNECTED');
        startFallback();
        return;
      }
      ws = socket;
      socket.onopen = () => {
        if (cancelled) return;
        wsOpen = true;
        attempt = 0;
        lastEventAt = Date.now();
        stopFallback();
        setStreamState('CONNECTING');
        void fetchSnapshot();
      };
      socket.onmessage = (event) => {
        if (cancelled) return;
        lastEventAt = Date.now();
        messageTimes.push(lastEventAt);
        if (messageTimes.length > 1_000) messageTimes = messageTimes.slice(-1_000);
        let message: { stream?: string; data?: Record<string, unknown> };
        try {
          message = JSON.parse(String(event.data)) as typeof message;
        } catch {
          return;
        }
        const data = message.data;
        if (!data) return;
        const type = data.e;
        if (type === 'depthUpdate') {
          const update = data as unknown as DepthUpdate;
          if (!depth) {
            pending.push(update);
            if (pending.length > PENDING_LIMIT) pending.shift();
            return;
          }
          const result = applyDepthUpdate(depth, update);
          if (result === 'gap') {
            pending.push(update);
            if (pending.length > PENDING_LIMIT) pending.shift();
            depth = null;
            base = null;
            scheduleResync();
          }
          return;
        }
        if (type === 'aggTrade') {
          const trade = parseAggTrade(data as {
            a?: number; p?: string; q?: string; T?: number; m?: boolean;
          });
          if (!trade) return;
          newTrades.push(trade);
          if (newTrades.length > 2_000) newTrades.shift();
        }
      };
      socket.onerror = () => {
        try { socket.close(); } catch { /* already closed */ }
      };
      socket.onclose = () => {
        ws = null;
        wsOpen = false;
        if (cancelled) return;
        reconnectCount += 1;
        setStreamState('DISCONNECTED');
        startFallback();
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt) + Math.random() * 250;
        attempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connect();
        }, delay);
      };
    };

    sampleTimer = setInterval(() => publish(false), LIVE_SAMPLE_MS);
    healthTimer = setInterval(() => {
      if (wsOpen && Date.now() - lastEventAt > STALE_AFTER_MS) setStreamState('STALE');
    }, 1_000);

    if (live) {
      startFallback();
      connect();
    } else {
      const tick = async () => {
        let delay = FALLBACK_POLL_MS;
        try {
          const next = await api.terminalBook(symbol, controller.signal);
          if (cancelled) return;
          delay = next.pollMs > 0 ? next.pollMs : FALLBACK_POLL_MS;
          applySnapshot(next);
          setStreamState('LIVE');
        } catch (err) {
          if (!cancelled && (err as Error).name !== 'AbortError') {
            setError((err as Error).message);
            setLoading(false);
          }
        } finally {
          if (!cancelled) fallbackTimer = setTimeout(tick, delay);
        }
      };
      void tick();
    }

    return () => {
      cancelled = true;
      controller.abort();
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try { ws.close(); } catch { /* already closed */ }
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (sampleTimer) clearInterval(sampleTimer);
      if (healthTimer) clearInterval(healthTimer);
    };
  }, [symbol, enabled, live]);

  return { book, frames, trades, loading, error, tapeError, streamState, stats };
}

