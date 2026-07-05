import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PENDING_ASK_TTL_MS, Session } from '../../src/agent/session.ts';

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

  describe('pending ask lifecycle', () => {
    it('setPendingAsk stamps the TTL from the session clock', () => {
      const t = 1_000_000;
      const s = new Session({ idleTimeoutMs: 60_000, now: () => t });
      s.setPendingAsk('ask_1', [{ callId: 'mem_1', output: 'ok' }]);
      expect(s.pendingAskCallId).toBe('ask_1');
      expect(s.pendingAskExpiresAt).toBe(1_000_000 + PENDING_ASK_TTL_MS);
      expect(s.pendingToolOutputs).toEqual([{ callId: 'mem_1', output: 'ok' }]);
    });

    it('consumePendingAsk returns live before the TTL and clears the state', () => {
      const t = 1_000_000;
      const s = new Session({ idleTimeoutMs: 60_000, now: () => t });
      s.setPendingAsk('ask_1', [{ callId: 'mem_1', output: 'ok' }]);

      const consumed = s.consumePendingAsk();
      expect(consumed.state).toBe('live');
      if (consumed.state === 'none') {
        throw new Error('unreachable');
      }
      expect(consumed.callId).toBe('ask_1');
      expect(consumed.stashed).toEqual([{ callId: 'mem_1', output: 'ok' }]);
      // Consumed: the session no longer carries the ask.
      expect(s.pendingAskCallId).toBeUndefined();
      expect(s.pendingToolOutputs).toBeUndefined();
      expect(s.consumePendingAsk().state).toBe('none');
    });

    it('consumePendingAsk reports expired after the TTL', () => {
      let t = 1_000_000;
      const s = new Session({ idleTimeoutMs: 600_000, now: () => t });
      s.setPendingAsk('ask_1', []);
      t += PENDING_ASK_TTL_MS + 1;

      const consumed = s.consumePendingAsk();
      expect(consumed.state).toBe('expired');
      if (consumed.state === 'none') {
        throw new Error('unreachable');
      }
      expect(consumed.callId).toBe('ask_1');
      expect(s.pendingAskCallId).toBeUndefined();
    });

    it('restorePendingAsk brings the ask back after a failed OpenAI call', () => {
      const t = 1_000_000;
      const s = new Session({ idleTimeoutMs: 60_000, now: () => t });
      s.setPendingAsk('ask_1', [{ callId: 'mem_1', output: 'ok' }]);
      const consumed = s.consumePendingAsk();
      if (consumed.state === 'none') {
        throw new Error('unreachable');
      }

      s.restorePendingAsk(consumed.snapshot);
      expect(s.pendingAskCallId).toBe('ask_1');
      expect(s.pendingAskExpiresAt).toBe(1_000_000 + PENDING_ASK_TTL_MS);
      expect(s.pendingToolOutputs).toEqual([{ callId: 'mem_1', output: 'ok' }]);
    });

    it('consumePendingAsk returns none on a fresh session', () => {
      const s = new Session({ idleTimeoutMs: 60_000 });
      expect(s.consumePendingAsk()).toEqual({ state: 'none' });
    });
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

    it('restores pendingAskExpiresAt so the ask TTL survives a restart', () => {
      const s = new Session({
        idleTimeoutMs: Number.POSITIVE_INFINITY,
        persistence: {
          chatId: 42,
          adapter: {
            get: () => ({
              lastResponseId: 'resp_persisted',
              pendingAskCallId: 'call_ask',
              pendingAskExpiresAt: 123_456,
            }),
            save: () => {},
            delete: () => {},
          },
        },
      });
      expect(s.pendingAskCallId).toBe('call_ask');
      expect(s.pendingAskExpiresAt).toBe(123_456);
    });

    it('persists pendingAskExpiresAt on commit', () => {
      const saved: Array<[number, Record<string, unknown>]> = [];
      const s = new Session({
        idleTimeoutMs: Number.POSITIVE_INFINITY,
        persistence: {
          chatId: 7,
          adapter: {
            get: () => null,
            save: (chatId, record) => saved.push([chatId, record as Record<string, unknown>]),
            delete: () => {},
          },
        },
      });
      s.pendingAskCallId = 'call_ask';
      s.pendingAskExpiresAt = 999;
      s.commit('resp_new');
      expect(saved[0]?.[1]).toMatchObject({
        pendingAskCallId: 'call_ask',
        pendingAskExpiresAt: 999,
      });
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
      expect(saved).toEqual([
        [
          7,
          {
            lastResponseId: 'resp_new',
            pendingAskCallId: undefined,
            pendingToolOutputs: undefined,
          },
        ],
      ]);
      s.reset();
      expect(deleted).toEqual([7]);
    });
  });
});
