import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DraftStreamer, DRAFT_PLACEHOLDER } from '../../src/telegram/draftStreamer.ts';

describe('DraftStreamer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('start() sends the placeholder draft immediately', async () => {
    const sendDraft = vi.fn().mockResolvedValue(undefined);
    const s = new DraftStreamer({ sendDraft }, 7);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendDraft).toHaveBeenCalledWith(DRAFT_PLACEHOLDER, 7);
    void s.finish();
  });

  it('re-sends the placeholder while no deltas arrive (drafts expire after ~30s)', async () => {
    const sendDraft = vi.fn().mockResolvedValue(undefined);
    const s = new DraftStreamer({ sendDraft }, 7, { intervalMs: 1000, keepaliveMs: 20_000 });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendDraft).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendDraft).toHaveBeenCalledTimes(2);
    expect(sendDraft).toHaveBeenLastCalledWith(DRAFT_PLACEHOLDER, 7);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendDraft).toHaveBeenCalledTimes(3);
    // Once real text streams, keepalive ticks no longer send the placeholder.
    // (1000ms: the delta lands inside the throttle window of the last keepalive.)
    s.onDelta('Hi');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendDraft).toHaveBeenLastCalledWith('Hi', 7);
    const callsAfterDelta = sendDraft.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendDraft.mock.calls.slice(callsAfterDelta).every(([text]) => text === 'Hi')).toBe(true);
    void s.finish();
  });

  it('throttles deltas to one draft per interval, sending accumulated text', async () => {
    const sendDraft = vi.fn().mockResolvedValue(undefined);
    const s = new DraftStreamer({ sendDraft }, 7, { intervalMs: 1000 });
    s.onDelta('Hel');
    await vi.advanceTimersByTimeAsync(0);
    expect(sendDraft).toHaveBeenLastCalledWith('Hel', 7); // leading edge
    s.onDelta('lo ');
    s.onDelta('world');
    await vi.advanceTimersByTimeAsync(999);
    expect(sendDraft).toHaveBeenCalledTimes(1); // still inside the window
    await vi.advanceTimersByTimeAsync(1);
    expect(sendDraft).toHaveBeenLastCalledWith('Hello world', 7); // trailing edge
  });

  it('finish() cancels pending flushes and the keepalive', async () => {
    const sendDraft = vi.fn().mockResolvedValue(undefined);
    const s = new DraftStreamer({ sendDraft }, 7, { intervalMs: 1000 });
    s.start();
    s.onDelta('a');
    await vi.advanceTimersByTimeAsync(0);
    s.onDelta('b');
    void s.finish();
    await vi.runAllTimersAsync();
    expect(sendDraft).toHaveBeenCalledTimes(1); // only the leading flush
  });

  it('swallows sendDraft errors (drafts are best-effort)', async () => {
    const sendDraft = vi.fn().mockRejectedValue(new Error('network'));
    const s = new DraftStreamer({ sendDraft }, 7);
    s.onDelta('x');
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
  });

  it('never overlaps sends: a flush during an in-flight send waits, then sends the latest text', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const resolvers: Array<() => void> = [];
    const sendDraft = vi.fn().mockImplementation(() => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      return new Promise<void>((resolve) => {
        resolvers.push(() => {
          inflight--;
          resolve();
        });
      });
    });
    const s = new DraftStreamer({ sendDraft }, 7, { intervalMs: 1000 });
    s.onDelta('Hel');
    await vi.advanceTimersByTimeAsync(0);
    expect(sendDraft).toHaveBeenCalledTimes(1); // first send in flight (unresolved)
    s.onDelta('lo');
    await vi.advanceTimersByTimeAsync(1000); // second flush fires while first in flight
    expect(sendDraft).toHaveBeenCalledTimes(1); // must NOT start a concurrent send
    s.onDelta(' world');
    resolvers.shift()!(); // first send settles
    await vi.runAllTimersAsync();
    expect(sendDraft).toHaveBeenCalledTimes(2);
    expect(sendDraft).toHaveBeenLastCalledWith('Hello world', 7); // latest accumulated text
    resolvers.shift()!();
    await vi.runAllTimersAsync();
    expect(maxInflight).toBe(1); // never concurrent
  });

  it('finish() resolves only after the in-flight send settles, and no send starts after', async () => {
    let resolveSend!: () => void;
    const sendDraft = vi
      .fn()
      .mockImplementation(() => new Promise<void>((resolve) => (resolveSend = resolve)));
    const s = new DraftStreamer({ sendDraft }, 7, { intervalMs: 1000 });
    s.onDelta('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(sendDraft).toHaveBeenCalledTimes(1); // in flight
    s.onDelta('b');
    let finished = false;
    const done = s.finish().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false); // still waiting on the in-flight send
    resolveSend();
    await done;
    expect(finished).toBe(true);
    await vi.runAllTimersAsync();
    expect(sendDraft).toHaveBeenCalledTimes(1); // nothing started after finish()
  });
});
