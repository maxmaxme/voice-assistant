import { describe, it, expect, vi, afterEach } from 'vitest';
import { OutputPacer } from '../../src/realtime/outputPacer.ts';
import { captureLogs } from '../helpers/captureLogs.ts';

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

  it('drops queued audio instead of sending when the device socket is backed up', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    let buffered = 0;
    const pacer = new OutputPacer(20, send, () => buffered);
    const logs = captureLogs();
    try {
      pacer.enqueue(pcmMs(100));
      buffered = 60_000; // > 1s of audio queued on the socket
      await vi.advanceTimersByTimeAsync(200);
      expect(send).not.toHaveBeenCalled();
      expect(logs.text()).toMatch(/dropping paced audio/);
    } finally {
      logs.restore();
    }
  });

  it('warns once per stall episode, not per tick', async () => {
    vi.useFakeTimers();
    const buffered = 60_000;
    const pacer = new OutputPacer(20, vi.fn(), () => buffered);
    const logs = captureLogs();
    try {
      pacer.enqueue(pcmMs(100));
      await vi.advanceTimersByTimeAsync(20);
      pacer.enqueue(pcmMs(100));
      await vi.advanceTimersByTimeAsync(200);
      const warns = logs.text().match(/dropping paced audio/g) ?? [];
      expect(warns.length).toBe(1);
    } finally {
      logs.restore();
    }
  });

  it('resumes sending (and re-arms the warn) after the socket drains', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    let buffered = 60_000;
    const pacer = new OutputPacer(20, send, () => buffered);
    const logs = captureLogs();
    try {
      pacer.enqueue(pcmMs(40));
      await vi.advanceTimersByTimeAsync(60); // stalled episode drops everything
      expect(send).not.toHaveBeenCalled();

      buffered = 0;
      pacer.enqueue(pcmMs(20));
      await vi.advanceTimersByTimeAsync(20);
      expect(send).toHaveBeenCalledTimes(1);

      buffered = 60_000;
      pacer.enqueue(pcmMs(20));
      await vi.advanceTimersByTimeAsync(20);
      const warns = logs.text().match(/dropping paced audio/g) ?? [];
      expect(warns.length).toBe(2);
    } finally {
      logs.restore();
    }
  });

  it('still runs afterDrain actions after a backpressure drop', async () => {
    vi.useFakeTimers();
    const pacer = new OutputPacer(20, vi.fn(), () => 60_000);
    const fn = vi.fn();
    pacer.enqueue(pcmMs(100));
    pacer.afterDrain(fn);
    await vi.advanceTimersByTimeAsync(60);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('with pacing off, forwards verbatim regardless of bufferedAmount (legacy burst)', () => {
    const send = vi.fn();
    const pacer = new OutputPacer(0, send, () => 1_000_000);
    pacer.enqueue(pcmMs(50));
    expect(send).toHaveBeenCalledTimes(1);
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
