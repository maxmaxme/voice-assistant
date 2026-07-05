import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { memoWithTtl } from '../../src/utils/ttlMemo.ts';

describe('memoWithTtl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches once and reuses the value within the TTL', async () => {
    const fetcher = vi.fn(async () => ['tool-a']);
    const memo = memoWithTtl(fetcher, 60_000);
    await expect(memo()).resolves.toEqual(['tool-a']);
    await expect(memo()).resolves.toEqual(['tool-a']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight fetch across concurrent callers', async () => {
    let resolveFetch!: (v: string[]) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const memo = memoWithTtl(fetcher, 60_000);
    const a = memo();
    const b = memo();
    resolveFetch(['tool-a']);
    await expect(a).resolves.toEqual(['tool-a']);
    await expect(b).resolves.toEqual(['tool-a']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    const fetcher = vi.fn(async () => ['tool-a']);
    const memo = memoWithTtl(fetcher, 60_000);
    await memo();
    vi.advanceTimersByTime(60_001);
    await memo();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed fetch', async () => {
    const fetcher = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('ha down'))
      .mockResolvedValueOnce(['tool-a']);
    const memo = memoWithTtl(fetcher, 60_000);
    await expect(memo()).rejects.toThrow('ha down');
    await expect(memo()).resolves.toEqual(['tool-a']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
