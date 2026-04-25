# Iteration 3: Voice on macOS (Push-to-Talk) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voice input/output on macOS. Press Enter to start recording, press Enter again to stop; audio goes to `gpt-4o-transcribe` for STT, the resulting text goes to the existing `Agent`, the response text goes to `gpt-4o-mini-tts`, and the synthesized audio plays out the speakers. No wake-word yet.

**Architecture:** Four new adapters behind interfaces — `MicInput`, `Stt`, `Tts`, `SpeakerOutput`. CLI `voice` orchestrates the loop. STT and TTS use the OpenAI SDK (already installed). Mic capture via `mic` (npm), playback via `speaker` (npm) — both work on macOS via CoreAudio and on Linux/Pi via ALSA without code changes.

**Tech Stack:** `mic`, `speaker`, OpenAI SDK, TypeScript, Vitest.

**Prerequisite:** Iteration 2 complete (`OpenAiAgent` works in text REPL). Memory Level 1 optional but recommended.

---

## File Structure

```
src/
├── audio/
│   ├── types.ts              # MicInput, SpeakerOutput, Stt, Tts
│   ├── micInput.ts           # `mic` wrapper, push-to-talk record
│   ├── speakerOutput.ts      # `speaker` wrapper
│   ├── openaiStt.ts          # gpt-4o-transcribe adapter
│   └── openaiTts.ts          # gpt-4o-mini-tts adapter
└── cli/
    └── voice.ts              # push-to-talk loop entry
tests/
└── audio/
    ├── openaiStt.test.ts     # mocked OpenAI client
    └── openaiTts.test.ts     # mocked OpenAI client
```

---

## Task 1: Install audio deps + types

**Files:**
- Modify: `package.json`
- Create: `src/audio/types.ts`

- [ ] **Step 1: Install**

```bash
npm install mic speaker
npm install --save-dev @types/mic
```

If `@types/speaker` is missing, declare it locally — see Task 4 step 3.

- [ ] **Step 2: Create `src/audio/types.ts`**

```ts
export interface MicInput {
  /** Records 16-bit mono PCM at the given sample rate until stop() is called. */
  record(opts: { sampleRate: number }): Promise<{ stop(): Promise<Buffer> }>;
}

export interface SpeakerOutput {
  /** Plays 16-bit mono PCM at the given sample rate. Resolves when playback ends. */
  play(buf: Buffer, opts: { sampleRate: number }): Promise<void>;
}

export interface Stt {
  transcribe(audio: Buffer, opts: { sampleRate: number; language?: string }): Promise<string>;
}

export interface Tts {
  synthesize(text: string, opts?: { voice?: string; instructions?: string }): Promise<{
    audio: Buffer;
    sampleRate: number;
  }>;
}
```

- [ ] **Step 3: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/audio/types.ts
git commit -m "chore(audio): install mic/speaker, add audio interfaces"
```

---

## Task 2: OpenAI STT adapter

**Files:**
- Create: `src/audio/openaiStt.ts`
- Test: `tests/audio/openaiStt.test.ts`

- [ ] **Step 1: Write failing test**

`tests/audio/openaiStt.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { OpenAiStt } from '../../src/audio/openaiStt.js';

describe('OpenAiStt', () => {
  it('sends a WAV file to the audio.transcriptions endpoint and returns text', async () => {
    const create = vi.fn().mockResolvedValue({ text: 'привет дом' });
    const fakeClient = {
      audio: { transcriptions: { create } },
    } as never;
    const stt = new OpenAiStt({ client: fakeClient, model: 'gpt-4o-transcribe' });
    const pcm = Buffer.alloc(16000 * 2); // 1 second of silence
    const result = await stt.transcribe(pcm, { sampleRate: 16000, language: 'ru' });
    expect(result).toBe('привет дом');
    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0][0];
    expect(call.model).toBe('gpt-4o-transcribe');
    expect(call.language).toBe('ru');
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
npx vitest run tests/audio/openaiStt.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `src/audio/openaiStt.ts`**

```ts
import type OpenAI from 'openai';
import { toFile } from 'openai';
import type { Stt } from './types.js';

export interface OpenAiSttOptions {
  client: OpenAI;
  model?: string;
}

export class OpenAiStt implements Stt {
  private readonly model: string;
  constructor(private readonly opts: OpenAiSttOptions) {
    this.model = opts.model ?? 'gpt-4o-transcribe';
  }

  async transcribe(audio: Buffer, opts: { sampleRate: number; language?: string }): Promise<string> {
    const wav = pcmToWav(audio, opts.sampleRate);
    const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
    const res = await this.opts.client.audio.transcriptions.create({
      file,
      model: this.model,
      language: opts.language,
    });
    return res.text;
  }
}

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/audio/openaiStt.test.ts
```

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/audio/openaiStt.ts tests/audio/openaiStt.test.ts
git commit -m "feat(audio): add OpenAI STT adapter (gpt-4o-transcribe)"
```

---

## Task 3: OpenAI TTS adapter

**Files:**
- Create: `src/audio/openaiTts.ts`
- Test: `tests/audio/openaiTts.test.ts`

- [ ] **Step 1: Write failing test**

`tests/audio/openaiTts.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { OpenAiTts } from '../../src/audio/openaiTts.js';

describe('OpenAiTts', () => {
  it('returns 16-bit PCM audio at 24kHz', async () => {
    const fakePcm = Buffer.alloc(2400 * 2);
    const create = vi.fn().mockResolvedValue({
      arrayBuffer: async () => fakePcm.buffer.slice(fakePcm.byteOffset, fakePcm.byteOffset + fakePcm.byteLength),
    });
    const fakeClient = { audio: { speech: { create } } } as never;
    const tts = new OpenAiTts({ client: fakeClient, model: 'gpt-4o-mini-tts', voice: 'alloy' });
    const out = await tts.synthesize('привет');
    expect(out.audio.length).toBe(fakePcm.length);
    expect(out.sampleRate).toBe(24000);
    const call = create.mock.calls[0][0];
    expect(call.response_format).toBe('pcm');
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
npx vitest run tests/audio/openaiTts.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `src/audio/openaiTts.ts`**

```ts
import type OpenAI from 'openai';
import type { Tts } from './types.js';

export interface OpenAiTtsOptions {
  client: OpenAI;
  model?: string;
  voice?: string;
}

const SAMPLE_RATE = 24000;

export class OpenAiTts implements Tts {
  private readonly model: string;
  private readonly voice: string;

  constructor(private readonly opts: OpenAiTtsOptions) {
    this.model = opts.model ?? 'gpt-4o-mini-tts';
    this.voice = opts.voice ?? 'alloy';
  }

  async synthesize(text: string, opts?: { voice?: string; instructions?: string }) {
    const res = await this.opts.client.audio.speech.create({
      model: this.model,
      voice: opts?.voice ?? this.voice,
      input: text,
      response_format: 'pcm',
      instructions: opts?.instructions,
    } as never);
    const ab = await (res as unknown as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer();
    return { audio: Buffer.from(ab), sampleRate: SAMPLE_RATE };
  }
}
```

Note: `gpt-4o-mini-tts` outputs 24kHz 16-bit mono PCM with `response_format: 'pcm'`. The `instructions` field lets you steer tone ("speak warmly, slightly excited").

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/audio/openaiTts.test.ts
```

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/audio/openaiTts.ts tests/audio/openaiTts.test.ts
git commit -m "feat(audio): add OpenAI TTS adapter (gpt-4o-mini-tts)"
```

---

## Task 4: Mic input + speaker output (no automated tests)

These are thin wrappers around hardware libraries. Verifying them needs an actual microphone and speaker, so they're tested manually in Task 5.

**Files:**
- Create: `src/audio/micInput.ts`
- Create: `src/audio/speakerOutput.ts`
- Create: `src/types/speaker.d.ts` (if no @types/speaker)

- [ ] **Step 1: Implement `src/audio/micInput.ts`**

```ts
import mic from 'mic';
import type { MicInput } from './types.js';

export class NodeMicInput implements MicInput {
  async record(opts: { sampleRate: number }): Promise<{ stop(): Promise<Buffer> }> {
    const m = mic({
      rate: String(opts.sampleRate),
      channels: '1',
      bitwidth: '16',
      encoding: 'signed-integer',
      endian: 'little',
    });
    const stream = m.getAudioStream();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    m.start();
    return {
      stop: () =>
        new Promise<Buffer>((resolve) => {
          stream.once('silence', () => {});
          stream.once('end', () => resolve(Buffer.concat(chunks)));
          m.stop();
          // Some platforms don't emit 'end' reliably; resolve on next tick if data exists.
          setTimeout(() => resolve(Buffer.concat(chunks)), 250);
        }),
    };
  }
}
```

- [ ] **Step 2: Implement `src/audio/speakerOutput.ts`**

```ts
import Speaker from 'speaker';
import type { SpeakerOutput } from './types.js';

export class NodeSpeakerOutput implements SpeakerOutput {
  async play(buf: Buffer, opts: { sampleRate: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      const speaker = new Speaker({
        channels: 1,
        bitDepth: 16,
        sampleRate: opts.sampleRate,
      });
      speaker.on('close', () => resolve());
      speaker.on('error', (err: Error) => reject(err));
      speaker.write(buf, (err) => {
        if (err) return reject(err);
        speaker.end();
      });
    });
  }
}
```

- [ ] **Step 3: If `@types/speaker` is missing, add ambient declaration**

`src/types/speaker.d.ts`:

```ts
declare module 'speaker' {
  import { Writable } from 'node:stream';
  interface SpeakerOptions {
    channels: number;
    bitDepth: number;
    sampleRate: number;
  }
  class Speaker extends Writable {
    constructor(opts: SpeakerOptions);
  }
  export default Speaker;
}
```

Add to `tsconfig.json`'s `include`: `"src/**/*"` already covers it.

- [ ] **Step 4: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/audio/micInput.ts src/audio/speakerOutput.ts src/types
git commit -m "feat(audio): add mic input and speaker output wrappers"
```

---

## Task 5: Push-to-talk CLI

**Files:**
- Create: `src/cli/voice.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement `src/cli/voice.ts`**

```ts
import OpenAI from 'openai';
import * as readline from 'node:readline/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../config.js';
import { HaMcpClient } from '../mcp/haMcpClient.js';
import { OpenAiAgent } from '../agent/openaiAgent.js';
import { ConversationStore } from '../agent/conversationStore.js';
import { SqliteProfileMemory } from '../memory/sqliteProfileMemory.js';
import { NodeMicInput } from '../audio/micInput.js';
import { NodeSpeakerOutput } from '../audio/speakerOutput.js';
import { OpenAiStt } from '../audio/openaiStt.js';
import { OpenAiTts } from '../audio/openaiTts.js';

const SYSTEM_PROMPT = `You are a smart-home voice assistant.
You control devices through Home Assistant tools.
Long-term user profile is available via remember/recall/forget.
Be concise (1-2 sentences). Speak Russian if the user does.`;

const MIC_SAMPLE_RATE = 16000;

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

  const mic = new NodeMicInput();
  const speaker = new NodeSpeakerOutput();
  const stt = new OpenAiStt({ client: llm });
  const tts = new OpenAiTts({ client: llm });

  const rl = readline.createInterface({ input, output });
  console.log('Voice push-to-talk. Press Enter to start recording, Enter again to stop. Ctrl+C to quit.');

  try {
    while (true) {
      await rl.question('Press Enter to talk... ');
      const session = await mic.record({ sampleRate: MIC_SAMPLE_RATE });
      console.log('Listening. Press Enter when done.');
      await rl.question('');
      const audio = await session.stop();
      console.log(`Captured ${audio.length} bytes; transcribing...`);

      const text = (await stt.transcribe(audio, { sampleRate: MIC_SAMPLE_RATE, language: 'ru' })).trim();
      if (!text) {
        console.log('(no speech detected)');
        continue;
      }
      console.log(`User: ${text}`);

      const reply = await agent.respond(text);
      console.log(`Assistant: ${reply.text}`);

      const { audio: ttsAudio, sampleRate } = await tts.synthesize(reply.text);
      await speaker.play(ttsAudio, { sampleRate });
    }
  } finally {
    rl.close();
    await mcp.disconnect();
    memory.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script**

In `package.json` `scripts`:

```json
"voice": "tsx src/cli/voice.ts",
```

- [ ] **Step 3: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Manual end-to-end test on macOS**

Prerequisites:
- HA running with Test Lamp exposed (`docker compose up -d`).
- `.env` populated.
- macOS will prompt for microphone permission on first run — allow it.

```bash
npm run voice
```

Test path:
1. Press Enter → say «включи лампу» → press Enter.
2. Expected: console shows transcript, Test Lamp turns on in HA UI, you hear the assistant confirm.
3. Press Enter → say «а теперь выключи» → Enter. Lamp turns off.
4. Press Enter → say «меня зовут Максим, запомни» → Enter. Profile updated (verify `data/assistant.db` or restart and ask «как меня зовут?»).

If mic doesn't capture: check `sox` is installed (`brew install sox`) — `mic` shells out to `sox`/`rec`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/voice.ts package.json
git commit -m "feat(cli): add push-to-talk voice loop"
```

---

## Definition of done

- All unit tests pass.
- `npm run voice` on macOS lets you control HA via voice end-to-end.
- Latency is acceptable subjectively (target: < 4s round-trip from "stop recording" to "assistant speaks").
- Russian commands are transcribed correctly with `language: 'ru'`.
