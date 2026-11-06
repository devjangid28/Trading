import type { TerminalTrade } from '../../shared/types';

/**
 * IndexedDB persistence for the recorded whale tape.
 *
 * The live feed only sees trades from the moment the socket opens; a refresh
 * would otherwise wipe the tape and move T0 forward. We persist the merged
 * tape per symbol so a refresh keeps the history that was already recorded
 * (and the REST backfill tops it up to the last 120 minutes).
 */

const DB_NAME = 'orderflow-whales';
const DB_VERSION = 1;
const STORE = 'trades';

interface PersistedTape {
  symbol: string;
  trades: TerminalTrade[];
  savedAt: number;
}

const MAX_TRADES_PER_SYMBOL = 250_000;

function supportsIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!supportsIndexedDb()) {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'symbol' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });
}

async function withStore<T>(action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const request = action(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
    });
  } finally {
    db.close();
  }
}

export async function loadTrades(symbol: string): Promise<TerminalTrade[]> {
  if (!supportsIndexedDb()) return [];
  try {
    const record = await withStore<PersistedTape | undefined>((store) => store.get(symbol.toUpperCase()));
    if (!record || !Array.isArray(record.trades)) return [];
    return record.trades.filter(
      (t): t is TerminalTrade =>
        t && typeof t.id === 'number' && typeof t.t === 'number'
        && typeof t.price === 'number' && typeof t.qty === 'number'
        && typeof t.usd === 'number' && (t.side === 'buy' || t.side === 'sell'),
    );
  } catch {
    return [];
  }
}

export async function saveTrades(symbol: string, trades: readonly TerminalTrade[]): Promise<void> {
  if (!supportsIndexedDb()) return;
  const trimmed = trades.slice(-MAX_TRADES_PER_SYMBOL);
  const record: PersistedTape = {
    symbol: symbol.toUpperCase(),
    trades: trimmed,
    savedAt: Date.now(),
  };
  try {
    await withStore<IDBValidKey>((store) => store.put(record));
  } catch {
    /* persistence is best-effort; a quota failure must not break the chart */
  }
}
