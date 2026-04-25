# Iteration 5: Streaming TTS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream PCM from `gpt-4o-mini-tts` and feed it into the speaker by chunks instead of waiting for the full buffer. Cuts time-to-first-sound from 2-3 s to ~300 ms; on long replies saves 1-3 s end-to-end.

**Architecture:** Replace `Tts.synthesize()` (returns `Buffer`) with `Tts.stream()` (returns `{sampleRate, chunks: AsyncIterable<Buffer>}`). Replace `SpeakerOutput.play(buf, …)` with `playStream(stream, {signal})`. End-to-end cancellation via `AbortSignal`: orchestrator owns an `AbortController` for the current speech, `stopSpeaking` effect aborts it (HTTP stream + speaker pipe) on barge-in. Backpressure is automatic: speaker's `write()` returns `false` → cycle awaits `'drain'` → AsyncIterator pauses → OpenAI TCP window closes.

**Tech Stack:** TypeScript, OpenAI SDK v6 (Web `ReadableStream` body), Node `child_process` (`aplay` on Linux), `speaker` npm (macOS), Vitest.

**Prerequisite:** Iteration 4 complete (wake-word + FSM working).

**Spec:** [docs/superpowers/specs/2026-04-25-streaming-tts-design.md](../specs/2026-04-25-streaming-tts-design.md)

---

## File Structure

```
src/
├── audio/
│   ├── types.ts             # MODIFY: replace Tts/SpeakerOutput interfaces
│   ├── openaiTts.ts         # MODIFY: stream() instead of synthesize()
│   ├── speakerOutput.ts     # MODIFY: playStream() instead of play()
│   └── streamHelpers.ts     # CREATE: bufferToStream() + isAbortError()
├── orchestrator/
│   └── orchestrator.ts      # MODIFY: AbortController per speak; pass signal
└── cli/
    └── voice.ts             # MODIFY: use stream()/playStream()
tests/
└── audio/
    ├── openaiTts.test.ts    # REWRITE: assert streaming behaviour
    ├── speakerOutput.test.ts # CREATE: spawn-mock-based tests for playStream
    └── streamHelpers.test.ts # CREATE: bufferToStream test
```

Note: There's no existing `tests/audio/speakerOutput.test.ts` — speaker was previously untested because mocking `child_process.spawn` is fiddly. We add it now because the streaming logic (backpressure, abort) deserves coverage.

---

## Task 1: Update Tts and SpeakerOutput interfaces

**Files:**

- Modify: `src/audio/types.ts`

- [ ] **Step 1: Replace the interfaces**

Open `src/audio/types.ts` and replace the `Tts` and `SpeakerOutput` blocks with:

```ts
export interface MicInput {
  /** Records 16-bit mono PCM at the given sample rate until stop() is called. */
  record(opts: { sampleRate: number }): Promise<{ stop(): Promise<Buffer> }>;
}

export interface SpeakerOutput {
  /** Plays a stream of 16-bit mono PCM chunks at the given sample rate.
   *  Resolves when playback ends (all chunks consumed) or when aborted via
   *  signal / stop(). On abort, resolves cleanly (no AbortError thrown). */
  playStream(
    stream: { chunks: AsyncIterable<Buffer>; sampleRate: number },
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
  /** Synchronous hard-cut. No-op if idle. */
  stop(): void;
}

export interface Stt {
  transcribe(audio: Buffer, opts: { sampleRate: number; language?: string }): Promise<string>;
}

export interface TtsStream {
  sampleRate: number;
  chunks: AsyncIterable<Buffer>;
}

export interface Tts {
  stream(
    text: string,
    opts?: { voice?: string; instructions?: string; signal?: AbortSignal },
  ): TtsStream;
}
```

- [ ] **Step 2: Verify compile fails as expected**

Run: `npm run typecheck`
Expected: FAIL — `OpenAiTts`, `NodeSpeakerOutput`, `voice.ts`, `orchestrator.ts` no longer satisfy the interfaces. This is intentional — subsequent tasks fix them.

- [ ] **Step 3: Commit interface change as a checkpoint**

```bash
git add src/audio/types.ts
git commit -m "refactor(audio): switch Tts/Speaker interfaces to streaming"
```

---

## Task 2: Add stream helpers

**Files:**

- Create: `src/audio/streamHelpers.ts`
- Test: `tests/audio/streamHelpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/audio/streamHelpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { bufferToStream, isAbortError } from '../../src/audio/streamHelpers.ts';

describe('bufferToStream', () => {
  it('wraps a buffer as a single-chunk async iterable', async () => {
    const buf = Buffer.from([1, 2, 3, 4]);
    const stream = bufferToStream(buf, 24000);
    expect(stream.sampleRate).toBe(24000);
    const chunks: Buffer[] = [];
    for await (const c of stream.chunks) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].equals(buf)).toBe(true);
  });
});

describe('isAbortError', () => {
  it('returns true for AbortError DOMException', () => {
    const err = new DOMException('aborted', 'AbortError');
    expect(isAbortError(err)).toBe(true);
  });
  it('returns true for errors with name === "AbortError"', () => {
    const err = Object.assign(new Error('x'), { name: 'AbortError' });
    expect(isAbortError(err)).toBe(true);
  });
  it('returns false for other errors', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError('string')).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/audio/streamHelpers.test.ts`
Expected: FAIL — `Cannot find module '.../streamHelpers.ts'`.

- [ ] **Step 3: Implement helpers**

Create `src/audio/streamHelpers.ts`:

```ts
import type { TtsStream } from './types.ts';

export function bufferToStream(buf: Buffer, sampleRate: number): TtsStream {
  return {
    sampleRate,
    chunks: (async function* () {
      yield buf;
    })(),
  };
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: unknown }).name === 'AbortError'
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/audio/streamHelpers.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/audio/streamHelpers.ts tests/audio/streamHelpers.test.ts
git commit -m "feat(audio): add bufferToStream and isAbortError helpers"
```

---

## Task 3: Rewrite OpenAiTts as streaming

**Files:**

- Modify: `src/audio/openaiTts.ts`
- Test: `tests/audio/openaiTts.test.ts` (rewrite)

- [ ] **Step 1: Rewrite the test**

Replace contents of `tests/audio/openaiTts.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { OpenAiTts } from '../../src/audio/openaiTts.ts';

function makeReadableStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

describe('OpenAiTts', () => {
  it('streams PCM chunks from OpenAI as a 24kHz async iterable', async () => {
    const c1 = new Uint8Array([1, 2, 3, 4]);
    const c2 = new Uint8Array([5, 6, 7, 8]);
    const create = vi.fn().mockResolvedValue({ body: makeReadableStream([c1, c2]) });
    const fakeClient = { audio: { speech: { create } } } as never;

    const tts = new OpenAiTts({ client: fakeClient, model: 'gpt-4o-mini-tts', voice: 'alloy' });
    const stream = tts.stream('привет');
    expect(stream.sampleRate).toBe(24000);

    const got: Buffer[] = [];
    for await (const chunk of stream.chunks) got.push(chunk);

    expect(got).toHaveLength(2);
    expect(got[0].equals(Buffer.from(c1))).toBe(true);
    expect(got[1].equals(Buffer.from(c2))).toBe(true);

    const callArgs = create.mock.calls[0][0];
    expect(callArgs.response_format).toBe('pcm');
    expect(callArgs.input).toBe('привет');
    expect(callArgs.model).toBe('gpt-4o-mini-tts');
  });

  it('passes AbortSignal as a request option to the SDK', async () => {
    const create = vi.fn().mockResolvedValue({ body: makeReadableStream([]) });
    const fakeClient = { audio: { speech: { create } } } as never;
    const tts = new OpenAiTts({ client: fakeClient });
    const ctrl = new AbortController();

    const stream = tts.stream('hi', { signal: ctrl.signal });
    // drain so the SDK call actually fires
    for await (const _ of stream.chunks) void _;

    const requestOpts = create.mock.calls[0][1];
    expect(requestOpts.signal).toBe(ctrl.signal);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/audio/openaiTts.test.ts`
Expected: FAIL — `tts.stream is not a function` (still has old `synthesize`).

- [ ] **Step 3: Rewrite the implementation**

Replace contents of `src/audio/openaiTts.ts`:

```ts
import type OpenAI from 'openai';
import type { Tts, TtsStream } from './types.ts';

export interface OpenAiTtsOptions {
  client: OpenAI;
  model?: string;
  voice?: string;
}

const SAMPLE_RATE = 24000;

export class OpenAiTts implements Tts {
  private readonly model: string;
  private readonly voice: string;
  private readonly opts: OpenAiTtsOptions;

  constructor(opts: OpenAiTtsOptions) {
    this.opts = opts;
    this.model = opts.model ?? 'gpt-4o-mini-tts';
    this.voice = opts.voice ?? 'alloy';
  }

  stream(
    text: string,
    opts?: { voice?: string; instructions?: string; signal?: AbortSignal },
  ): TtsStream {
    return {
      sampleRate: SAMPLE_RATE,
      chunks: this.fetchChunks(text, opts),
    };
  }

  private async *fetchChunks(
    text: string,
    opts?: { voice?: string; instructions?: string; signal?: AbortSignal },
  ): AsyncGenerator<Buffer> {
    const res = await this.opts.client.audio.speech.create(
      {
        model: this.model,
        voice: opts?.voice ?? this.voice,
        input: text,
        response_format: 'pcm',
        instructions: opts?.instructions,
      } as never,
      { signal: opts?.signal },
    );

    const body = (res as unknown as { body: ReadableStream<Uint8Array> | null }).body;
    if (!body) return;

    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value && value.byteLength > 0) yield Buffer.from(value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // releaseLock throws if the reader is already errored — safe to ignore
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/audio/openaiTts.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/audio/openaiTts.ts tests/audio/openaiTts.test.ts
git commit -m "feat(tts): stream PCM chunks from OpenAI instead of buffering"
```

---

## Task 4: Rewrite NodeSpeakerOutput.playStream() — Linux/aplay path

**Files:**

- Modify: `src/audio/speakerOutput.ts`
- Test: `tests/audio/speakerOutput.test.ts` (create)

The `speaker` npm path on macOS is added in the next task — this task focuses on the Linux/`aplay` path, since that's the production target (Pi) and easier to mock (just `child_process.spawn`).

- [ ] **Step 1: Write the failing test for the aplay path**

Create `tests/audio/speakerOutput.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// We mock `child_process` and `node:os` so we exercise the aplay path
// regardless of the host OS we run tests on.
vi.mock('node:os', () => ({ platform: () => 'linux' }));

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

// Import after mocks so the module picks them up.
const { NodeSpeakerOutput } = await import('../../src/audio/speakerOutput.ts');

interface FakeStdin extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  destroyed: boolean;
}

interface FakeProc extends EventEmitter {
  stdin: FakeStdin;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeProc(): FakeProc {
  const stdin = new EventEmitter() as FakeStdin;
  stdin.destroyed = false;
  stdin.write = vi.fn(() => true);
  stdin.end = vi.fn();
  stdin.destroy = vi.fn(() => {
    stdin.destroyed = true;
  });
  const proc = new EventEmitter() as FakeProc;
  proc.stdin = stdin;
  proc.kill = vi.fn();
  return proc;
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
      for (const c of chunks) yield c;
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/audio/speakerOutput.test.ts`
Expected: FAIL — `speaker.playStream is not a function` (still has old `play`).

- [ ] **Step 3: Implement playStream — aplay path**

Replace contents of `src/audio/speakerOutput.ts`:

```ts
import { platform } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SpeakerOutput, TtsStream } from './types.ts';
import { isAbortError } from './streamHelpers.ts';

const IS_LINUX = platform() === 'linux';

interface SpeakerLike {
  on(event: string, cb: (arg?: unknown) => void): unknown;
  removeAllListeners(event: string): unknown;
  write(buf: Buffer, cb: (err?: Error) => void): boolean;
  end(): unknown;
  destroy(): unknown;
}

interface SpeakerCtor {
  new (opts: { channels: number; bitDepth: number; sampleRate: number }): SpeakerLike;
}

let speakerCtorCache: SpeakerCtor | null | undefined;

async function loadSpeakerCtor(): Promise<SpeakerCtor | null> {
  if (speakerCtorCache !== undefined) return speakerCtorCache;
  try {
    const mod = (await import('speaker')) as unknown as { default: SpeakerCtor };
    speakerCtorCache = mod.default;
  } catch {
    speakerCtorCache = null;
  }
  return speakerCtorCache;
}

export class NodeSpeakerOutput implements SpeakerOutput {
  private currentProc: ChildProcess | null = null;
  private currentSpeaker: SpeakerLike | null = null;

  async playStream(stream: TtsStream, opts?: { signal?: AbortSignal }): Promise<void> {
    this.stop();
    if (IS_LINUX) return this.playStreamViaAplay(stream, opts);
    return this.playStreamViaSpeakerNpm(stream, opts);
  }

  stop(): void {
    if (this.currentProc) {
      const p = this.currentProc;
      this.currentProc = null;
      try {
        p.stdin?.destroy();
        p.kill('SIGTERM');
      } catch {
        // best-effort
      }
    }
    if (this.currentSpeaker) {
      const s = this.currentSpeaker;
      this.currentSpeaker = null;
      try {
        s.removeAllListeners('error');
        s.on('error', () => {});
        s.end();
        s.destroy();
      } catch {
        // best-effort
      }
    }
  }

  private async playStreamViaAplay(
    stream: TtsStream,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const proc = spawn(
      'aplay',
      ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(stream.sampleRate), '-c', '1'],
      { stdio: ['pipe', 'ignore', 'inherit'] },
    );
    this.currentProc = proc;

    const onAbort = (): void => this.stop();
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdin?.on('error', () => {
      // EPIPE on stop() — ignore. The for-await loop will exit on the next
      // iteration via the `destroyed` check.
    });

    const exited = new Promise<void>((resolve, reject) => {
      proc.on('exit', () => resolve());
      proc.on('error', (err) => reject(err));
    });

    try {
      for await (const chunk of stream.chunks) {
        if (opts?.signal?.aborted) break;
        if (!proc.stdin || proc.stdin.destroyed) break;
        const ok = proc.stdin.write(chunk);
        if (!ok) {
          await new Promise<void>((resolve) => {
            proc.stdin!.once('drain', () => resolve());
          });
        }
      }
      proc.stdin?.end();
      await exited;
    } catch (err) {
      // AbortError from the upstream TTS iterator is normal cancellation.
      if (!isAbortError(err)) throw err;
    } finally {
      opts?.signal?.removeEventListener('abort', onAbort);
      if (this.currentProc === proc) this.currentProc = null;
    }
  }

  private async playStreamViaSpeakerNpm(
    _stream: TtsStream,
    _opts?: { signal?: AbortSignal },
  ): Promise<void> {
    // Implemented in Task 5.
    throw new Error('macOS speaker path not yet implemented');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/audio/speakerOutput.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/audio/speakerOutput.ts tests/audio/speakerOutput.test.ts
git commit -m "feat(speaker): streaming playback via aplay (Linux path)"
```

---

## Task 5: Add macOS streaming path (`speaker` npm)

**Files:**

- Modify: `src/audio/speakerOutput.ts`

No new test — `speaker` npm is heavy native code that doesn't lend itself to unit-mocking. Linux path has full coverage; macOS path is verified by the manual smoke test in Task 8.

- [ ] **Step 1: Implement playStreamViaSpeakerNpm**

In `src/audio/speakerOutput.ts`, replace the placeholder body with:

```ts
private async playStreamViaSpeakerNpm(
  stream: TtsStream,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  const Ctor = await loadSpeakerCtor();
  if (!Ctor) {
    throw new Error(
      "Audio playback unavailable: 'speaker' npm package failed to load and " +
        'this is not a Linux host (no `aplay` fallback). Install `sox` or ' +
        'rebuild speaker for your platform.',
    );
  }

  const speaker = new Ctor({
    channels: 1,
    bitDepth: 16,
    sampleRate: stream.sampleRate,
  });
  this.currentSpeaker = speaker;

  const onAbort = (): void => this.stop();
  opts?.signal?.addEventListener('abort', onAbort, { once: true });

  // Soak up async errors from the speaker so they don't crash the process
  // if stop() races with a write.
  let speakerError: Error | null = null;
  speaker.on('error', (err) => {
    speakerError = err instanceof Error ? err : new Error(String(err));
  });

  const closed = new Promise<void>((resolve) => {
    speaker.on('close', () => resolve());
  });

  try {
    for await (const chunk of stream.chunks) {
      if (opts?.signal?.aborted) break;
      if (this.currentSpeaker !== speaker) break; // stop() replaced us
      await new Promise<void>((resolve, reject) => {
        const ok = speaker.write(chunk, (err?: Error) => {
          if (err) reject(err);
          // If write() returned true the data was accepted synchronously and
          // we resolve right away in the `if (ok)` branch below.
        });
        if (ok) resolve();
        // If !ok we wait for the callback above to fire on drain.
      });
    }
    speaker.end();
    await closed;
    if (speakerError) throw speakerError;
  } catch (err) {
    if (!isAbortError(err)) throw err;
  } finally {
    opts?.signal?.removeEventListener('abort', onAbort);
    if (this.currentSpeaker === speaker) this.currentSpeaker = null;
  }
}
```

- [ ] **Step 2: Re-run all audio tests**

Run: `npx vitest run tests/audio/`
Expected: PASS — all tests still green (we only touched the macOS branch which the Linux-mocked tests don't exercise).

- [ ] **Step 3: Commit**

```bash
git add src/audio/speakerOutput.ts
git commit -m "feat(speaker): streaming playback via speaker npm (macOS path)"
```

---

## Task 6: Wire orchestrator with AbortController per speak

**Files:**

- Modify: `src/orchestrator/orchestrator.ts:1-12`, `:115-189` (runEffect / speak case)

- [ ] **Step 1: Update imports and add field**

In `src/orchestrator/orchestrator.ts`, change the imports block at lines 1-8 to include the helpers:

```ts
import type { Agent } from '../agent/types.ts';
import type { Stt, Tts, SpeakerOutput } from '../audio/types.ts';
import type { State, Event, Effect } from './types.ts';
import { transition } from './fsm.ts';
import { StreamingMic } from '../audio/streamingMic.ts';
import type { WakeWord } from '../audio/wakeWord.ts';
import { RmsVad } from '../audio/vad.ts';
import { generateConfirmBlip, generateListenBlip, isAckOnly } from '../audio/blip.ts';
import { bufferToStream, isAbortError } from '../audio/streamHelpers.ts';
```

Inside `class Orchestrator`, add a new private field next to the other state fields (around line 41):

```ts
private currentSpeechAbort: AbortController | null = null;
```

- [ ] **Step 2: Update the `startCapture` blip call**

At line 121, replace:

```ts
this.opts.speaker.play(LISTEN_BLIP, { sampleRate: BLIP_SAMPLE_RATE }).catch(() => {});
```

with:

```ts
this.opts.speaker.playStream(bufferToStream(LISTEN_BLIP, BLIP_SAMPLE_RATE)).catch(() => {});
```

- [ ] **Step 3: Update the `stopSpeaking` effect**

At lines 133-135, replace:

```ts
case 'stopSpeaking':
  this.opts.speaker.stop();
  return;
```

with:

```ts
case 'stopSpeaking':
  this.currentSpeechAbort?.abort();
  this.opts.speaker.stop();
  return;
```

- [ ] **Step 4: Rewrite the `speak` effect**

At lines 160-183, replace the entire `case 'speak':` block with:

```ts
case 'speak':
  this.currentSpeechAbort = new AbortController();
  try {
    if (isAckOnly(eff.text)) {
      console.log('Assistant: ✓ (action confirmed)');
      await this.opts.speaker.playStream(
        bufferToStream(CONFIRM_BLIP, BLIP_SAMPLE_RATE),
        { signal: this.currentSpeechAbort.signal },
      );
    } else {
      const stream = this.opts.tts.stream(eff.text, {
        signal: this.currentSpeechAbort.signal,
      });
      console.log(`Assistant: ${eff.text}`);
      await this.opts.speaker.playStream(stream, {
        signal: this.currentSpeechAbort.signal,
      });
    }
  } catch (e) {
    if (!isAbortError(e)) console.error('TTS error', e);
  } finally {
    this.currentSpeechAbort = null;
    if (eff.expectsFollowUp) {
      await this.dispatch({ type: 'followUpRequested' });
    } else {
      await this.dispatch({ type: 'speechFinished' });
    }
  }
  return;
```

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS — orchestrator now matches the new interfaces.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: PASS — all existing orchestrator/fsm tests still green (we kept the same effect names and event flow).

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/orchestrator.ts
git commit -m "feat(orchestrator): abort signal per speak; barge-in cancels TTS stream"
```

---

## Task 7: Migrate voice CLI to streaming

**Files:**

- Modify: `src/cli/voice.ts:69-70`

- [ ] **Step 1: Replace synthesize+play with stream+playStream**

In `src/cli/voice.ts`, change lines 69-70 from:

```ts
const { audio: ttsAudio, sampleRate } = await tts.synthesize(reply.text);
await speaker.play(ttsAudio, { sampleRate });
```

to:

```ts
const stream = tts.stream(reply.text);
await speaker.playStream(stream);
```

- [ ] **Step 2: Verify typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/cli/voice.ts
git commit -m "feat(cli): voice REPL uses streaming TTS"
```

---

## Task 8: Manual smoke test on macOS

This task is a real-world check that nothing in the streaming machinery is broken on the dev box. Run it before merging.

- [ ] **Step 1: Start the voice REPL**

Run: `npm run voice`
Expected: prompt "Press Enter to talk..." appears.

- [ ] **Step 2: Short-reply latency check**

Press Enter, say "привет", press Enter to stop. Watch the timestamps in the log between `User: …` and the moment audio starts. Expected: <500 ms on a healthy network. (Pre-streaming this was 2-3 s.)

- [ ] **Step 3: Long-reply timing check**

Ask the assistant something whose reply will be ~3 sentences (e.g. "расскажи в трёх предложениях про лампу"). Expected: audio begins playing while OpenAI is still streaming the rest — first sound at <500 ms, total wall-clock noticeably shorter than pre-streaming behaviour.

- [ ] **Step 4: Barge-in check (orchestrator daemon)**

Run: `npm start` (the wake-word daemon). Trigger a long reply (wake word + "расскажи длинную историю"). Mid-reply, say the wake word again. Expected: TTS cuts immediately, speaker silences, capture reopens. No "TTS error" in logs (the AbortError must be swallowed by `isAbortError`).

- [ ] **Step 5: Note any regressions**

If anything misbehaves (clicks/pops between chunks, hangs, leftover audio after barge-in, "TTS error" log on normal abort), capture the log and reopen the relevant Task before merging. Otherwise tick this step.

---

## Self-Review Checklist (run after writing the plan, before handoff)

- Spec coverage: every section of the spec maps to a task — interfaces (T1), helpers (T2), TTS impl (T3), Linux speaker (T4), macOS speaker (T5), orchestrator (T6), voice CLI (T7), smoke (T8). ✓
- No placeholders: every code step contains real code; abort/backpressure semantics are spelled out. ✓
- Type consistency: `TtsStream`, `playStream`, `bufferToStream`, `isAbortError`, `currentSpeechAbort` referenced identically across tasks. ✓
- Risk mitigations from the spec (SDK signal-passing, speaker npm fallback messaging) preserved. ✓
