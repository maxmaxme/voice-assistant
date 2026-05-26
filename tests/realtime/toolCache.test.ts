import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolResultCache, CACHEABLE_TOOLS } from '../../src/realtime/toolCache.ts';

describe('ToolResultCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined on miss', () => {
    const cache = new ToolResultCache();
    expect(cache.get('GetLiveContext:{}')).toBeUndefined();
  });

  it('returns value within TTL', () => {
    const cache = new ToolResultCache();
    cache.set('GetLiveContext:{}', 'payload', 5000);
    expect(cache.get('GetLiveContext:{}')).toBe('payload');
  });

  it('drops value after TTL expires', () => {
    const cache = new ToolResultCache();
    cache.set('GetLiveContext:{}', 'payload', 5000);
    vi.advanceTimersByTime(5001);
    expect(cache.get('GetLiveContext:{}')).toBeUndefined();
  });

  it('clear() drops everything', () => {
    const cache = new ToolResultCache();
    cache.set('a', '1', 5000);
    cache.set('b', '2', 5000);
    cache.clear('test');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('tracks hits and misses', () => {
    const cache = new ToolResultCache();
    cache.get('miss');
    cache.set('hit', 'v', 5000);
    cache.get('hit');
    cache.get('hit');
    const s = cache.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
  });

  it('lists GetLiveContext as cacheable', () => {
    expect(CACHEABLE_TOOLS.has('GetLiveContext')).toBe(true);
    expect(CACHEABLE_TOOLS.has('HassTurnOn')).toBe(false);
  });
});
