interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Single-flight TTL cache. Concurrent callers for the same key share one
 * upstream request, which matters a lot when 200 symbols refresh on a timer.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.value;

  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const p = producer()
    .then((value) => {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}

export function peek<T>(key: string): T | undefined {
  const hit = store.get(key) as Entry<T> | undefined;
  return hit && hit.expiresAt > Date.now() ? hit.value : undefined;
}

export function setManual<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function cacheStats() {
  let live = 0;
  const now = Date.now();
  for (const e of store.values()) if (e.expiresAt > now) live++;
  return { entries: store.size, live, inflight: inflight.size };
}
