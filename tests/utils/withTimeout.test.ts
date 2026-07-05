import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { raceWithTimeout } from '../../src/utils/withTimeout.ts';

describe('raceWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves "completed" when the work finishes before the deadline', async () => {
    const result = raceWithTimeout(Promise.resolve(), 5000);
    await expect(result).resolves.toBe('completed');
  });

  it('resolves "timeout" when the work hangs past the deadline', async () => {
    const never = new Promise<void>(() => {});
    const result = raceWithTimeout(never, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toBe('timeout');
  });

  it('resolves "completed" even when the work rejects (shutdown must not throw)', async () => {
    const result = raceWithTimeout(Promise.reject(new Error('boom')), 5000);
    await expect(result).resolves.toBe('completed');
  });
});
