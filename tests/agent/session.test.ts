import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Session } from '../../src/agent/session.ts';

describe('Session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns undefined on the very first begin()', () => {
    const s = new Session({ idleTimeoutMs: 60_000 });
    expect(s.begin()).toBeUndefined();
    expect(s.isFresh()).toBe(true);
  });

  it('begin() returns the last committed id within the idle window', () => {
    const s = new Session({ idleTimeoutMs: 60_000 });
    s.begin();
    s.commit('resp_1');
    vi.advanceTimersByTime(30_000);
    expect(s.begin()).toBe('resp_1');
    expect(s.isFresh()).toBe(false);
  });

  it('drops the chain after the idle timeout', () => {
    const s = new Session({ idleTimeoutMs: 1000 });
    s.begin();
    s.commit('resp_1');
    vi.advanceTimersByTime(1001);
    expect(s.begin()).toBeUndefined();
    expect(s.isFresh()).toBe(true);
  });

  it('quick consecutive begins keep the chain alive', () => {
    const s = new Session({ idleTimeoutMs: 1000 });
    s.begin();
    s.commit('resp_1');
    vi.advanceTimersByTime(900);
    expect(s.begin()).toBe('resp_1');
    vi.advanceTimersByTime(900); // would have been stale without the begin() touch
    expect(s.begin()).toBe('resp_1');
  });

  it('reset() clears the chain immediately', () => {
    const s = new Session({ idleTimeoutMs: 60_000 });
    s.commit('resp_1');
    s.reset();
    expect(s.begin()).toBeUndefined();
  });

  describe('persistence', () => {
    it('loads from adapter on construction', () => {
      const s = new Session({
        idleTimeoutMs: Number.POSITIVE_INFINITY,
        persistence: {
          chatId: 42,
          adapter: {
            get: () => ({ lastResponseId: 'resp_persisted' }),
            save: () => {},
            delete: () => {},
          },
        },
      });
      expect(s.begin()).toBe('resp_persisted');
    });

    it('writes on commit and deletes on reset', () => {
      const saved: Array<[number, unknown]> = [];
      const deleted: number[] = [];
      const s = new Session({
        idleTimeoutMs: Number.POSITIVE_INFINITY,
        persistence: {
          chatId: 7,
          adapter: {
            get: () => null,
            save: (chatId, record) => saved.push([chatId, record]),
            delete: (chatId) => deleted.push(chatId),
          },
        },
      });
      s.commit('resp_new');
      expect(saved).toEqual([[7, { lastResponseId: 'resp_new', pendingAskCallId: undefined }]]);
      s.reset();
      expect(deleted).toEqual([7]);
    });
  });
});
