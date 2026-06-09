import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DraftStreamer } from '../../src/telegram/draftStreamer.ts';

describe('DraftStreamer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('start() sends an empty draft (Thinking… placeholder)', async () => {
    const sendDraft = vi.fn().mockResolvedValue(undefined);
    const s = new DraftStreamer({ sendDraft }, 7);
    s.start();
    await vi.runAllTimersAsync();
    expect(sendDraft).toHaveBeenCalledWith('', 7);
  });

  it('throttles deltas to one draft per interval, sending accumulated text', async () => {
    const sendDraft = vi.fn().mockResolvedValue(undefined);
    const s = new DraftStreamer({ sendDraft }, 7, 1000);
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

  it('finish() cancels pending flushes', async () => {
    const sendDraft = vi.fn().mockResolvedValue(undefined);
    const s = new DraftStreamer({ sendDraft }, 7, 1000);
    s.onDelta('a');
    await vi.advanceTimersByTimeAsync(0);
    s.onDelta('b');
    s.finish();
    await vi.runAllTimersAsync();
    expect(sendDraft).toHaveBeenCalledTimes(1); // only the leading flush
  });

  it('swallows sendDraft errors (drafts are best-effort)', async () => {
    const sendDraft = vi.fn().mockRejectedValue(new Error('network'));
    const s = new DraftStreamer({ sendDraft }, 7);
    s.onDelta('x');
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
  });
});
