import type { Candle } from '../../shared/types';

/**
 * Minimal IndexedDB cache for the 1m candle history used by the volume-profile
 * view. One object store, keyed by symbol; each entry is `{ storedAt, candles }`
 * with candles sorted oldest-first. No external dependency, and every public
 * function degrades to a no-op when the browser blocks the API (private mode,
 * disabled storage), which the caller must treat as "no cache".
 */

const DB_NAME = 'orderflow-volprofile';
const STORE = 'klines1m';
const VERSION = 1;

export interface KlineCacheEntry {
  storedAt: number;
  candles: Candle[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch (err) {
      reject(err as Error);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'symbol' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let request: IDBRequest<T>;
        try {
          const t = db.transaction(STORE, mode);
          request = run(t.objectStore(STORE));
          t.oncomplete = () => resolve(request.result);
          t.onerror = () => reject(t.error ?? new Error('IndexedDB tx failed'));
          t.onabort = () => reject(t.error ?? new Error('IndexedDB tx aborted'));
        } catch (err) {
          reject(err as Error);
        }
      }),
  );
}

export function readKlineCache(symbol: string): Promise<KlineCacheEntry | null> {
  return tx<KlineCacheEntry | null>('readonly', (store) => store.get(symbol) as IDBRequest<KlineCacheEntry | null>)
    .catch(() => null);
}

export function writeKlineCache(symbol: string, entry: KlineCacheEntry): Promise<void> {
  return tx<void>('readwrite', (store) => store.put({ symbol, ...entry }) as unknown as IDBRequest<void>)
    .catch(() => undefined);
}
