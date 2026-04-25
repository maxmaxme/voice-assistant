# Iteration 4: Wake-Word + VAD (Always-Listening) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace push-to-talk with always-listening: a local wake-word detector triggers recording, voice-activity detection (VAD) ends the utterance automatically. The orchestrator becomes a state machine (`idle` / `listening` / `thinking` / `speaking`).

**Architecture:** Continuous PCM stream from `MicInput` is fanned out: every chunk goes through Porcupine (wake-word). On detection, subsequent chunks are accumulated and fed to a VAD that signals end-of-utterance after N ms of silence. The orchestrator FSM owns transitions and rejects mic input while speaking (no barge-in in this iteration).

**Tech Stack:** `@picovoice/porcupine-node`, `@picovoice/pvrecorder-node` (or reuse `mic` with chunk fanout), Silero VAD via `silero-vad-node` or simple RMS-based VAD as a fallback, TypeScript, Vitest.

**Prerequisite:** Iteration 3 complete (push-to-talk voice works end-to-end).

---

## File Structure

```
src/
├── audio/
│   ├── wakeWord.ts              # Porcupine adapter
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

- [ ] **Step 1: Implement `src/audio/streamingMic.ts`**

```ts
import mic from 'mic';

export interface StreamingMicOptions {
  sampleRate: number;
  /** PCM chunk size in 16-bit samples. Porcupine expects 512 at 16kHz. */
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

- [ ] **Step 2: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

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

- [ ] **Step 1: Write failing tests**

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

- [ ] **Step 2: Verify failure**

```bash
npx vitest run tests/audio/vad.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `src/audio/vad.ts`**

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

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/audio/vad.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/audio/vad.ts tests/audio/vad.test.ts
git commit -m "feat(audio): add RMS-based VAD"
```

---

## Task 3: Wake-word adapter (Porcupine)

**Files:**
- Modify: `package.json`
- Create: `src/audio/wakeWord.ts`

- [ ] **Step 1: Install**

```bash
npm install @picovoice/porcupine-node
```

- [ ] **Step 2: Implement `src/audio/wakeWord.ts`**

```ts
import { Porcupine, BuiltinKeyword } from '@picovoice/porcupine-node';

export interface WakeWordOptions {
  accessKey: string;
  /** Path to a .ppn keyword file, or a built-in keyword. */
  keyword: string | BuiltinKeyword;
  sensitivity?: number;
}

export class PorcupineWakeWord {
  private porcupine: Porcupine;
  private cb: () => void = () => {};

  constructor(opts: WakeWordOptions) {
    const keywordPaths = typeof opts.keyword === 'string' ? [opts.keyword] : undefined;
    const builtin = typeof opts.keyword !== 'string' ? [opts.keyword] : undefined;
    this.porcupine = new Porcupine(
      opts.accessKey,
      (keywordPaths ?? builtin) as never,
      [opts.sensitivity ?? 0.5],
    );
  }

  /** Required input frame length (samples at 16kHz, 16-bit mono). */
  get frameLength(): number {
    return this.porcupine.frameLength;
  }

  get sampleRate(): number {
    return this.porcupine.sampleRate;
  }

  onWake(cb: () => void): void { this.cb = cb; }

  feed(frame: Int16Array): void {
    if (frame.length !== this.porcupine.frameLength) return;
    const idx = this.porcupine.process(frame);
    if (idx >= 0) this.cb();
  }

  release(): void {
    this.porcupine.release();
  }
}
```

- [ ] **Step 3: Add config for Porcupine**

In `src/config.ts` schema:

```ts
porcupine: z.object({
  accessKey: z.string().min(1),
  keyword: z.string().default('jarvis'),
  sensitivity: z.coerce.number().min(0).max(1).default(0.5),
}),
```

In `raw`:

```ts
porcupine: {
  accessKey: process.env.PORCUPINE_ACCESS_KEY,
  keyword: process.env.PORCUPINE_KEYWORD,
  sensitivity: process.env.PORCUPINE_SENSITIVITY,
},
```

Append to `.env.example`:

```
# Porcupine wake-word
PORCUPINE_ACCESS_KEY=replace_with_picovoice_key
PORCUPINE_KEYWORD=jarvis
PORCUPINE_SENSITIVITY=0.5
```

- [ ] **Step 4: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/audio/wakeWord.ts src/config.ts .env.example
git commit -m "feat(audio): add Porcupine wake-word adapter"
```

---

## Task 4: Orchestrator FSM (pure)

**Files:**
- Create: `src/orchestrator/types.ts`
- Create: `src/orchestrator/fsm.ts`
- Test: `tests/orchestrator/fsm.test.ts`

The FSM is pure: takes events, returns the new state and a list of side-effects to execute. Side-effects are described as data, not callbacks — that makes it trivially testable.

- [ ] **Step 1: Create types**

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

- [ ] **Step 2: Write failing tests**

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

- [ ] **Step 3: Verify failure**

```bash
npx vitest run tests/orchestrator/fsm.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement `src/orchestrator/fsm.ts`**

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

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/orchestrator/fsm.test.ts
```

Expected: 6 passed.

- [ ] **Step 6: Commit**

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
import { PorcupineWakeWord } from '../audio/wakeWord.js';
import { RmsVad } from '../audio/vad.js';

export interface OrchestratorOptions {
  agent: Agent;
  stt: Stt;
  tts: Tts;
  speaker: SpeakerOutput;
  wake: PorcupineWakeWord;
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
import { BuiltinKeyword } from '@picovoice/porcupine-node';
import { loadConfig } from '../config.js';
import { HaMcpClient } from '../mcp/haMcpClient.js';
import { OpenAiAgent } from '../agent/openaiAgent.js';
import { ConversationStore } from '../agent/conversationStore.js';
import { SqliteProfileMemory } from '../memory/sqliteProfileMemory.js';
import { NodeSpeakerOutput } from '../audio/speakerOutput.js';
import { OpenAiStt } from '../audio/openaiStt.js';
import { OpenAiTts } from '../audio/openaiTts.js';
import { PorcupineWakeWord } from '../audio/wakeWord.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';

const SYSTEM_PROMPT = `You are a smart-home voice assistant.
Control devices via Home Assistant tools. Long-term profile via remember/recall/forget.
Be concise (1-2 sentences). Speak Russian if the user does.`;

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

  // Resolve keyword: if it matches a Porcupine built-in name, use the enum value;
  // otherwise treat it as a filesystem path to a custom .ppn keyword file.
  // Built-ins are uppercase enum keys like JARVIS, COMPUTER, ALEXA, BLUEBERRY, etc.
  // Custom names with hyphens (e.g. "okay-home") MUST be a path to a .ppn file
  // produced via Picovoice Console (https://console.picovoice.ai/).
  const enumKey = cfg.porcupine.keyword.toUpperCase().replace(/-/g, '_');
  const builtinValue = (BuiltinKeyword as unknown as Record<string, unknown>)[enumKey] as
    | BuiltinKeyword
    | undefined;
  const keyword: string | BuiltinKeyword = builtinValue ?? cfg.porcupine.keyword;
  if (!builtinValue && !cfg.porcupine.keyword.endsWith('.ppn')) {
    throw new Error(
      `PORCUPINE_KEYWORD="${cfg.porcupine.keyword}" is neither a built-in keyword name ` +
        `nor a path to a .ppn file. See https://console.picovoice.ai/ to generate custom keywords.`,
    );
  }

  const wake = new PorcupineWakeWord({
    accessKey: cfg.porcupine.accessKey,
    keyword,
    sensitivity: cfg.porcupine.sensitivity,
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
    await mcp.disconnect();
    memory.close();
    wake.release();
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

If wake-word never fires: try `sensitivity = 0.7`. Check the mic level — Porcupine needs reasonably clean 16kHz audio.

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
- `Ctrl+C` shuts down cleanly (releases Porcupine, closes DB, disconnects MCP).
- Idle CPU on macOS is reasonable (Porcupine alone is ~1-3% on M-series).
