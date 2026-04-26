# Unify CLI Entry Points — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four entry-point scripts (`chat.ts`, `voice.ts`, `run.ts`, plus the existing `mcp-call.ts` which stays untouched) with a single `unified.ts` dispatched by the `AGENT_MODE` env var. `npm run start` defaults to `AGENT_MODE=both` and runs the wake-word listener concurrently with future channels (Telegram bot in Plan 2). Pure refactor — no behaviour changes.

**Architecture:** Three pieces:

1. `src/cli/shared.ts` — `initializeCommonDependencies()` returns the OpenAI client, MCP client, memory adapter, telegram sender, and a factory for building an `OpenAiAgent` with a per-mode system prompt. Owns the lifecycle (connect on startup, dispose on shutdown).
2. `src/cli/runners/{chat,voice,wake}.ts` — one runner per mode. Each exports an async function that takes the deps from `shared.ts` and runs forever (or until SIGINT). They mirror the current `chat.ts` / `voice.ts` / `run.ts` bodies, just split.
3. `src/cli/unified.ts` — reads `AGENT_MODE`, awaits `initializeCommonDependencies()`, dispatches to the right runner(s). For `both`, it `Promise.race`s on a SIGINT abort signal so a crash in one runner tears the whole process down (so systemd restarts it cleanly).

**Tech Stack:** Node 24 native TS stripping (no build step), TypeScript, Vitest.

**Prerequisite:** None. This is the first plan in the personal-agent migration.

---

## File Structure

```
src/cli/
├── shared.ts                # Shared init + per-mode system prompts
├── unified.ts               # NEW: main entry, dispatches by AGENT_MODE
├── runners/
│   ├── chat.ts              # NEW: text REPL runner
│   ├── voice.ts             # NEW: push-to-talk runner
│   └── wake.ts              # NEW: wake-word always-listening runner
├── chat.ts                  # KEEP as 3-line shim → runners/chat.ts
├── voice.ts                 # KEEP as 3-line shim → runners/voice.ts
├── run.ts                   # KEEP as 3-line shim → runners/wake.ts
└── mcp-call.ts              # UNCHANGED

tests/cli/
├── shared.test.ts           # unit tests for buildSystemPrompt + AGENT_MODE parsing
└── unified.test.ts          # smoke test for the dispatch
```

The old per-channel scripts stay as one-liner shims so existing `npm run chat` / `npm run voice` / `npm run start` keep working without telling humans new commands. The shims just `import './runners/<mode>.ts'`.

---

## Out-of-scope (do NOT do here)

- ❌ No Telegram polling — Plan 2 owns inbound Telegram.
- ❌ No new memory tables — Plan 3 owns reminders/timers.
- ❌ No new CLI flags or arg parsing libraries — env var is enough.
- ❌ No changes to `OpenAiAgent`, `Orchestrator`, `MemoryAdapter` interfaces.
- ❌ No removal of `mcp-call.ts`.

---

## Task 1: Create `runners/` directory + chat runner extraction

**Files:**

- Create: `src/cli/runners/chat.ts`
- Create: `tests/cli/runners/chat.smoke.test.ts`

The chat runner is the simplest: just a readline loop. We extract it first to set the pattern.

- [ ] **Step 1: Write the failing import test**

Create `tests/cli/runners/chat.smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('runners/chat', () => {
  it('exports runChatMode as a function', async () => {
    const mod = await import('../../../src/cli/runners/chat.ts');
    expect(typeof mod.runChatMode).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/runners/chat.smoke.test.ts`
Expected: FAIL with "Cannot find module" or similar.

- [ ] **Step 3: Create `src/cli/runners/chat.ts`**

```typescript
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { Session } from '../../agent/session.ts';
import type { MemoryAdapter } from '../../memory/types.ts';

export interface ChatRunnerDeps {
  agent: OpenAiAgent;
  session: Session;
  memory: MemoryAdapter;
}

export async function runChatMode(deps: ChatRunnerDeps): Promise<void> {
  const { agent, session, memory } = deps;
  const rl = readline.createInterface({ input, output });
  console.log('Chat ready. /reset to clear context. /profile to dump profile. Ctrl+C to exit.');

  let closed = false;
  rl.on('close', () => {
    closed = true;
  });

  try {
    while (!closed) {
      let line: string;
      try {
        line = (await rl.question('> ')).trim();
      } catch {
        break;
      }
      if (!line) continue;
      if (line === '/reset') {
        session.reset();
        console.log('(context cleared)');
        continue;
      }
      if (line === '/profile') {
        console.log(JSON.stringify(memory.recall(), null, 2));
        continue;
      }
      try {
        const res = await agent.respond(line);
        console.log(res.text);
      } catch (err) {
        console.error('Agent error:', err instanceof Error ? err.message : err);
      }
    }
  } finally {
    rl.close();
  }
}
```

Note: this runner does NOT own dependency lifecycle (mcp.connect/disconnect, memory.close). That's `shared.ts`'s job — see Task 4. Runners just consume already-built deps.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/runners/chat.smoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/runners/chat.ts tests/cli/runners/chat.smoke.test.ts
git commit -m "refactor(cli): extract chat runner from chat.ts"
```

---

## Task 2: Voice runner extraction

**Files:**

- Create: `src/cli/runners/voice.ts`
- Create: `tests/cli/runners/voice.smoke.test.ts`

- [ ] **Step 1: Write the failing import test**

Create `tests/cli/runners/voice.smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('runners/voice', () => {
  it('exports runVoiceMode as a function', async () => {
    const mod = await import('../../../src/cli/runners/voice.ts');
    expect(typeof mod.runVoiceMode).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/runners/voice.smoke.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/cli/runners/voice.ts`**

```typescript
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import { NodeMicInput } from '../../audio/micInput.ts';
import { NodeSpeakerOutput } from '../../audio/speakerOutput.ts';
import type { Stt, Tts } from '../../audio/types.ts';

const MIC_SAMPLE_RATE = 16000;

export interface VoiceRunnerDeps {
  agent: OpenAiAgent;
  stt: Stt;
  tts: Tts;
}

export async function runVoiceMode(deps: VoiceRunnerDeps): Promise<void> {
  const { agent, stt, tts } = deps;
  const mic = new NodeMicInput();
  const speaker = new NodeSpeakerOutput();
  const rl = readline.createInterface({ input, output });
  console.log(
    'Voice push-to-talk. Press Enter to start recording, Enter again to stop. Ctrl+C to quit.',
  );

  try {
    while (true) {
      await rl.question('Press Enter to talk... ');
      const recording = await mic.record({ sampleRate: MIC_SAMPLE_RATE });
      console.log('Listening. Press Enter when done.');
      await rl.question('');
      const audio = await recording.stop();
      console.log(`Captured ${audio.length} bytes; transcribing...`);

      const text = (
        await stt.transcribe(audio, { sampleRate: MIC_SAMPLE_RATE, language: 'ru' })
      ).trim();
      if (!text) {
        console.log('(no speech detected)');
        continue;
      }
      console.log(`User: ${text}`);

      const reply = await agent.respond(text);
      console.log(`Assistant: ${reply.text}`);

      const stream = tts.stream(reply.text);
      await speaker.playStream(stream);
    }
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/runners/voice.smoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/runners/voice.ts tests/cli/runners/voice.smoke.test.ts
git commit -m "refactor(cli): extract voice push-to-talk runner from voice.ts"
```

---

## Task 3: Wake-word runner extraction

**Files:**

- Create: `src/cli/runners/wake.ts`
- Create: `tests/cli/runners/wake.smoke.test.ts`

- [ ] **Step 1: Write the failing import test**

Create `tests/cli/runners/wake.smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('runners/wake', () => {
  it('exports runWakeMode as a function', async () => {
    const mod = await import('../../../src/cli/runners/wake.ts');
    expect(typeof mod.runWakeMode).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/runners/wake.smoke.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/cli/runners/wake.ts`**

```typescript
import type OpenAI from 'openai';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { Config } from '../../config.ts';
import { NodeSpeakerOutput } from '../../audio/speakerOutput.ts';
import { OpenAiStt } from '../../audio/openaiStt.ts';
import { OpenAiTts } from '../../audio/openaiTts.ts';
import { OpenWakeWord } from '../../audio/wakeWord.ts';
import { Orchestrator } from '../../orchestrator/orchestrator.ts';

export interface WakeRunnerDeps {
  agent: OpenAiAgent;
  llm: OpenAI;
  config: Config;
}

export async function runWakeMode(deps: WakeRunnerDeps): Promise<void> {
  const { agent, llm, config } = deps;

  const wake = new OpenWakeWord({
    pythonPath: config.wakeWord.pythonPath,
    scriptPath: config.wakeWord.scriptPath,
    keyword: config.wakeWord.keyword,
    threshold: config.wakeWord.threshold,
    debug: config.wakeWord.debug,
  });

  const orch = new Orchestrator({
    agent,
    stt: new OpenAiStt({ client: llm }),
    tts: new OpenAiTts({ client: llm }),
    speaker: new NodeSpeakerOutput(),
    wake,
    sampleRate: wake.sampleRate,
    followUp: config.wakeWord.followUp,
  });

  // SIGINT handling moved to unified.ts so it can dispose all runners' resources.
  await orch.run(); // never resolves
}
```

Note: `Orchestrator.run()` returns a promise that never resolves (`await new Promise(() => {})` at the bottom). That's fine — `unified.ts` will own SIGINT.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/runners/wake.smoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/runners/wake.ts tests/cli/runners/wake.smoke.test.ts
git commit -m "refactor(cli): extract wake-word runner from run.ts"
```

---

## Task 4: Shared initialization in `src/cli/shared.ts`

**Files:**

- Create: `src/cli/shared.ts`
- Create: `tests/cli/shared.test.ts`

This holds the per-mode system prompt builders and the dependency factory.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/shared.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildSystemPromptFor, parseAgentMode, AGENT_MODES } from '../../src/cli/shared.ts';

describe('parseAgentMode', () => {
  it('defaults to "both" when env is empty', () => {
    expect(parseAgentMode(undefined)).toBe('both');
    expect(parseAgentMode('')).toBe('both');
  });

  it('accepts valid modes', () => {
    for (const m of AGENT_MODES) {
      expect(parseAgentMode(m)).toBe(m);
    }
  });

  it('throws on unknown mode with helpful message', () => {
    expect(() => parseAgentMode('garbage')).toThrow(/AGENT_MODE.*garbage.*expected one of/);
  });
});

describe('buildSystemPromptFor', () => {
  it('chat returns BASE_SYSTEM_PROMPT unchanged', () => {
    const p = buildSystemPromptFor('chat');
    expect(p).not.toContain('Voice channel');
    expect(p).not.toContain('silent-confirmation');
  });

  it('voice adds the short-replies addendum', () => {
    const p = buildSystemPromptFor('voice');
    expect(p).toContain('Voice channel');
    expect(p).toContain('under 1 sentence');
  });

  it('wake adds the silent-confirmation rule', () => {
    const p = buildSystemPromptFor('wake');
    expect(p).toContain('silent-confirmation');
    expect(p).toContain('"✓"');
  });

  it('telegram is identical to chat (no TTS, free-form text)', () => {
    expect(buildSystemPromptFor('telegram')).toBe(buildSystemPromptFor('chat'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli/shared.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Create `src/cli/shared.ts`**

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import OpenAI from 'openai';
import { loadConfig, type Config } from '../config.ts';
import { HaMcpClient } from '../mcp/haMcpClient.ts';
import { OpenAiAgent } from '../agent/openaiAgent.ts';
import { Session } from '../agent/session.ts';
import { SqliteProfileMemory } from '../memory/sqliteProfileMemory.ts';
import { BASE_SYSTEM_PROMPT } from '../agent/systemPrompt.ts';
import { telegramFromConfig } from '../telegram/fromConfig.ts';
import type { TelegramSender } from '../telegram/types.ts';

export const AGENT_MODES = ['chat', 'voice', 'wake', 'telegram', 'both'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** "Channel" = a system-prompt flavour. Multiple modes can share a channel. */
export type PromptChannel = 'chat' | 'voice' | 'wake' | 'telegram';

const VOICE_ADDENDUM = `

Voice channel specifics: keep replies under 1 sentence when possible. Avoid
markdown, lists, code, or punctuation that doesn't read well out loud.`;

const SILENT_CONFIRM_ADDENDUM = `

CRITICAL silent-confirmation rule: when you successfully completed a simple
device action (turning lights/switches/scenes on or off, setting a value)
and have no new information to share, reply with EXACTLY the single
character "✓" and nothing else. Examples:
  user: "включи лампу" → tool call HassTurnOn → reply: "✓"
  user: "выключи свет в кухне" → tool call → reply: "✓"
  user: "включи лампу" → tool returned an error → reply: "Не получилось,
        лампа не отвечает." (real text, NOT ✓)
  user: "какая температура?" → reply: "22 градуса." (real text, NOT ✓)
  user: "что я ел вчера?" → reply: "Я не помню." (real text, NOT ✓)
The user hears a short chime when you reply "✓" — they understand the
action is done. Don't add words like "готово" or "сделано" — just "✓".`;

export function buildSystemPromptFor(channel: PromptChannel): string {
  switch (channel) {
    case 'chat':
    case 'telegram':
      return BASE_SYSTEM_PROMPT;
    case 'voice':
      return `${BASE_SYSTEM_PROMPT}${VOICE_ADDENDUM}`;
    case 'wake':
      return `${BASE_SYSTEM_PROMPT}${VOICE_ADDENDUM}${SILENT_CONFIRM_ADDENDUM}`;
  }
}

export function parseAgentMode(raw: string | undefined): AgentMode {
  if (!raw) return 'both';
  if ((AGENT_MODES as readonly string[]).includes(raw)) return raw as AgentMode;
  throw new Error(`AGENT_MODE=${raw}: expected one of ${AGENT_MODES.join(', ')}`);
}

export interface CommonDeps {
  config: Config;
  llm: OpenAI;
  mcp: HaMcpClient;
  memory: SqliteProfileMemory;
  telegram: TelegramSender;
  /** Build a fresh agent for a given channel. Each channel gets its own
   * Session so they don't trample each other's `previous_response_id` chain. */
  buildAgent(channel: PromptChannel): OpenAiAgent;
  dispose(): Promise<void>;
}

/** Initialise everything shared across runners. Call once per process. */
export async function initializeCommonDependencies(): Promise<CommonDeps> {
  const config = loadConfig();
  fs.mkdirSync(path.dirname(config.memory.dbPath), { recursive: true });

  const llm = new OpenAI({ apiKey: config.openai.apiKey });
  const mcp = new HaMcpClient({ url: config.ha.url, token: config.ha.token });
  const memory = new SqliteProfileMemory({ dbPath: config.memory.dbPath });
  const telegram = telegramFromConfig(config);

  await mcp.connect();

  const buildAgent = (channel: PromptChannel): OpenAiAgent =>
    new OpenAiAgent({
      mcp,
      memory,
      session: new Session(),
      systemPrompt: buildSystemPromptFor(channel),
      model: config.openai.model,
      llmClient: llm,
      telegram,
    });

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await mcp.disconnect();
    memory.close();
  };

  return { config, llm, mcp, memory, telegram, buildAgent, dispose };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cli/shared.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/shared.ts tests/cli/shared.test.ts
git commit -m "feat(cli): add shared init + per-channel system prompts"
```

---

## Task 5: Unified entry point `src/cli/unified.ts`

**Files:**

- Create: `src/cli/unified.ts`
- Create: `tests/cli/unified.test.ts`

`unified.ts` is the dispatcher. It owns SIGINT and the lifecycle of `CommonDeps`. For `both` mode it runs `wake` + (eventually) Telegram concurrently — but for this plan, `both` = wake only (Telegram comes in Plan 2).

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/unified.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { dispatch } from '../../src/cli/unified.ts';
import type { CommonDeps, AgentMode } from '../../src/cli/shared.ts';

function makeDeps(): CommonDeps {
  return {
    config: {} as any,
    llm: {} as any,
    mcp: {} as any,
    memory: {} as any,
    telegram: {} as any,
    buildAgent: vi.fn(() => ({}) as any),
    dispose: vi.fn(async () => {}),
  };
}

describe('dispatch', () => {
  it('chat mode invokes runChatMode once', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
    };
    await dispatch('chat' as AgentMode, deps, runners);
    expect(runners.chat).toHaveBeenCalledTimes(1);
    expect(runners.voice).not.toHaveBeenCalled();
    expect(runners.wake).not.toHaveBeenCalled();
  });

  it('voice mode invokes runVoiceMode only', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
    };
    await dispatch('voice' as AgentMode, deps, runners);
    expect(runners.voice).toHaveBeenCalledTimes(1);
  });

  it('wake mode invokes runWakeMode only', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
    };
    await dispatch('wake' as AgentMode, deps, runners);
    expect(runners.wake).toHaveBeenCalledTimes(1);
  });

  it('both mode invokes wake (telegram added in Plan 2)', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
    };
    await dispatch('both' as AgentMode, deps, runners);
    expect(runners.wake).toHaveBeenCalledTimes(1);
  });

  it('telegram mode is a no-op stub until Plan 2 (does not throw)', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
    };
    await expect(dispatch('telegram' as AgentMode, deps, runners)).resolves.toBeUndefined();
  });

  it('builds a separate agent per active channel', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
    };
    await dispatch('wake' as AgentMode, deps, runners);
    expect(deps.buildAgent).toHaveBeenCalledWith('wake');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli/unified.test.ts`
Expected: FAIL — "Cannot find module".

- [ ] **Step 3: Create `src/cli/unified.ts`**

```typescript
import type OpenAI from 'openai';
import {
  initializeCommonDependencies,
  parseAgentMode,
  type AgentMode,
  type CommonDeps,
} from './shared.ts';
import { runChatMode } from './runners/chat.ts';
import { runVoiceMode } from './runners/voice.ts';
import { runWakeMode } from './runners/wake.ts';
import { OpenAiStt } from '../audio/openaiStt.ts';
import { OpenAiTts } from '../audio/openaiTts.ts';

export interface RunnerSet {
  chat: (deps: {
    agent: ReturnType<CommonDeps['buildAgent']>;
    session: any;
    memory: any;
  }) => Promise<void>;
  voice: (deps: {
    agent: ReturnType<CommonDeps['buildAgent']>;
    stt: any;
    tts: any;
  }) => Promise<void>;
  wake: (deps: {
    agent: ReturnType<CommonDeps['buildAgent']>;
    llm: OpenAI;
    config: any;
  }) => Promise<void>;
}

/** Dispatch logic, exported for tests. Does NOT call initializeCommonDependencies
 * — the caller passes deps so tests can use mocks. */
export async function dispatch(
  mode: AgentMode,
  deps: CommonDeps,
  runners: RunnerSet,
): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (mode === 'chat') {
    const agent = deps.buildAgent('chat');
    tasks.push(
      runners.chat({
        agent,
        session: (agent as unknown as { opts: { session: unknown } }).opts.session,
        memory: deps.memory,
      }),
    );
  }

  if (mode === 'voice') {
    const agent = deps.buildAgent('voice');
    tasks.push(
      runners.voice({
        agent,
        stt: new OpenAiStt({ client: deps.llm }),
        tts: new OpenAiTts({ client: deps.llm }),
      }),
    );
  }

  if (mode === 'wake' || mode === 'both') {
    const agent = deps.buildAgent('wake');
    tasks.push(runners.wake({ agent, llm: deps.llm, config: deps.config }));
  }

  // mode === 'telegram': stub for Plan 2. No-op so the harness doesn't crash if
  // someone sets AGENT_MODE=telegram before Plan 2 lands.
  if (mode === 'telegram') {
    console.log('[unified] AGENT_MODE=telegram — runner not yet implemented (Plan 2).');
    return;
  }

  if (tasks.length === 0) {
    throw new Error(`No runners scheduled for AGENT_MODE=${mode}`);
  }

  // Promise.race: if any runner crashes/exits, tear down the whole process.
  await Promise.race(tasks);
}

async function main(): Promise<void> {
  const mode = parseAgentMode(process.env.AGENT_MODE);
  console.log(`[unified] AGENT_MODE=${mode}`);

  const deps = await initializeCommonDependencies();

  const onShutdown = async (signal: string): Promise<void> => {
    console.log(`[unified] received ${signal}, shutting down`);
    await deps.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void onShutdown('SIGINT'));
  process.on('SIGTERM', () => void onShutdown('SIGTERM'));

  try {
    await dispatch(mode, deps, {
      chat: runChatMode,
      voice: runVoiceMode,
      wake: runWakeMode,
    });
  } finally {
    await deps.dispose();
  }
}

// Only run main() when this file is the entry point. The test imports
// `dispatch` directly without triggering main().
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cli/unified.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/unified.ts tests/cli/unified.test.ts
git commit -m "feat(cli): add unified entry point dispatched by AGENT_MODE"
```

---

## Task 6: Replace old entry-point scripts with thin shims

We keep `chat.ts`, `voice.ts`, `run.ts` so existing `npm run chat/voice/start` keep working — they just delegate to the new runners (which are responsible for full deps).

**Files:**

- Modify: `src/cli/chat.ts` (replace whole body)
- Modify: `src/cli/voice.ts` (replace whole body)
- Modify: `src/cli/run.ts` (replace whole body)

- [ ] **Step 1: Replace `src/cli/chat.ts`**

```typescript
// Thin shim — the implementation lives in src/cli/unified.ts. Kept so
// `npm run chat` and any external invocations keep working.
process.env.AGENT_MODE = 'chat';
await import('./unified.ts');
```

- [ ] **Step 2: Replace `src/cli/voice.ts`**

```typescript
process.env.AGENT_MODE = 'voice';
await import('./unified.ts');
```

- [ ] **Step 3: Replace `src/cli/run.ts`**

```typescript
process.env.AGENT_MODE = 'wake';
await import('./unified.ts');
```

Note: `await import()` at the top level works because the project is `"type": "module"`. Setting `AGENT_MODE` _before_ the import ensures `parseAgentMode` sees it.

- [ ] **Step 4: Verify type-check passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Run the full unit-test suite**

Run: `npm test`
Expected: all green. The existing tests for `OpenAiAgent`, `Orchestrator`, memory, etc. should be unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/cli/chat.ts src/cli/voice.ts src/cli/run.ts
git commit -m "refactor(cli): turn chat/voice/run into shims over unified.ts"
```

---

## Task 7: Update `package.json`

**Files:**

- Modify: `package.json:6-20` (the `scripts` block)

- [ ] **Step 1: Update scripts**

Open `package.json` and replace the `scripts` section so `start` points at the unified entry and a new `start:wake` / `start:telegram` exist for explicit overrides:

```json
"scripts": {
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:shell": "bats tests/update.bats",
  "mcp:call": "node src/cli/mcp-call.ts",
  "chat": "AGENT_MODE=chat node src/cli/unified.ts",
  "voice": "AGENT_MODE=voice node src/cli/unified.ts",
  "start": "node src/cli/unified.ts",
  "start:wake": "AGENT_MODE=wake node src/cli/unified.ts",
  "start:both": "AGENT_MODE=both node src/cli/unified.ts",
  "lint": "eslint .",
  "lint:fix": "eslint . --fix",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "prepare": "husky || true"
}
```

`npm run start` (no env) defaults to `AGENT_MODE=both` via `parseAgentMode`. `start:wake` is provided for the deploy compose file (currently `npm run start`) so we can pin the Pi to wake-only when needed without code changes.

- [ ] **Step 2: Verify scripts work**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run chat` (then immediately `Ctrl+D` or `Ctrl+C`)
Expected: prints `[unified] AGENT_MODE=chat` and `Chat ready. ...`. No crash.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(scripts): point npm scripts at unified.ts entry"
```

---

## Task 8: Update `deploy/docker-compose.yml` if it pins the entry script

**Files:**

- Inspect: `deploy/docker-compose.yml`, `deploy/Dockerfile`

- [ ] **Step 1: Check whether the container hardcodes a CLI script**

Run: `grep -nE "src/cli|npm run|CMD" deploy/Dockerfile deploy/docker-compose.yml`
Expected: shows what command the Pi container runs.

- [ ] **Step 2: If `CMD` or compose `command:` runs `node src/cli/run.ts`, replace with `node src/cli/unified.ts`**

Edit the relevant line. Example for Dockerfile:

```dockerfile
CMD ["node", "src/cli/unified.ts"]
```

The default `AGENT_MODE=both` is what we want on the Pi: the wake-word listener stays up, and Plan 2 will add the Telegram polling alongside it without compose changes. If for any reason you want to stay wake-only on the Pi until Plan 2 lands, set `AGENT_MODE=wake` in `/opt/voice-assistant/.env`.

- [ ] **Step 3: Verify image still builds (optional, but recommended)**

Run: `docker build -f deploy/Dockerfile .`
Expected: successful build (only do this if you have time / Docker is available).

- [ ] **Step 4: Commit**

```bash
git add deploy/Dockerfile deploy/docker-compose.yml
git commit -m "deploy: run unified.ts in the Pi container"
```

If grep showed nothing needs changing, skip this commit.

---

## Task 9: Manual smoke tests on macOS

This task has no code — it's a checklist you run to confirm runtime behaviour matches before/after.

- [ ] **Step 1: Start a dev HA**

Run: `docker compose -f docker/docker-compose.yml up -d`

- [ ] **Step 2: Sanity check MCP**

Run: `npm run mcp:call -- list`
Expected: prints HA's tool list with at least `HassTurnOn`.

- [ ] **Step 3: Test chat mode**

Run: `npm run chat`
Type: `включи лампу`
Expected: agent calls a HA tool, responds. `Ctrl+C` to exit.

- [ ] **Step 4: Test voice mode**

Run: `npm run voice`
Press Enter, speak, press Enter.
Expected: transcription, agent reply, TTS plays.

- [ ] **Step 5: Test wake mode**

Run: `AGENT_MODE=wake npm run start` (or `npm run start:wake`)
Say wake word, then a command.
Expected: listen chime, agent reply, ✓ for simple actions.

- [ ] **Step 6: Test default (`both`) mode**

Run: `npm run start`
Expected: same behaviour as wake mode for now (Plan 2 will add Telegram). Console prints `[unified] AGENT_MODE=both`.

If any step fails, that's a regression — fix in a follow-up commit before continuing to docs.

---

## Task 10: Update `README.md`

**Files:**

- Modify: `README.md:62-72` (Quick start commands)
- Modify: `README.md:10-29` (Status section — add a one-line entry)

- [ ] **Step 1: Replace the "Try the channels" block in README.md**

Find this block (around line 64):

```markdown
# 7. Try the channels

npm run chat # text REPL
npm run voice # push-to-talk (Enter to start/stop)
npm run start # always-listening daemon (wake-word + VAD)
```

Replace with:

```markdown
# 7. Try the channels

npm run chat # text REPL (AGENT_MODE=chat)
npm run voice # push-to-talk (AGENT_MODE=voice)
npm run start # default — all enabled channels at once (AGENT_MODE=both)
npm run start:wake # always-listening daemon only (AGENT_MODE=wake)

# AGENT_MODE picks the runner(s). Valid: chat | voice | wake | telegram | both.

# Default for `npm run start` is `both`, currently equivalent to `wake`

# (Telegram inbound is added in a follow-up plan).
```

- [ ] **Step 2: Add a Status entry**

Inside the "Status" section, after the existing bullet list, add:

```markdown
- Single-process, multi-channel entry point: `node src/cli/unified.ts`
  routes by `AGENT_MODE`. Old `chat.ts`/`voice.ts`/`run.ts` are now thin
  shims over it.
```

- [ ] **Step 3: Verify README renders cleanly**

Run: `npm run format`
Expected: prettier touches `README.md` only if formatting drifted, otherwise no-op.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): document AGENT_MODE and unified entry point"
```

---

## Task 11: Update `CLAUDE.md`

`CLAUDE.md` has an "Entry points" table and a "Critical conventions" section. Both need an entry for the unified flow.

**Files:**

- Modify: `CLAUDE.md` (the "Entry points" table around the Architecture section, and a new note in "Critical conventions")

- [ ] **Step 1: Replace the "Entry points" table**

Find the table that lists `mcp-call.ts`, `chat.ts`, `voice.ts`, `run.ts`. Replace with:

```markdown
| File                          | What                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli/mcp-call.ts`         | One-shot MCP CLI: list tools or call one. Useful for verifying HA connectivity.                                                                      |
| `src/cli/unified.ts`          | **The entry point.** Reads `AGENT_MODE` (chat / voice / wake / telegram / both) and runs the matching runner(s). `npm run start` defaults to `both`. |
| `src/cli/runners/chat.ts`     | Text REPL loop.                                                                                                                                      |
| `src/cli/runners/voice.ts`    | Push-to-talk: Enter starts/stops recording.                                                                                                          |
| `src/cli/runners/wake.ts`     | Always-listening: Wake-word → VAD → STT → agent → TTS.                                                                                               |
| `src/cli/{chat,voice,run}.ts` | Thin shims that set `AGENT_MODE` and re-export `unified.ts`. Kept for backward-compat.                                                               |
```

- [ ] **Step 2: Add a convention bullet about the dispatcher**

In the "Critical conventions" section, after the "Adapter pattern" bullet, add:

```markdown
**One process, many channels.** `src/cli/unified.ts` is the single entry. Adding a new input channel = adding a runner under `src/cli/runners/` and a case in the `dispatch()` switch — never another top-level entry script. Per-channel system-prompt addenda live in `src/cli/shared.ts::buildSystemPromptFor`.
```

- [ ] **Step 3: Verify formatting**

Run: `npm run format`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): document unified entry + runners directory"
```

---

## Task 12: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all green. New tests for `shared.ts`, `unified.ts`, and the three runner smoke tests should add ~14 passing assertions.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Confirm git log shows ≥10 small commits**

Run: `git log --oneline main..HEAD`
Expected: roughly 10-12 commits, one per task. If anything is bundled into a single commit, that's a smell — re-split before opening a PR.

- [ ] **Step 5: Open the PR description draft**

Suggested PR title: `refactor(cli): unify entry points behind AGENT_MODE`

Suggested body:

```
First step of the personal-agent migration (see docs/superpowers/plans/2026-04-26-unify-cli-entrypoints.md).

- New: src/cli/unified.ts dispatches by AGENT_MODE.
- New: src/cli/runners/{chat,voice,wake}.ts.
- New: src/cli/shared.ts owns init lifecycle + per-channel prompt building.
- chat.ts/voice.ts/run.ts → 2-line shims for backward-compat.
- npm run start defaults to AGENT_MODE=both (currently == wake; Telegram lands in Plan 2).

No runtime behaviour change for existing channels.
```

---

## Verification

End-to-end checklist (covered by Tasks 9 & 12):

- ✅ `npm run start` (no env) starts wake-word listener with the silent-confirmation prompt.
- ✅ `npm run chat` opens a text REPL with the base prompt.
- ✅ `npm run voice` does push-to-talk with the short-replies prompt.
- ✅ `AGENT_MODE=telegram npm run start` prints a "not yet implemented" message and exits cleanly.
- ✅ `AGENT_MODE=garbage npm run start` exits with a helpful error mentioning the valid modes.
- ✅ Existing `npm test` suite (~all current tests) is unchanged and still passes.
- ✅ HA MCP integration still works — `npm run mcp:call -- list` returns tools.

## Notes

- The shims (`chat.ts`/`voice.ts`/`run.ts`) are mainly for muscle memory — anyone running `npm run chat` or `node src/cli/voice.ts` should still get the same thing. We can delete them in Plan 2 or 3 once the team is used to the unified flow; not now.
- `AGENT_MODE=both` initially equals `AGENT_MODE=wake` because there's only one runner active. Plan 2 will add the `telegram` runner to the `both` branch.
- The `dispatch()` function is exported solely for testing. `main()` calls it with the real runners; tests inject mocks. This avoids needing fancier DI machinery.
- We deliberately do NOT introduce a CLI flag library (commander, yargs) — env var is sufficient and matches the existing config style.
