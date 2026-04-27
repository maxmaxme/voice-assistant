/** Fixed-window in-memory rate limiter. Not distributed, not persistent —
 *  fits a single-process Pi runtime. Uses a periodic sweep (timer.unref'd
 *  so it never keeps the event loop alive on its own). */

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  /** Sweep cadence for evicting expired entries. Defaults to windowMs. */
  sweepMs?: number;
  /** Injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
  dispose(): void;
}

interface Entry {
  count: number;
  resetAt: number;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { windowMs, max } = opts;
  const now = opts.now ?? Date.now;
  const sweepMs = opts.sweepMs ?? windowMs;
  const buckets = new Map<string, Entry>();

  const sweep = (): void => {
    const t = now();
    for (const [k, v] of buckets) {
      if (v.resetAt <= t) {
        buckets.delete(k);
      }
    }
  };

  const timer = setInterval(sweep, sweepMs);
  // Allow the process to exit even if the limiter is still alive.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    check(key: string): RateLimitResult {
      const t = now();
      let entry = buckets.get(key);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowMs };
        buckets.set(key, entry);
      }
      entry.count += 1;
      const allowed = entry.count <= max;
      const remaining = Math.max(0, max - entry.count);
      const retryAfterSec = allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
      return { allowed, remaining, retryAfterSec };
    },
    dispose(): void {
      clearInterval(timer);
      buckets.clear();
    },
  };
}

export interface Semaphore {
  /** Returns a release fn on success, null when at capacity. */
  tryAcquire(): (() => void) | null;
  inUse(): number;
}

export function createSemaphore(max: number): Semaphore {
  let inFlight = 0;
  return {
    tryAcquire(): (() => void) | null {
      if (inFlight >= max) {
        return null;
      }
      inFlight += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        inFlight -= 1;
      };
    },
    inUse(): number {
      return inFlight;
    },
  };
}
