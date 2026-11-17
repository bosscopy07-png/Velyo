/**
 * Tiny in-process micro-cache with request coalescing, so a traffic spike
 * (e.g. 1,000 visitors opening a page at once) becomes ONE database query per
 * TTL instead of 1,000. Used ONLY for display data. Claim decisions never use it.
 */
const store = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  let p = inflight.get(key) as Promise<T> | undefined;
  if (!p) {
    p = fn()
      .then((v) => {
        if (store.size > 2000) store.clear();
        store.set(key, { at: Date.now(), value: v });
        return v;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}
