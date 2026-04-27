import { describe, it, expect } from 'vitest';
import { createRateLimiter, createSemaphore } from '../../src/utils/rateLimiter.ts';

describe('createRateLimiter', () => {
  it('allows up to max per window, then blocks', () => {
    const t = 1_000_000;
    const rl = createRateLimiter({ windowMs: 60_000, max: 3, now: () => t });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(true);
    const blocked = rl.check('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    rl.dispose();
  });

  it('resets the counter when the window expires', () => {
    let t = 1_000_000;
    const rl = createRateLimiter({ windowMs: 60_000, max: 1, now: () => t });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(false);
    t += 60_001;
    expect(rl.check('a').allowed).toBe(true);
    rl.dispose();
  });

  it('tracks keys independently', () => {
    const t = 1_000_000;
    const rl = createRateLimiter({ windowMs: 60_000, max: 1, now: () => t });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('b').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(false);
    expect(rl.check('b').allowed).toBe(false);
    rl.dispose();
  });

  it('reports decreasing remaining', () => {
    const t = 1_000_000;
    const rl = createRateLimiter({ windowMs: 60_000, max: 3, now: () => t });
    expect(rl.check('a').remaining).toBe(2);
    expect(rl.check('a').remaining).toBe(1);
    expect(rl.check('a').remaining).toBe(0);
    rl.dispose();
  });
});

describe('createSemaphore', () => {
  it('hands out up to max permits', () => {
    const sem = createSemaphore(2);
    const r1 = sem.tryAcquire();
    const r2 = sem.tryAcquire();
    const r3 = sem.tryAcquire();
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r3).toBeNull();
    expect(sem.inUse()).toBe(2);
  });

  it('frees the slot on release; double-release is a no-op', () => {
    const sem = createSemaphore(1);
    const release = sem.tryAcquire();
    expect(release).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();
    release!();
    release!();
    expect(sem.inUse()).toBe(0);
    expect(sem.tryAcquire()).not.toBeNull();
  });
});
