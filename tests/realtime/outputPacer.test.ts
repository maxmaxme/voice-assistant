import { describe, it, expect, vi, afterEach } from 'vitest';
import { OutputPacer } from '../../src/realtime/outputPacer.ts';

afterEach(() => {
  vi.useRealTimers();
});

// 48 bytes per ms — PCM16 mono @ 24 kHz.
function pcmMs(ms: number): Buffer {
  return Buffer.alloc(ms * 48);
}

describe('OutputPacer with pacing off (paceMs = 0)', () => {
  it('forwards each chunk verbatim, immediately', () => {
    const send = vi.fn();
    const pacer = new OutputPacer(0, send);
    const chunk = pcmMs(50);
    pacer.enqueue(chunk);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(chunk);
  });

  it('runs afterDrain actions immediately', () => {
    const pacer = new OutputPacer(0, vi.fn());
    const fn = vi.fn();
    pacer.enqueue(pcmMs(50));
    pacer.afterDrain(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('OutputPacer with pacing on', () => {
  it('buffers chunks and meters them out in paceMs frames', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const pacer = new OutputPacer(20, send);
    // 50ms of audio → three 20ms frames (960 + 960 + 480 bytes).
    pacer.enqueue(pcmMs(50));
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]![0] as Buffer).length).toBe(960);
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(3);
    expect((send.mock.calls[2]![0] as Buffer).length).toBe(480);
  });

  it('defers afterDrain actions until the queue empties', async () => {
    vi.useFakeTimers();
    const pacer = new OutputPacer(20, vi.fn());
    const fn = vi.fn();
    pacer.enqueue(pcmMs(40)); // two frames
    pacer.afterDrain(fn);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(40);
    // Both frames sent, but the drain tick that notices emptiness is next.
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs afterDrain immediately when the queue is already empty', () => {
    const pacer = new OutputPacer(20, vi.fn());
    const fn = vi.fn();
    pacer.afterDrain(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush drops the buffered tail and the deferred actions', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const pacer = new OutputPacer(20, send);
    const fn = vi.fn();
    pacer.enqueue(pcmMs(100));
    pacer.afterDrain(fn);
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);

    pacer.flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('never splits a PCM16 sample across frames (even byte counts)', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    // 1ms frames → 48 bytes each, already even; also exercise the rounding.
    const pacer = new OutputPacer(1, send);
    pacer.enqueue(pcmMs(3));
    await vi.advanceTimersByTimeAsync(5);
    for (const call of send.mock.calls) {
      expect((call[0] as Buffer).length % 2).toBe(0);
    }
  });
});
