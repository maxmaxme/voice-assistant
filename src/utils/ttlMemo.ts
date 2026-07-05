/** Memoize an async fetcher for `ttlMs`. Concurrent callers share the
 *  in-flight promise (the memo stores the promise, not the value), a rejected
 *  fetch is evicted so the next call retries, and a fresh process always
 *  fetches fresh on first use. */
export function memoWithTtl<T>(fetcher: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let cached: { value: Promise<T>; fetchedAt: number } | null = null;
  return () => {
    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      return cached.value;
    }
    const entry = { value: fetcher(), fetchedAt: Date.now() };
    cached = entry;
    entry.value.catch(() => {
      if (cached === entry) {
        cached = null;
      }
    });
    return entry.value;
  };
}
