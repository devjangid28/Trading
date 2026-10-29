import { TERMINAL } from '../config.js';
import { terminalBook } from './data.js';
import { pruneTerminalHistory, recordTerminalBook } from './historyStore.js';

const timers = new Map<string, ReturnType<typeof setInterval>>();
const inflight = new Set<string>();
const lastUsed = new Map<string, number>();
const lastError = new Map<string, number>();
let pruneTimer: ReturnType<typeof setInterval> | undefined;
let enabled = false;

function prune(): void {
  try {
    pruneTerminalHistory();
  } catch (err) {
    console.warn('[terminal] history prune failed:', (err as Error).message);
  }
}

async function sample(symbol: string): Promise<void> {
  if (!enabled || inflight.has(symbol)) return;
  inflight.add(symbol);
  try {
    const book = await terminalBook(symbol, 'nonessential');
    recordTerminalBook(book);
    lastError.delete(symbol);
  } catch (err) {
    const now = Date.now();
    if (now - (lastError.get(symbol) ?? 0) > 60_000) {
      lastError.set(symbol, now);
      console.warn(`[terminal] ${symbol} history sample failed:`, (err as Error).message);
    }
  } finally {
    inflight.delete(symbol);
  }
}

function stop(symbol: string): void {
  const timer = timers.get(symbol);
  if (timer) clearInterval(timer);
  timers.delete(symbol);
  lastUsed.delete(symbol);
}

function oldest(): string | null {
  let found: string | null = null;
  let at = Infinity;
  for (const [symbol, used] of lastUsed) {
    if (used < at) {
      at = used;
      found = symbol;
    }
  }
  return found;
}

/**
 * Capture one symbol at a time, at the same cadence as the live heatmap.
 *
 * This is the only genuine history source for spot depth: Binance's public
 * archive has no spot bookDepth series, so the server records what it actually
 * observes. A second symbol is allowed because users switch markets; the oldest
 * inactive capture is stopped before a third starts.
 */
export function touchTerminalSymbol(symbol: string): void {
  if (!enabled) return;
  lastUsed.set(symbol, Date.now());
  if (timers.has(symbol)) return;

  while (timers.size >= TERMINAL.HISTORY_MAX_SYMBOLS) {
    const victim = oldest();
    if (!victim || victim === symbol) break;
    stop(victim);
  }

  void sample(symbol);
  const timer = setInterval(() => void sample(symbol), TERMINAL.HISTORY_SAMPLE_MS);
  timer.unref();
  timers.set(symbol, timer);
}

export function startTerminalRecorder(initialSymbols: readonly string[] = ['BTCUSDT']): void {
  if (enabled || process.env.ORDERFLOW_MOCK === '1') return;
  enabled = true;
  prune();
  pruneTimer = setInterval(prune, TERMINAL.HISTORY_PRUNE_MS);
  pruneTimer.unref();
  for (const symbol of initialSymbols) touchTerminalSymbol(symbol);
  if (timers.size) {
    console.log(`[terminal] depth history capture on: ${[...timers.keys()].join(', ')}`);
  }
}

export function stopTerminalRecorder(): void {
  enabled = false;
  for (const symbol of [...timers.keys()]) stop(symbol);
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = undefined;
}
