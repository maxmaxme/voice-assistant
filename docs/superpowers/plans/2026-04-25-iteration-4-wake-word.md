# Iteration 4: Wake-Word + VAD (Always-Listening) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace push-to-talk with always-listening: a local wake-word detector triggers recording, voice-activity detection (VAD) ends the utterance automatically. The orchestrator becomes a state machine (`idle` / `listening` / `thinking` / `speaking`).

**Architecture:** Continuous PCM stream from `MicInput` is fanned out: every 80ms frame (1280 samples @ 16kHz) is forwarded to the wake-word daemon via stdin. On detection, subsequent chunks are accumulated and fed to a VAD that signals end-of-utterance after N ms of silence. The orchestrator FSM owns transitions and rejects mic input while speaking (no barge-in in this iteration).

**Tech Stack:** [openWakeWord](https://github.com/dscripka/openWakeWord) (Apache 2.0) running as a Python subprocess we communicate with over stdin/stdout, RMS-based VAD in Node, TypeScript, Vitest. Picovoice Porcupine was the original choice but Picovoice no longer issues free personal AccessKeys, so we switched to openWakeWord.

**Prerequisite:** Iteration 3 complete (push-to-talk voice works end-to-end).

---

## File Structure

```
src/
├── audio/
│   ├── wakeWord.ts              # openWakeWord adapter (spawns Python daemon)
│   ├── vad.ts                   # VAD adapter (RMS-based to start)
│   └── streamingMic.ts          # continuous PCM stream + chunk fanout
├── orchestrator/
│   ├── types.ts                 # State, events, transitions
│   ├── fsm.ts                   # pure state machine
│   └── orchestrator.ts          # wires audio + agent + tts
└── cli/
    └── run.ts                   # daemon entry
tests/
├── audio/
│   └── vad.test.ts
└── orchestrator/
    └── fsm.test.ts
```

---

## Task 1: Continuous mic stream

**Files:**
- Create: `src/audio/streamingMic.ts`

The push-to-talk `NodeMicInput` from Iteration 3 collects chunks into a buffer. For wake-word we need a long-running stream of chunks while the process is alive.

- [x] **Step 1: Implement `src/audio/streamingMic.ts`**

```ts
import mic from 'mic';

export interface StreamingMicOptions {
  sampleRate: number;
  /** PCM chunk size in 16-bit samples. openWakeWord expects 1280 at 16kHz (80ms). */
  frameLength: number;
}

export class StreamingMic {
  private m: ReturnType<typeof mic> | null = null;
  private listeners = new Set<(frame: Int16Array) => void>();
  private leftover = Buffer.alloc(0);

  constructor(private readonly opts: StreamingMicOptions) {}

  start(): void {
    if (this.m) return;
    const m = mic({
      rate: String(this.opts.sampleRate),
      channels: '1',
      bitwidth: '16',
      encoding: 'signed-integer',
      endian: 'little',
    });
    const stream = m.getAudioStream();
    stream.on('data', (chunk: Buffer) => this.onChunk(chunk));
    m.start();
    this.m = m;
  }

  stop(): void {
    this.m?.stop();
    this.m = null;
    this.leftover = Buffer.alloc(0);
  }

  onFrame(cb: (frame: Int16Array) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private onChunk(chunk: Buffer): void {
    const buf = Buffer.concat([this.leftover, chunk]);
    const frameBytes = this.opts.frameLength * 2;
    let offset = 0;
    while (buf.length - offset >= frameBytes) {
      // IMPORTANT: do NOT use `new Int16Array(buf.buffer, buf.byteOffset + offset, ...)`.
      // Node Buffers are slices of a shared 8KB pool; byteOffset is not guaranteed
      // to be 2-byte aligned, which throws RangeError. Copy into a fresh Int16Array.
      const frame = new Int16Array(this.opts.frameLength);
      for (let i = 0; i < this.opts.frameLength; i++) {
        frame[i] = buf.readInt16LE(offset + i * 2);
      }
      for (const l of this.listeners) l(frame);
      offset += frameBytes;
    }
    this.leftover = buf.subarray(offset);
  }
}
```

- [x] **Step 2: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [x] **Step 3: Commit**

```bash
git add src/audio/streamingMic.ts
git commit -m "feat(audio): add continuous streaming mic with frame fanout"
```

---

## Task 2: RMS-based VAD

A simple amplitude-based VAD is enough for v1: crosses the threshold = speech, stays below for N ms = silence/end.

**Files:**
- Create: `src/audio/vad.ts`
- Test: `tests/audio/vad.test.ts`

- [x] **Step 1: Write failing tests**

`tests/audio/vad.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RmsVad } from '../../src/audio/vad.js';

function frame(value: number, n = 512): Int16Array {
  const a = new Int16Array(n);
  a.fill(value);
  return a;
}

describe('RmsVad', () => {
  it('detects speech then silence', () => {
    const vad = new RmsVad({
      sampleRate: 16000,
      frameLength: 512,
      threshold: 1000,
      silenceMs: 500,
    });
    const events: string[] = [];
    vad.onSpeech(() => events.push('speech'));
    vad.onSilence(() => events.push('silence'));

    // Loud frames trigger speech once
    for (let i = 0; i < 5; i++) vad.feed(frame(5000));
    expect(events).toContain('speech');

    // Then silent frames; need 500ms = ~16 frames at 32ms/frame.
    for (let i = 0; i < 20; i++) vad.feed(frame(0));
    expect(events).toContain('silence');
  });

  it('does not emit silence without prior speech', () => {
    const vad = new RmsVad({ sampleRate: 16000, frameLength: 512, threshold: 1000, silenceMs: 200 });
    const events: string[] = [];
    vad.onSilence(() => events.push('silence'));
    for (let i = 0; i < 50; i++) vad.feed(frame(0));
    expect(events).toHaveLength(0);
  });
});
```

- [x] **Step 2: Verify failure**

```bash
npx vitest run tests/audio/vad.test.ts
```

Expected: FAIL.

- [x] **Step 3: Implement `src/audio/vad.ts`**

```ts
export interface RmsVadOptions {
  sampleRate: number;
  frameLength: number;
  threshold: number;
  silenceMs: number;
}

export class RmsVad {
  private inSpeech = false;
  private silentFrames = 0;
  private readonly silenceFramesNeeded: number;
  private speechCb: () => void = () => {};
  private silenceCb: () => void = () => {};

  constructor(private readonly opts: RmsVadOptions) {
    const frameMs = (opts.frameLength / opts.sampleRate) * 1000;
    this.silenceFramesNeeded = Math.ceil(opts.silenceMs / frameMs);
  }

  onSpeech(cb: () => void): void { this.speechCb = cb; }
  onSilence(cb: () => void): void { this.silenceCb = cb; }

  feed(frame: Int16Array): void {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);

    if (rms >= this.opts.threshold) {
      if (!this.inSpeech) {
        this.inSpeech = true;
        this.silentFrames = 0;
        this.speechCb();
      } else {
        this.silentFrames = 0;
      }
    } else if (this.inSpeech) {
      this.silentFrames++;
      if (this.silentFrames >= this.silenceFramesNeeded) {
        this.inSpeech = false;
        this.silentFrames = 0;
        this.silenceCb();
      }
    }
  }

  reset(): void {
    this.inSpeech = false;
    this.silentFrames = 0;
  }
}
```

- [x] **Step 4: Run tests**

```bash
npx vitest run tests/audio/vad.test.ts
```

Expected: 2 passed.

- [x] **Step 5: Commit**

```bash
git add src/audio/vad.ts tests/audio/vad.test.ts
git commit -m "feat(audio): add RMS-based VAD"
```

---

## Task 3: Wake-word adapter (openWakeWord via Python subprocess)

**Why subprocess instead of pure Node:** openWakeWord's pipeline is three chained
ONNX models (mel-spectrogram → embedding → per-keyword classifier) plus a
sliding window over embeddings. The Python `openwakeword` package handles all
of it, including model download and caching. Reimplementing the pipeline in
Node with `onnxruntime-node` is doable but takes ~10x the effort. We keep the
adapter boundary clean (`WakeWord` interface) so a future pure-Node implementation
can drop in without touching the orchestrator.

**Files:**
- Create: `scripts/wake_word_daemon.py` — long-running Python process
- Create: `src/audio/wakeWord.ts` — Node adapter that spawns and talks to the daemon
- Create: `tests/audio/wakeWord.test.ts` — uses a fake daemon binary
- Modify: `src/config.ts`, `.env.example`

- [x] **Step 1: Set up Python environment**

```bash
# macOS dev: uses the system python3 + a per-project venv to avoid global pollution
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install openwakeword
```

The first time `openwakeword` runs it will download its three small models
(~10 MB total) into `~/.cache/openwakeword/`. That's expected.

- [x] **Step 2: Add `.venv/` to `.gitignore`**

```bash
grep -qxF '.venv/' .gitignore || echo '.venv/' >> .gitignore
```

- [x] **Step 3: Create `scripts/wake_word_daemon.py`**

The protocol: stdin = raw 16-bit little-endian mono PCM at 16 kHz, fed in
1280-sample frames (80 ms). stdout = newline-delimited JSON events:
`{"type":"ready"}` once at startup, then `{"type":"wake","keyword":"...","score":0.83}`
on each detection. stderr = human-readable diagnostics.

```python
#!/usr/bin/env python3
"""Wake-word daemon. Reads raw 16-bit mono 16kHz PCM from stdin in 1280-sample
(80ms) frames and emits JSON wake events on stdout. Designed to be spawned by
the Node parent."""
import json
import struct
import sys
import argparse
import numpy as np
from openwakeword.model import Model

FRAME_SAMPLES = 1280
FRAME_BYTES = FRAME_SAMPLES * 2

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def log(msg):
    sys.stderr.write(f"[wake] {msg}\n")
    sys.stderr.flush()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keyword", default="hey_jarvis", help="openwakeword model name")
    ap.add_argument("--threshold", type=float, default=0.5)
    args = ap.parse_args()

    log(f"loading model: {args.keyword}")
    model = Model(wakeword_models=[args.keyword])
    emit({"type": "ready", "keyword": args.keyword, "threshold": args.threshold})

    cooldown_frames = 0
    while True:
        data = sys.stdin.buffer.read(FRAME_BYTES)
        if len(data) < FRAME_BYTES:
            break
        audio = np.frombuffer(data, dtype=np.int16)
        scores = model.predict(audio)
        if cooldown_frames > 0:
            cooldown_frames -= 1
            continue
        for kw, score in scores.items():
            if score >= args.threshold:
                emit({"type": "wake", "keyword": kw, "score": float(score)})
                # ~1 s cooldown to avoid double-fires from the same utterance
                cooldown_frames = 12
                break

if __name__ == "__main__":
    main()
```

Make it executable:

```bash
chmod +x scripts/wake_word_daemon.py
```

- [x] **Step 4: Smoke-run the daemon to confirm Python deps**

Verify the script can import its deps and announce readiness without crashing.
Pipe one frame of silence and EOF:

```bash
python3 -c "import sys; sys.stdout.buffer.write(b'\\0' * 2560)" \
  | .venv/bin/python scripts/wake_word_daemon.py --keyword hey_jarvis 2>/dev/null \
  | head -1
```

Expected: `{"type": "ready", "keyword": "hey_jarvis", "threshold": 0.5}`.

If it fails: `pip install openwakeword` again, or check Python version (need 3.10+).

- [x] **Step 5: Define the `WakeWord` interface and adapter**

`src/audio/wakeWord.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

export interface WakeWord {
  /** Frame length in samples that should be fed via feed(). */
  readonly frameLength: number;
  /** Audio sample rate the wake-word expects (Hz). */
  readonly sampleRate: number;
  start(): Promise<void>;
  feed(frame: Int16Array): void;
  onWake(cb: (keyword: string, score: number) => void): void;
  stop(): Promise<void>;
}

export interface OpenWakeWordOptions {
  /** Python interpreter path — usually `.venv/bin/python` */
  pythonPath: string;
  /** Path to scripts/wake_word_daemon.py */
  scriptPath: string;
  /** openwakeword model name, e.g. "hey_jarvis" */
  keyword: string;
  /** Detection threshold 0..1 (default 0.5) */
  threshold?: number;
  /** Inject a custom spawn for tests */
  spawnFn?: typeof spawn;
}

const FRAME_LENGTH = 1280;
const SAMPLE_RATE = 16_000;

export class OpenWakeWord implements WakeWord {
  readonly frameLength = FRAME_LENGTH;
  readonly sampleRate = SAMPLE_RATE;
  private proc: ChildProcess | null = null;
  private cb: (keyword: string, score: number) => void = () => {};
  private ready = false;
  private readyResolve: (() => void) | null = null;

  constructor(private readonly opts: OpenWakeWordOptions) {}

  async start(): Promise<void> {
    const args = [
      this.opts.scriptPath,
      '--keyword',
      this.opts.keyword,
      '--threshold',
      String(this.opts.threshold ?? 0.5),
    ];
    const spawnFn = this.opts.spawnFn ?? spawn;
    this.proc = spawnFn(this.opts.pythonPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!this.proc.stdout) throw new Error('wake-word daemon has no stdout');
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      let evt: { type?: string; keyword?: string; score?: number };
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      if (evt.type === 'ready') {
        this.ready = true;
        this.readyResolve?.();
      } else if (evt.type === 'wake' && evt.keyword) {
        this.cb(evt.keyword, evt.score ?? 0);
      }
    });

    this.proc.on('exit', (code) => {
      if (!this.ready) {
        // Surface startup failures as a rejected ready promise.
        this.readyResolve?.();
      }
      this.proc = null;
    });

    await new Promise<void>((resolve) => {
      if (this.ready) resolve();
      else this.readyResolve = resolve;
    });
    if (!this.ready) {
      throw new Error('wake-word daemon failed to start (see stderr)');
    }
  }

  feed(frame: Int16Array): void {
    if (!this.proc || !this.proc.stdin || frame.length !== FRAME_LENGTH) return;
    const buf = Buffer.alloc(FRAME_LENGTH * 2);
    for (let i = 0; i < FRAME_LENGTH; i++) buf.writeInt16LE(frame[i], i * 2);
    this.proc.stdin.write(buf);
  }

  onWake(cb: (keyword: string, score: number) => void): void {
    this.cb = cb;
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.stdin?.end();
    this.proc.kill('SIGTERM');
    this.proc = null;
  }
}
```

- [x] **Step 6: Write a unit test using a fake spawn**

`tests/audio/wakeWord.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { OpenWakeWord } from '../../src/audio/wakeWord.js';

function fakeProc(scriptedStdout: string[]) {
  const stdout = new Readable({ read() {} });
  const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  const proc = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    kill: (sig?: string) => void;
  };
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = new Readable({ read() {} });
  proc.kill = () => {};
  // Push scripted lines on next tick so callers have time to attach listeners.
  setImmediate(() => {
    for (const line of scriptedStdout) stdout.push(line + '\n');
  });
  return proc;
}

describe('OpenWakeWord', () => {
  it('resolves start() once the daemon prints ready', async () => {
    const spawnFn = vi.fn(() =>
      fakeProc([JSON.stringify({ type: 'ready', keyword: 'hey_jarvis', threshold: 0.5 })]),
    );
    const ww = new OpenWakeWord({
      pythonPath: '/x/python',
      scriptPath: '/x/script.py',
      keyword: 'hey_jarvis',
      spawnFn: spawnFn as never,
    });
    await ww.start();
    expect(spawnFn).toHaveBeenCalledOnce();
  });

  it('fires onWake when the daemon reports a detection', async () => {
    const spawnFn = vi.fn(() =>
      fakeProc([
        JSON.stringify({ type: 'ready', keyword: 'hey_jarvis', threshold: 0.5 }),
        JSON.stringify({ type: 'wake', keyword: 'hey_jarvis', score: 0.91 }),
      ]),
    );
    const ww = new OpenWakeWord({
      pythonPath: '/x/python',
      scriptPath: '/x/script.py',
      keyword: 'hey_jarvis',
      spawnFn: spawnFn as never,
    });
    const events: Array<[string, number]> = [];
    ww.onWake((k, s) => events.push([k, s]));
    await ww.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([['hey_jarvis', 0.91]]);
  });
});
```

- [x] **Step 7: Run the test (must fail first, then implement, then pass)**

```bash
npx vitest run tests/audio/wakeWord.test.ts
```

If you implement Step 5 before this step, the test should pass on first run.
That's acceptable here — the contract is the protocol, not the implementation
sequence.

- [x] **Step 8: Add config entries**

In `src/config.ts` schema:

```ts
wakeWord: z.object({
  pythonPath: z.string().default('.venv/bin/python'),
  scriptPath: z.string().default('scripts/wake_word_daemon.py'),
  keyword: z.string().default('hey_jarvis'),
  threshold: z.coerce.number().min(0).max(1).default(0.5),
}),
```

In `raw`:

```ts
wakeWord: {
  pythonPath: process.env.WAKE_WORD_PYTHON,
  scriptPath: process.env.WAKE_WORD_SCRIPT,
  keyword: process.env.WAKE_WORD_KEYWORD,
  threshold: process.env.WAKE_WORD_THRESHOLD,
},
```

Append to `.env.example`:

```
# Wake-word (openWakeWord via Python subprocess)
WAKE_WORD_PYTHON=.venv/bin/python
WAKE_WORD_SCRIPT=scripts/wake_word_daemon.py
WAKE_WORD_KEYWORD=hey_jarvis
WAKE_WORD_THRESHOLD=0.5
```

Available builtin keywords from openwakeword: `hey_jarvis`, `alexa`,
`hey_mycroft`, `hey_rhasspy`, `ok_nabu`, `weatherman`, `timer`. Pick a
phonetically distinctive one — `hey_jarvis` is the strongest default.

- [x] **Step 9: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [x] **Step 10: Commit**

```bash
git add scripts/wake_word_daemon.py src/audio/wakeWord.ts tests/audio/wakeWord.test.ts \
        src/config.ts .env.example .gitignore
git commit -m "feat(audio): add openWakeWord adapter via Python subprocess"
```

---

## Task 4: Orchestrator FSM (pure)

**Files:**
- Create: `src/orchestrator/types.ts`
- Create: `src/orchestrator/fsm.ts`
- Test: `tests/orchestrator/fsm.test.ts`

The FSM is pure: takes events, returns the new state and a list of side-effects to execute. Side-effects are described as data, not callbacks — that makes it trivially testable.

- [x] **Step 1: Create types**

`src/orchestrator/types.ts`:

```ts
export type State = 'idle' | 'listening' | 'thinking' | 'speaking';

export type Event =
  | { type: 'wake' }
  | { type: 'utteranceEnd'; audio: Buffer }
  | { type: 'agentReplied'; text: string }
  | { type: 'speechFinished' }
  | { type: 'error'; message: string };

export type Effect =
  | { type: 'startCapture' }
  | { type: 'transcribeAndAsk'; audio: Buffer }
  | { type: 'speak'; text: string }
  | { type: 'log'; level: 'info' | 'error'; message: string };

export interface Transition {
  state: State;
  effects: Effect[];
}
```

- [x] **Step 2: Write failing tests**

`tests/orchestrator/fsm.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { transition } from '../../src/orchestrator/fsm.js';

describe('FSM', () => {
  it('idle + wake → listening with startCapture', () => {
    const r = transition('idle', { type: 'wake' });
    expect(r.state).toBe('listening');
    expect(r.effects).toEqual([{ type: 'startCapture' }]);
  });

  it('listening + utteranceEnd → thinking with transcribeAndAsk', () => {
    const audio = Buffer.from([1, 2, 3]);
    const r = transition('listening', { type: 'utteranceEnd', audio });
    expect(r.state).toBe('thinking');
    expect(r.effects).toEqual([{ type: 'transcribeAndAsk', audio }]);
  });

  it('thinking + agentReplied → speaking with speak', () => {
    const r = transition('thinking', { type: 'agentReplied', text: 'ok' });
    expect(r.state).toBe('speaking');
    expect(r.effects).toEqual([{ type: 'speak', text: 'ok' }]);
  });

  it('speaking + speechFinished → idle', () => {
    const r = transition('speaking', { type: 'speechFinished' });
    expect(r.state).toBe('idle');
    expect(r.effects).toEqual([]);
  });

  it('wake while not idle is ignored (no barge-in)', () => {
    for (const s of ['listening', 'thinking', 'speaking'] as const) {
      const r = transition(s, { type: 'wake' });
      expect(r.state).toBe(s);
      expect(r.effects).toEqual([]);
    }
  });

  it('error always returns to idle and logs', () => {
    const r = transition('thinking', { type: 'error', message: 'boom' });
    expect(r.state).toBe('idle');
    expect(r.effects[0]).toEqual({ type: 'log', level: 'error', message: 'boom' });
  });
});
```

- [x] **Step 3: Verify failure**

```bash
npx vitest run tests/orchestrator/fsm.test.ts
```

Expected: FAIL.

- [x] **Step 4: Implement `src/orchestrator/fsm.ts`**

```ts
import type { State, Event, Transition } from './types.js';

export function transition(state: State, event: Event): Transition {
  if (event.type === 'error') {
    return { state: 'idle', effects: [{ type: 'log', level: 'error', message: event.message }] };
  }
  switch (state) {
    case 'idle':
      if (event.type === 'wake') {
        return { state: 'listening', effects: [{ type: 'startCapture' }] };
      }
      return { state, effects: [] };
    case 'listening':
      if (event.type === 'utteranceEnd') {
        return { state: 'thinking', effects: [{ type: 'transcribeAndAsk', audio: event.audio }] };
      }
      return { state, effects: [] };
    case 'thinking':
      if (event.type === 'agentReplied') {
        return { state: 'speaking', effects: [{ type: 'speak', text: event.text }] };
      }
      return { state, effects: [] };
    case 'speaking':
      if (event.type === 'speechFinished') {
        return { state: 'idle', effects: [] };
      }
      return { state, effects: [] };
  }
}
```

- [x] **Step 5: Run tests**

```bash
npx vitest run tests/orchestrator/fsm.test.ts
```

Expected: 6 passed.

- [x] **Step 6: Commit**

```bash
git add src/orchestrator/types.ts src/orchestrator/fsm.ts tests/orchestrator/fsm.test.ts
git commit -m "feat(orchestrator): add pure FSM with explicit effects"
```

---

## Task 5: Orchestrator runtime + CLI daemon

**Files:**
- Create: `src/orchestrator/orchestrator.ts`
- Create: `src/cli/run.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement `src/orchestrator/orchestrator.ts`**

```ts
import type { Agent } from '../agent/types.js';
import type { Stt, Tts, SpeakerOutput } from '../audio/types.js';
import type { State, Event, Effect } from './types.js';
import { transition } from './fsm.js';
import { StreamingMic } from '../audio/streamingMic.js';
import type { WakeWord } from '../audio/wakeWord.js';
import { RmsVad } from '../audio/vad.js';

export interface OrchestratorOptions {
  agent: Agent;
  stt: Stt;
  tts: Tts;
  speaker: SpeakerOutput;
  wake: WakeWord;
  sampleRate: number;
}

export class Orchestrator {
  private state: State = 'idle';
  private mic: StreamingMic;
  private vad: RmsVad;
  private captureBuffer: Buffer[] = [];
  private capturing = false;

  constructor(private readonly opts: OrchestratorOptions) {
    this.mic = new StreamingMic({
      sampleRate: opts.sampleRate,
      frameLength: opts.wake.frameLength,
    });
    this.vad = new RmsVad({
      sampleRate: opts.sampleRate,
      frameLength: opts.wake.frameLength,
      threshold: 800,
      silenceMs: 800,
    });
  }

  async run(): Promise<void> {
    await this.opts.wake.start();
    this.opts.wake.onWake(() => this.dispatch({ type: 'wake' }));
    this.vad.onSilence(() => {
      if (!this.capturing) return;
      this.capturing = false;
      const audio = Buffer.concat(this.captureBuffer);
      this.captureBuffer = [];
      this.dispatch({ type: 'utteranceEnd', audio });
    });

    this.mic.onFrame((frame) => {
      this.opts.wake.feed(frame);
      if (this.capturing) {
        this.captureBuffer.push(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
        this.vad.feed(frame);
      }
    });

    this.mic.start();
    console.log('Voice assistant running. Say the wake word to talk.');
    await new Promise(() => {}); // run forever
  }

  private async dispatch(event: Event): Promise<void> {
    const { state, effects } = transition(this.state, event);
    this.state = state;
    for (const eff of effects) await this.runEffect(eff);
  }

  private async runEffect(eff: Effect): Promise<void> {
    switch (eff.type) {
      case 'startCapture':
        this.capturing = true;
        this.captureBuffer = [];
        this.vad.reset();
        return;
      case 'transcribeAndAsk':
        try {
          const text = (
            await this.opts.stt.transcribe(eff.audio, {
              sampleRate: this.opts.sampleRate,
              language: 'ru',
            })
          ).trim();
          if (!text) {
            await this.dispatch({ type: 'speechFinished' });
            return;
          }
          console.log(`User: ${text}`);
          const reply = await this.opts.agent.respond(text);
          await this.dispatch({ type: 'agentReplied', text: reply.text });
        } catch (e) {
          await this.dispatch({ type: 'error', message: e instanceof Error ? e.message : String(e) });
        }
        return;
      case 'speak':
        try {
          const { audio, sampleRate } = await this.opts.tts.synthesize(eff.text);
          console.log(`Assistant: ${eff.text}`);
          await this.opts.speaker.play(audio, { sampleRate });
        } catch (e) {
          console.error('TTS error', e);
        } finally {
          await this.dispatch({ type: 'speechFinished' });
        }
        return;
      case 'log':
        if (eff.level === 'error') console.error(eff.message);
        else console.log(eff.message);
        return;
    }
  }
}
```

- [ ] **Step 2: Implement `src/cli/run.ts`**

```ts
import OpenAI from 'openai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../config.js';
import { HaMcpClient } from '../mcp/haMcpClient.js';
import { OpenAiAgent } from '../agent/openaiAgent.js';
import { ConversationStore } from '../agent/conversationStore.js';
import { SqliteProfileMemory } from '../memory/sqliteProfileMemory.js';
import { NodeSpeakerOutput } from '../audio/speakerOutput.js';
import { OpenAiStt } from '../audio/openaiStt.js';
import { OpenAiTts } from '../audio/openaiTts.js';
import { OpenWakeWord } from '../audio/wakeWord.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { BASE_SYSTEM_PROMPT } from '../agent/systemPrompt.js';

const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

Voice channel specifics: keep replies under 1 sentence when possible. Avoid
markdown, lists, code, or punctuation that doesn't read well out loud.`;

async function main(): Promise<void> {
  const cfg = loadConfig();
  fs.mkdirSync(path.dirname(cfg.memory.dbPath), { recursive: true });

  const llm = new OpenAI({ apiKey: cfg.openai.apiKey });
  const mcp = new HaMcpClient({ url: cfg.ha.url, token: cfg.ha.token });
  const memory = new SqliteProfileMemory({ dbPath: cfg.memory.dbPath });
  await mcp.connect();

  const agent = new OpenAiAgent({
    mcp,
    memory,
    store: new ConversationStore({ idleTimeoutMs: 3 * 60 * 1000, maxMessages: 20 }),
    systemPrompt: SYSTEM_PROMPT,
    model: cfg.openai.model,
    llmClient: llm,
  });

  const wake = new OpenWakeWord({
    pythonPath: cfg.wakeWord.pythonPath,
    scriptPath: cfg.wakeWord.scriptPath,
    keyword: cfg.wakeWord.keyword,
    threshold: cfg.wakeWord.threshold,
  });

  const orch = new Orchestrator({
    agent,
    stt: new OpenAiStt({ client: llm }),
    tts: new OpenAiTts({ client: llm }),
    speaker: new NodeSpeakerOutput(),
    wake,
    sampleRate: wake.sampleRate,
  });

  process.on('SIGINT', async () => {
    await wake.stop();
    await mcp.disconnect();
    memory.close();
    process.exit(0);
  });

  await orch.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Add npm script**

In `package.json` `scripts`:

```json
"start": "tsx src/cli/run.ts",
```

- [ ] **Step 4: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 5: Manual end-to-end test on macOS**

Prereq: `PORCUPINE_ACCESS_KEY` set (free at console.picovoice.ai). HA running. Choose a built-in keyword like `jarvis` to start (no need for custom .ppn).

```bash
npm start
```

Test:
1. Say "Jarvis" → console prints wake event, starts capture.
2. Say "включи лампу", pause ~1s. VAD ends utterance, transcribes, agent calls tool, lamp turns on, assistant speaks confirmation.
3. While the assistant is speaking, say "Jarvis" — should be ignored (no barge-in).
4. After it finishes, say "Jarvis" → "выключи".

If wake-word never fires: lower `WAKE_WORD_THRESHOLD` from 0.5 to 0.3. Check that the daemon's stderr shows it loaded the model. Check the mic level — openWakeWord needs reasonably clean 16kHz audio. Try a different keyword (e.g. `alexa`) to rule out the model itself.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/orchestrator.ts src/cli/run.ts package.json
git commit -m "feat(orchestrator): always-listening voice loop with wake-word and VAD"
```

---

## Definition of done

- All unit tests pass.
- `npm start` runs as a daemon: wake-word activates listening, VAD ends utterance, full pipeline executes, returns to idle.
- Barge-in is correctly ignored (wake-word during `speaking` does nothing).
- `Ctrl+C` shuts down cleanly (kills the wake-word daemon, closes DB, disconnects MCP).
- Idle CPU on macOS is reasonable (openWakeWord daemon alone is ~3-7% on M-series; higher than Porcupine but acceptable).
