import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// We mock `child_process` and `node:os` so we exercise the aplay path
// regardless of the host OS we run tests on.
vi.mock('node:os', () => ({ platform: () => 'linux' }));

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

// Import after mocks so the module picks them up.
const { NodeSpeakerOutput } = await import('../../src/audio/speakerOutput.ts');

class FakeStdin extends EventEmitter {
  destroyed = false;
  write = vi.fn(() => true);
  end = vi.fn();
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
}

class FakeProc extends EventEmitter {
  stdin = new FakeStdin();
  kill = vi.fn();
}

function makeFakeProc(): FakeProc {
  return new FakeProc();
}

async function streamFrom(
  chunks: Buffer[],
  sampleRate = 24000,
): Promise<{
  chunks: AsyncIterable<Buffer>;
  sampleRate: number;
}> {
  return {
    sampleRate,
    chunks: (async function* () {
      for (const c of chunks) {
        yield c;
      }
    })(),
  };
}

beforeEach(() => spawnMock.mockReset());
afterEach(() => vi.clearAllMocks());

describe('NodeSpeakerOutput.playStream (aplay)', () => {
  it('spawns aplay with the right flags and writes each chunk to stdin', async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const speaker = new NodeSpeakerOutput();

    const stream = await streamFrom([Buffer.from([1, 2]), Buffer.from([3, 4])], 24000);
    const playPromise = speaker.playStream(stream);

    // Give the for-await loop a chance to drain both chunks.
    await new Promise((r) => setImmediate(r));
    proc.emit('exit');
    await playPromise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe('aplay');
    expect(args).toEqual(['-q', '-t', 'raw', '-f', 'S16_LE', '-r', '24000', '-c', '1']);
    expect(proc.stdin.write).toHaveBeenCalledTimes(2);
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);
  });

  it('respects backpressure: waits for drain when write() returns false', async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    let firstWriteSettled = false;
    proc.stdin.write = vi.fn(() => {
      firstWriteSettled = true;
      return false; // signal backpressure
    });

    const speaker = new NodeSpeakerOutput();
    const stream = await streamFrom([Buffer.from([1]), Buffer.from([2])]);
    const playPromise = speaker.playStream(stream);

    // First write happened, but we should be blocked awaiting drain.
    await new Promise((r) => setImmediate(r));
    expect(firstWriteSettled).toBe(true);
    expect(proc.stdin.write).toHaveBeenCalledTimes(1); // not 2 yet

    proc.stdin.emit('drain');
    await new Promise((r) => setImmediate(r));
    expect(proc.stdin.write).toHaveBeenCalledTimes(2);

    proc.emit('exit');
    await playPromise;
  });

  it('aborts the pipe and resolves cleanly when signal fires', async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const speaker = new NodeSpeakerOutput();
    const ctrl = new AbortController();

    // never-ending stream
    const stream = {
      sampleRate: 24000,
      chunks: (async function* () {
        for (;;) {
          yield Buffer.from([0]);
          await new Promise((r) => setImmediate(r));
        }
      })(),
    };
    const playPromise = speaker.playStream(stream, { signal: ctrl.signal });

    await new Promise((r) => setImmediate(r));
    ctrl.abort();
    // stop() destroys stdin and SIGTERMs proc; we simulate the exit.
    expect(proc.kill).toHaveBeenCalled();
    proc.emit('exit');

    await expect(playPromise).resolves.toBeUndefined();
  });
});
