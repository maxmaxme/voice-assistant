# Telegram Inbound Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Telegram bot bidirectional. Today the agent can `send_to_telegram` (outbound only). After this plan, the user can DM the bot from any device — text messages flow through `agent.respond()` and the answer comes back to the same chat. Voice messages from Telegram are explicitly out of scope (Plan 2-bis).

**Architecture:** A new `TelegramReceiver` interface implemented by `PollingTelegramReceiver`. It polls `getUpdates` with long polling (30s) and a persisted `update_id` offset, emits `TelegramMessage` events. A new runner `runTelegramMode` wires the receiver to a per-channel `OpenAiAgent`, applies authorisation (whitelist of chat IDs), formats `/`-commands, and ships replies via the existing `BotTelegramSender`. `unified.ts` schedules the runner alongside `wake` for `AGENT_MODE=both`.

**Tech Stack:** Node 24 native TS stripping, `fetch` (Node built-in), Vitest with `vi.fn()`-mocked fetch. No new npm deps.

**Prerequisite:** Plan `2026-04-26-unify-cli-entrypoints.md` is merged. `src/cli/unified.ts` and `src/cli/shared.ts` exist.

---

## File Structure

```
src/telegram/
├── types.ts                       # MODIFIED: add TelegramReceiver + TelegramMessage
├── telegramSender.ts              # UNCHANGED
├── fromConfig.ts                  # MODIFIED: also export receiverFromConfig
├── pollingReceiver.ts             # NEW: long-poll getUpdates
└── offsetStore.ts                 # NEW: persist update_id between restarts

src/cli/runners/
└── telegram.ts                    # NEW: receiver → agent → sender loop

src/config.ts                      # MODIFIED: add TELEGRAM_ALLOWED_CHAT_IDS

tests/telegram/
├── pollingReceiver.test.ts
└── offsetStore.test.ts

tests/cli/runners/
└── telegram.test.ts               # router-level test (mock receiver + sender)
```

---

## Out-of-scope (do NOT do here)

- ❌ Voice notes from Telegram (`message.voice`). Stub the path so it doesn't crash, but don't transcribe.
- ❌ Webhooks. Polling is the chosen approach.
- ❌ Inline keyboards / callback queries.
- ❌ Multi-user profile separation. Memory is still single-user.
- ❌ Reminder/timer tools. Plan 3 owns those.

---

## Task 1: Extend Telegram types

**Files:**

- Modify: `src/telegram/types.ts`
- Create: `tests/telegram/types.compile.test.ts` (compile-only sanity)

- [ ] **Step 1: Write the failing test**

Create `tests/telegram/types.compile.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { TelegramReceiver, TelegramMessage } from '../../src/telegram/types.ts';

describe('telegram types', () => {
  it('TelegramMessage shape', () => {
    const msg: TelegramMessage = {
      updateId: 1,
      chatId: 42,
      fromUserId: 7,
      kind: 'text',
      text: 'hi',
      receivedAt: Date.now(),
    };
    expect(msg.kind).toBe('text');
  });

  it('TelegramReceiver is implementable', () => {
    const stub: TelegramReceiver = {
      async *messages() {
        // empty
      },
      async stop() {},
    };
    expect(stub).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram/types.compile.test.ts`
Expected: FAIL — `TelegramReceiver` / `TelegramMessage` not exported.

- [ ] **Step 3: Modify `src/telegram/types.ts`**

Append to the existing file:

```typescript
export type TelegramMessage =
  | {
      updateId: number;
      chatId: number;
      fromUserId: number;
      kind: 'text';
      text: string;
      receivedAt: number;
    }
  | {
      updateId: number;
      chatId: number;
      fromUserId: number;
      kind: 'voice';
      /** Telegram file_id; download via getFile when implemented. */
      fileId: string;
      durationSec: number;
      receivedAt: number;
    }
  | {
      updateId: number;
      chatId: number;
      fromUserId: number;
      kind: 'unsupported';
      reason: string;
      receivedAt: number;
    };

export interface TelegramReceiver {
  /** Async iterator of messages. Implementations long-poll under the hood. */
  messages(): AsyncIterable<TelegramMessage>;
  stop(): Promise<void>;
}
```

Keep the existing `TelegramSender` interface intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/telegram/types.compile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/types.ts tests/telegram/types.compile.test.ts
git commit -m "feat(telegram): add TelegramReceiver + TelegramMessage types"
```

---

## Task 2: Persistent offset store

`update_id` must be persisted so we don't replay a 7h backlog when systemd restarts the container at 04:00.

**Files:**

- Create: `src/telegram/offsetStore.ts`
- Create: `tests/telegram/offsetStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/telegram/offsetStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileOffsetStore } from '../../src/telegram/offsetStore.ts';

describe('FileOffsetStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-offset-'));
    file = path.join(dir, 'offset.json');
  });

  it('returns 0 when file is missing', () => {
    const s = new FileOffsetStore(file);
    expect(s.read()).toBe(0);
  });

  it('round-trips a value', () => {
    const s = new FileOffsetStore(file);
    s.write(123);
    expect(s.read()).toBe(123);
    expect(new FileOffsetStore(file).read()).toBe(123);
  });

  it('returns 0 if the file is corrupt', () => {
    fs.writeFileSync(file, 'not json');
    expect(new FileOffsetStore(file).read()).toBe(0);
  });

  it('write creates the parent directory', () => {
    const nested = path.join(dir, 'a/b/c/offset.json');
    const s = new FileOffsetStore(nested);
    s.write(7);
    expect(s.read()).toBe(7);
  });

  it('write is monotonic — never goes backwards', () => {
    const s = new FileOffsetStore(file);
    s.write(10);
    s.write(5); // ignored
    expect(s.read()).toBe(10);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/telegram/offsetStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/telegram/offsetStore.ts`**

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface OffsetStore {
  read(): number;
  write(value: number): void;
}

export class FileOffsetStore implements OffsetStore {
  private cached: number | null = null;
  constructor(private readonly filePath: string) {}

  read(): number {
    if (this.cached !== null) return this.cached;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const v = typeof parsed?.offset === 'number' ? parsed.offset : 0;
      this.cached = v;
      return v;
    } catch {
      this.cached = 0;
      return 0;
    }
  }

  write(value: number): void {
    const current = this.read();
    if (value <= current) return; // monotonic
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ offset: value }));
    this.cached = value;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/telegram/offsetStore.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/offsetStore.ts tests/telegram/offsetStore.test.ts
git commit -m "feat(telegram): persistent update_id offset store"
```

---

## Task 3: PollingTelegramReceiver

Long-poll `getUpdates` with `timeout=30`, parse updates into `TelegramMessage`, advance offset.

**Files:**

- Create: `src/telegram/pollingReceiver.ts`
- Create: `tests/telegram/pollingReceiver.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/telegram/pollingReceiver.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PollingTelegramReceiver } from '../../src/telegram/pollingReceiver.ts';
import type { OffsetStore } from '../../src/telegram/offsetStore.ts';

function memOffset(initial = 0): OffsetStore {
  let v = initial;
  return {
    read: () => v,
    write: (x) => {
      if (x > v) v = x;
    },
  };
}

function fetchSequence(responses: unknown[]): typeof fetch {
  let i = 0;
  return (async (_url: any, _init?: any) => {
    const body = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('PollingTelegramReceiver', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('emits a single text message and advances offset', async () => {
    const store = memOffset(0);
    const fetchImpl = fetchSequence([
      {
        ok: true,
        result: [
          {
            update_id: 100,
            message: {
              message_id: 1,
              from: { id: 7, is_bot: false },
              chat: { id: 42, type: 'private' },
              date: 1700000000,
              text: 'hi',
            },
          },
        ],
      },
      { ok: true, result: [] },
    ]);
    const r = new PollingTelegramReceiver({
      botToken: 'X',
      offsetStore: store,
      fetchImpl,
      pollTimeoutSec: 0,
    });

    const iter = r.messages()[Symbol.asyncIterator]();
    const first = await iter.next();
    await r.stop();
    expect(first.done).toBe(false);
    if (first.done) return;
    expect(first.value.kind).toBe('text');
    if (first.value.kind === 'text') {
      expect(first.value.text).toBe('hi');
      expect(first.value.chatId).toBe(42);
      expect(first.value.fromUserId).toBe(7);
      expect(first.value.updateId).toBe(100);
    }
    expect(store.read()).toBe(101);
  });

  it('classifies voice messages without crashing', async () => {
    const store = memOffset(0);
    const fetchImpl = fetchSequence([
      {
        ok: true,
        result: [
          {
            update_id: 200,
            message: {
              message_id: 2,
              from: { id: 7, is_bot: false },
              chat: { id: 42, type: 'private' },
              date: 1700000001,
              voice: { file_id: 'F1', duration: 4 },
            },
          },
        ],
      },
      { ok: true, result: [] },
    ]);
    const r = new PollingTelegramReceiver({
      botToken: 'X',
      offsetStore: store,
      fetchImpl,
      pollTimeoutSec: 0,
    });
    const iter = r.messages()[Symbol.asyncIterator]();
    const first = await iter.next();
    await r.stop();
    expect(first.value?.kind).toBe('voice');
    if (first.value?.kind === 'voice') {
      expect(first.value.fileId).toBe('F1');
      expect(first.value.durationSec).toBe(4);
    }
  });

  it('classifies unsupported updates as "unsupported"', async () => {
    const store = memOffset(0);
    const fetchImpl = fetchSequence([
      {
        ok: true,
        result: [
          {
            update_id: 300,
            message: {
              message_id: 3,
              from: { id: 7, is_bot: false },
              chat: { id: 42, type: 'private' },
              date: 1700000002,
              photo: [{ file_id: 'P', width: 100, height: 100 }],
            },
          },
        ],
      },
      { ok: true, result: [] },
    ]);
    const r = new PollingTelegramReceiver({
      botToken: 'X',
      offsetStore: store,
      fetchImpl,
      pollTimeoutSec: 0,
    });
    const iter = r.messages()[Symbol.asyncIterator]();
    const first = await iter.next();
    await r.stop();
    expect(first.value?.kind).toBe('unsupported');
  });

  it('starts from persisted offset+1', async () => {
    const store = memOffset(99);
    const calls: string[] = [];
    const fetchImpl = (async (url: any) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = new PollingTelegramReceiver({
      botToken: 'X',
      offsetStore: store,
      fetchImpl,
      pollTimeoutSec: 0,
    });
    const iter = r.messages()[Symbol.asyncIterator]();
    // kick one poll
    const p = iter.next();
    await new Promise((res) => setTimeout(res, 5));
    await r.stop();
    await p.catch(() => {}); // it'll resolve after stop()
    expect(calls[0]).toContain('offset=100');
  });

  it('treats response.ok=false as a transient error and retries', async () => {
    const store = memOffset(0);
    let i = 0;
    const fetchImpl = (async () => {
      i++;
      if (i === 1)
        return new Response(JSON.stringify({ ok: false, description: 'flood' }), { status: 200 });
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 500,
              message: {
                message_id: 9,
                from: { id: 7, is_bot: false },
                chat: { id: 42, type: 'private' },
                date: 1700000003,
                text: 'recovered',
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = new PollingTelegramReceiver({
      botToken: 'X',
      offsetStore: store,
      fetchImpl,
      pollTimeoutSec: 0,
      retryDelayMs: 1,
    });
    const iter = r.messages()[Symbol.asyncIterator]();
    const got = await iter.next();
    await r.stop();
    expect(got.value?.kind).toBe('text');
  });

  it('stop() makes the iterator terminate', async () => {
    const store = memOffset(0);
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const r = new PollingTelegramReceiver({
      botToken: 'X',
      offsetStore: store,
      fetchImpl,
      pollTimeoutSec: 0,
    });
    const iter = r.messages()[Symbol.asyncIterator]();
    const p = iter.next();
    await r.stop();
    const out = await p;
    expect(out.done).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/telegram/pollingReceiver.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/telegram/pollingReceiver.ts`**

```typescript
import type { TelegramReceiver, TelegramMessage } from './types.ts';
import type { OffsetStore } from './offsetStore.ts';

export interface PollingTelegramReceiverOptions {
  botToken: string;
  offsetStore: OffsetStore;
  fetchImpl?: typeof fetch;
  /** getUpdates long-poll timeout, seconds. Default 30. Use 0 in tests. */
  pollTimeoutSec?: number;
  /** Backoff between failed polls. Default 2000 ms. */
  retryDelayMs?: number;
}

interface RawUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number };
    chat: { id: number };
    date: number;
    text?: string;
    voice?: { file_id: string; duration: number };
  };
}

export class PollingTelegramReceiver implements TelegramReceiver {
  private readonly botToken: string;
  private readonly store: OffsetStore;
  private readonly fetchImpl: typeof fetch;
  private readonly pollTimeoutSec: number;
  private readonly retryDelayMs: number;
  private stopped = false;
  private currentAbort: AbortController | null = null;

  constructor(opts: PollingTelegramReceiverOptions) {
    this.botToken = opts.botToken;
    this.store = opts.offsetStore;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 30;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;
  }

  async *messages(): AsyncIterable<TelegramMessage> {
    while (!this.stopped) {
      let updates: RawUpdate[] | null;
      try {
        updates = await this.poll();
      } catch (err) {
        if (this.stopped) return;
        process.stderr.write(`[telegram] poll error: ${(err as Error).message}\n`);
        await this.sleep(this.retryDelayMs);
        continue;
      }
      if (updates === null) {
        // ok:false response — backoff and retry
        await this.sleep(this.retryDelayMs);
        continue;
      }

      for (const u of updates) {
        const msg = this.classify(u);
        if (msg) yield msg;
        this.store.write(u.update_id + 1);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.currentAbort?.abort();
  }

  private async poll(): Promise<RawUpdate[] | null> {
    const offset = this.store.read();
    const params = new URLSearchParams({
      offset: String(offset),
      timeout: String(this.pollTimeoutSec),
      allowed_updates: JSON.stringify(['message']),
    });
    const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?${params}`;
    this.currentAbort = new AbortController();
    const res = await this.fetchImpl(url, { signal: this.currentAbort.signal });
    const json = (await res.json()) as { ok: boolean; result?: RawUpdate[]; description?: string };
    if (!json.ok) {
      process.stderr.write(`[telegram] getUpdates ok=false: ${json.description ?? 'unknown'}\n`);
      return null;
    }
    return json.result ?? [];
  }

  private classify(u: RawUpdate): TelegramMessage | null {
    const m = u.message;
    if (!m || !m.from) return null;
    const base = {
      updateId: u.update_id,
      chatId: m.chat.id,
      fromUserId: m.from.id,
      receivedAt: m.date * 1000,
    };
    if (m.text !== undefined) return { ...base, kind: 'text', text: m.text };
    if (m.voice)
      return { ...base, kind: 'voice', fileId: m.voice.file_id, durationSec: m.voice.duration };
    return { ...base, kind: 'unsupported', reason: 'unhandled message type' };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/telegram/pollingReceiver.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/pollingReceiver.ts tests/telegram/pollingReceiver.test.ts
git commit -m "feat(telegram): polling receiver with persisted offset"
```

---

## Task 4: Config — allowlist of chat IDs

A bot token is public-by-discoverability — anyone who guesses the username can DM the agent. Whitelist the user's chat IDs.

**Files:**

- Modify: `src/config.ts`
- Modify: `tests/config.test.ts` (add allowed-ids cases)

- [ ] **Step 1: Add a failing test**

Append to `tests/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('telegram.allowedChatIds', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env = {
      ...original,
      HA_URL: 'http://x',
      HA_TOKEN: 't',
      OPENAI_API_KEY: 'k',
      TELEGRAM_BOT_TOKEN: 'b',
      TELEGRAM_CHAT_ID: '42',
    };
  });
  afterEach(() => {
    process.env = original;
  });

  it('defaults to [chatId] when allow-list is unset', () => {
    delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    const cfg = loadConfig();
    expect(cfg.telegram.allowedChatIds).toEqual([42]);
  });

  it('parses a comma list', () => {
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = '42, 100, -5';
    const cfg = loadConfig();
    expect(cfg.telegram.allowedChatIds).toEqual([42, 100, -5]);
  });

  it('rejects non-numeric entries', () => {
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = '42,abc';
    expect(() => loadConfig()).toThrow();
  });
});
```

(Existing tests in `tests/config.test.ts` may already shadow `process.env`; if so adapt the pattern.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts -t 'allowedChatIds'`
Expected: FAIL.

- [ ] **Step 3: Modify `src/config.ts`**

Inside the `telegram` zod object:

```typescript
telegram: z.object({
  botToken: z.string().min(1),
  chatId: z.string().min(1),
  allowedChatIds: z.array(z.number().int()).default([]),
}),
```

In `loadConfig`, before the parse, parse the allowlist from env:

```typescript
const allowedRaw = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
const allowedChatIds = allowedRaw
  ? allowedRaw.split(',').map((s) => {
      const n = Number(s.trim());
      if (!Number.isFinite(n)) throw new Error(`TELEGRAM_ALLOWED_CHAT_IDS: not a number: ${s}`);
      return n;
    })
  : undefined;
```

Add it to the `telegram` block of `raw`:

```typescript
telegram: {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  allowedChatIds, // undefined → zod default → []
},
```

After parsing, fill the default from `chatId` if the list is empty:

```typescript
const data = parsed.data;
if (data.telegram.allowedChatIds.length === 0) {
  const fromChat = Number(data.telegram.chatId);
  data.telegram.allowedChatIds = Number.isFinite(fromChat) ? [fromChat] : [];
}
return data;
```

Add to `PATH_TO_ENV`: `'telegram.allowedChatIds': 'TELEGRAM_ALLOWED_CHAT_IDS'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: all green including the 3 new cases.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add TELEGRAM_ALLOWED_CHAT_IDS allow-list"
```

---

## Task 5: `receiverFromConfig` factory

Mirror `telegramFromConfig` for the inbound side.

**Files:**

- Modify: `src/telegram/fromConfig.ts`

- [ ] **Step 1: Add the factory**

Append to `fromConfig.ts`:

```typescript
import { PollingTelegramReceiver } from './pollingReceiver.ts';
import { FileOffsetStore } from './offsetStore.ts';
import * as path from 'node:path';
import type { TelegramReceiver } from './types.ts';

export function receiverFromConfig(cfg: Config): TelegramReceiver {
  const offsetPath = path.join(path.dirname(cfg.memory.dbPath), 'telegram-offset.json');
  return new PollingTelegramReceiver({
    botToken: cfg.telegram.botToken,
    offsetStore: new FileOffsetStore(offsetPath),
  });
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/telegram/fromConfig.ts
git commit -m "feat(telegram): receiverFromConfig factory"
```

---

## Task 6: Telegram runner with auth + command routing

The runner is the glue: pull messages, check authorisation, route slash-commands locally, forward text to `agent.respond`, send the reply.

**Files:**

- Create: `src/cli/runners/telegram.ts`
- Create: `tests/cli/runners/telegram.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/runners/telegram.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runTelegramMode } from '../../../src/cli/runners/telegram.ts';
import type {
  TelegramMessage,
  TelegramReceiver,
  TelegramSender,
} from '../../../src/telegram/types.ts';

function recvFromMessages(items: TelegramMessage[]): TelegramReceiver {
  return {
    async *messages() {
      for (const m of items) yield m;
    },
    async stop() {},
  };
}

const captureSender = (): { sender: TelegramSender; sent: string[] } => {
  const sent: string[] = [];
  return {
    sent,
    sender: {
      async send(text: string) {
        sent.push(text);
      },
    },
  };
};

describe('runTelegramMode', () => {
  it('forwards a text message to the agent and replies', async () => {
    const respond = vi.fn(async (text: string) => ({ text: `echo:${text}` }));
    const session = { reset: vi.fn() };
    const memory = { recall: vi.fn(() => ({})) };
    const cap = captureSender();

    await runTelegramMode({
      receiver: recvFromMessages([
        { updateId: 1, chatId: 42, fromUserId: 7, kind: 'text', text: 'hi', receivedAt: 0 },
      ]),
      sender: cap.sender,
      agent: { respond } as any,
      session: session as any,
      memory: memory as any,
      allowedChatIds: [42],
    });

    expect(respond).toHaveBeenCalledWith('hi');
    expect(cap.sent).toEqual(['echo:hi']);
  });

  it('rejects messages from non-allowlisted chats with no agent call', async () => {
    const respond = vi.fn();
    const cap = captureSender();
    await runTelegramMode({
      receiver: recvFromMessages([
        { updateId: 1, chatId: 999, fromUserId: 7, kind: 'text', text: 'sneak', receivedAt: 0 },
      ]),
      sender: cap.sender,
      agent: { respond } as any,
      session: { reset: vi.fn() } as any,
      memory: { recall: vi.fn(() => ({})) } as any,
      allowedChatIds: [42],
    });
    expect(respond).not.toHaveBeenCalled();
    expect(cap.sent).toEqual([]);
  });

  it('handles /reset locally', async () => {
    const respond = vi.fn();
    const session = { reset: vi.fn() };
    const cap = captureSender();
    await runTelegramMode({
      receiver: recvFromMessages([
        { updateId: 1, chatId: 42, fromUserId: 7, kind: 'text', text: '/reset', receivedAt: 0 },
      ]),
      sender: cap.sender,
      agent: { respond } as any,
      session: session as any,
      memory: { recall: vi.fn(() => ({})) } as any,
      allowedChatIds: [42],
    });
    expect(session.reset).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalled();
    expect(cap.sent[0]).toMatch(/context cleared/i);
  });

  it('handles /profile locally', async () => {
    const respond = vi.fn();
    const recall = vi.fn(() => ({ name: 'Maxim' }));
    const cap = captureSender();
    await runTelegramMode({
      receiver: recvFromMessages([
        { updateId: 1, chatId: 42, fromUserId: 7, kind: 'text', text: '/profile', receivedAt: 0 },
      ]),
      sender: cap.sender,
      agent: { respond } as any,
      session: { reset: vi.fn() } as any,
      memory: { recall } as any,
      allowedChatIds: [42],
    });
    expect(recall).toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(cap.sent[0]).toContain('Maxim');
  });

  it('handles /start with a help message', async () => {
    const respond = vi.fn();
    const cap = captureSender();
    await runTelegramMode({
      receiver: recvFromMessages([
        { updateId: 1, chatId: 42, fromUserId: 7, kind: 'text', text: '/start', receivedAt: 0 },
      ]),
      sender: cap.sender,
      agent: { respond } as any,
      session: { reset: vi.fn() } as any,
      memory: { recall: vi.fn(() => ({})) } as any,
      allowedChatIds: [42],
    });
    expect(respond).not.toHaveBeenCalled();
    expect(cap.sent[0]).toMatch(/help|команд|hi/i);
  });

  it('replies to voice messages with a "not yet supported" notice', async () => {
    const respond = vi.fn();
    const cap = captureSender();
    await runTelegramMode({
      receiver: recvFromMessages([
        {
          updateId: 1,
          chatId: 42,
          fromUserId: 7,
          kind: 'voice',
          fileId: 'F',
          durationSec: 3,
          receivedAt: 0,
        },
      ]),
      sender: cap.sender,
      agent: { respond } as any,
      session: { reset: vi.fn() } as any,
      memory: { recall: vi.fn(() => ({})) } as any,
      allowedChatIds: [42],
    });
    expect(respond).not.toHaveBeenCalled();
    expect(cap.sent[0]).toMatch(/voice|голос/i);
  });

  it('reports agent errors back to the user instead of crashing', async () => {
    const respond = vi.fn(async () => {
      throw new Error('boom');
    });
    const cap = captureSender();
    await runTelegramMode({
      receiver: recvFromMessages([
        { updateId: 1, chatId: 42, fromUserId: 7, kind: 'text', text: 'go', receivedAt: 0 },
      ]),
      sender: cap.sender,
      agent: { respond } as any,
      session: { reset: vi.fn() } as any,
      memory: { recall: vi.fn(() => ({})) } as any,
      allowedChatIds: [42],
    });
    expect(cap.sent[0]).toMatch(/error|ошибк/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli/runners/telegram.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/cli/runners/telegram.ts`**

```typescript
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { Session } from '../../agent/session.ts';
import type { MemoryAdapter } from '../../memory/types.ts';
import type { TelegramReceiver, TelegramSender, TelegramMessage } from '../../telegram/types.ts';
import { BotTelegramSender } from '../../telegram/telegramSender.ts';

export interface TelegramRunnerDeps {
  receiver: TelegramReceiver;
  /** Sender used to reply to the *originating* chat. The default factory uses
   * the configured chat_id; the runner overrides it per-message via `replyTo`. */
  sender: TelegramSender;
  agent: OpenAiAgent;
  session: Session;
  memory: MemoryAdapter;
  allowedChatIds: number[];
  /** Build a new sender targeting a specific chat. Defaults to the global one
   * (single-user setup). Tests inject this. */
  replyTo?: (chatId: number) => TelegramSender;
}

const HELP_TEXT = `Personal-agent bot ready. Just type — I forward to the agent.
Commands:
  /reset — clear conversation context
  /profile — dump remembered profile
  /help — show this`;

export async function runTelegramMode(deps: TelegramRunnerDeps): Promise<void> {
  const { receiver, agent, session, memory, allowedChatIds } = deps;
  const allow = new Set(allowedChatIds);

  for await (const msg of receiver.messages()) {
    const replyer = deps.replyTo ? deps.replyTo(msg.chatId) : deps.sender;
    if (!allow.has(msg.chatId)) {
      process.stderr.write(
        `[telegram] dropped message from chat=${msg.chatId} (not allow-listed)\n`,
      );
      continue;
    }
    try {
      await handleMessage(msg, { agent, session, memory, sender: replyer });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[telegram] handler error: ${text}\n`);
      try {
        await replyer.send(`Internal error: ${text}`);
      } catch {
        // swallow — Telegram itself is failing
      }
    }
  }
}

async function handleMessage(
  msg: TelegramMessage,
  ctx: { agent: OpenAiAgent; session: Session; memory: MemoryAdapter; sender: TelegramSender },
): Promise<void> {
  if (msg.kind === 'voice') {
    await ctx.sender.send('Voice messages are not supported yet — please send text.');
    return;
  }
  if (msg.kind === 'unsupported') {
    await ctx.sender.send('Unsupported message type. Send text or use a command (/help).');
    return;
  }

  const text = msg.text.trim();
  if (text === '/start' || text === '/help') {
    await ctx.sender.send(HELP_TEXT);
    return;
  }
  if (text === '/reset') {
    ctx.session.reset();
    await ctx.sender.send('Context cleared.');
    return;
  }
  if (text === '/profile') {
    await ctx.sender.send(JSON.stringify(ctx.memory.recall(), null, 2));
    return;
  }

  let reply;
  try {
    reply = await ctx.agent.respond(text);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await ctx.sender.send(`Agent error: ${m}`);
    return;
  }
  await ctx.sender.send(reply.text || '(empty reply)');
}

/** Build a sender that replies to a specific chat using the same bot token. */
export function perChatSender(botToken: string): (chatId: number) => TelegramSender {
  return (chatId) => new BotTelegramSender({ botToken, chatId: String(chatId) });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cli/runners/telegram.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/runners/telegram.ts tests/cli/runners/telegram.test.ts
git commit -m "feat(cli): telegram inbound runner with auth + commands"
```

---

## Task 7: Wire the Telegram runner into `unified.ts`

**Files:**

- Modify: `src/cli/unified.ts`
- Modify: `tests/cli/unified.test.ts`

- [ ] **Step 1: Update tests**

Replace the `'telegram mode is a no-op stub'` and `'both mode invokes wake'` tests with:

```typescript
it('telegram mode invokes runTelegramMode only', async () => {
  const deps = makeDeps();
  const runners = {
    chat: vi.fn(async () => {}),
    voice: vi.fn(async () => {}),
    wake: vi.fn(async () => {}),
    telegram: vi.fn(async () => {}),
  };
  await dispatch('telegram' as AgentMode, deps, runners);
  expect(runners.telegram).toHaveBeenCalledTimes(1);
});

it('both mode invokes wake AND telegram concurrently', async () => {
  const deps = makeDeps();
  const wakeStarted = vi.fn();
  const telegramStarted = vi.fn();
  const runners = {
    chat: vi.fn(async () => {}),
    voice: vi.fn(async () => {}),
    wake: vi.fn(async () => {
      wakeStarted();
      await new Promise((r) => setTimeout(r, 5));
    }),
    telegram: vi.fn(async () => {
      telegramStarted();
      await new Promise((r) => setTimeout(r, 5));
    }),
  };
  await dispatch('both' as AgentMode, deps, runners);
  expect(wakeStarted).toHaveBeenCalled();
  expect(telegramStarted).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli/unified.test.ts`
Expected: FAIL — `runners.telegram` doesn't exist on the type.

- [ ] **Step 3: Update `src/cli/unified.ts`**

Add to imports:

```typescript
import { runTelegramMode, perChatSender } from './runners/telegram.ts';
import { receiverFromConfig } from '../telegram/fromConfig.ts';
```

Extend `RunnerSet`:

```typescript
export interface RunnerSet {
  chat: (deps: any) => Promise<void>;
  voice: (deps: any) => Promise<void>;
  wake: (deps: any) => Promise<void>;
  telegram: (deps: any) => Promise<void>;
}
```

In `dispatch`, replace the `telegram` stub branch with a real schedule, and add Telegram to `both`:

```typescript
const scheduleTelegram = (): void => {
  const agent = deps.buildAgent('telegram');
  const session = (agent as unknown as { opts: { session: any } }).opts.session;
  tasks.push(
    runners.telegram({
      receiver: deps.telegramReceiver(),
      sender: deps.telegram,
      agent,
      session,
      memory: deps.memory,
      allowedChatIds: deps.config.telegram.allowedChatIds,
      replyTo: perChatSender(deps.config.telegram.botToken),
    }),
  );
};

if (mode === 'telegram') scheduleTelegram();
if (mode === 'both') scheduleTelegram();
```

(Remove the old `if (mode === 'telegram') console.log…return;` stub.)

`CommonDeps` needs a new factory `telegramReceiver: () => TelegramReceiver`. Update `src/cli/shared.ts`:

```typescript
import { receiverFromConfig } from '../telegram/fromConfig.ts';
import type { TelegramReceiver } from '../telegram/types.ts';

// inside CommonDeps:
telegramReceiver: () => TelegramReceiver;

// inside initializeCommonDependencies, before the return:
const telegramReceiver = (): TelegramReceiver => receiverFromConfig(config);

// add to the returned object: telegramReceiver
```

Update `dispose` so `telegramReceiver`'s receiver (when one was created) is stopped. Easiest: keep a list of `() => Promise<void>` cleanup hooks; runners that own resources push to it. For this plan, simpler: each `runTelegramMode` call wires `receiver.stop()` on SIGINT via the existing process-level handler (the unified `onShutdown` already does that — receiver.stop() is idempotent).

Actually keep it ultra-simple: extend `dispose` to also stop one ambient receiver. Update `shared.ts`:

```typescript
let activeReceiver: TelegramReceiver | null = null;
const telegramReceiver = (): TelegramReceiver => {
  activeReceiver = receiverFromConfig(config);
  return activeReceiver;
};

const dispose = async (): Promise<void> => {
  if (disposed) return;
  disposed = true;
  if (activeReceiver) await activeReceiver.stop().catch(() => {});
  await mcp.disconnect();
  memory.close();
};
```

Update the test `makeDeps()` helper to add `telegramReceiver: vi.fn(() => ({ messages: async function* () {}, stop: vi.fn(async () => {}) }))`.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all green, including the updated `unified.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/unified.ts src/cli/shared.ts tests/cli/unified.test.ts
git commit -m "feat(cli): wire telegram runner into unified dispatch"
```

---

## Task 8: Smoke test against the real bot

This task has no automated test — it confirms end-to-end against Telegram itself.

- [ ] **Step 1: Find your chat ID**

In Telegram, send any message to your bot from your own account. Then run:

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" | jq '.result[].message.chat.id' | sort -u
```

Note the integer (e.g. `123456789`).

- [ ] **Step 2: Set the allow-list**

Add to `.env`:

```
TELEGRAM_ALLOWED_CHAT_IDS=123456789
```

(If `TELEGRAM_CHAT_ID` already equals that integer, the default allow-list will pick it up — but be explicit.)

- [ ] **Step 3: Run telegram mode in isolation**

```bash
AGENT_MODE=telegram npm run start
```

Expected: `[unified] AGENT_MODE=telegram` plus a long-poll. Console stays quiet between messages.

- [ ] **Step 4: Test the conversation**

In Telegram:

- Send `/start` → bot replies with help text.
- Send `привет` → bot replies with the agent's response.
- Send `/profile` → bot replies with JSON profile (likely `{}`).
- Send `/reset` → bot replies "Context cleared."
- Send a voice message → bot replies "not supported yet".

- [ ] **Step 5: Test allow-list**

Send a message from a _different_ Telegram account. Expected: nothing happens, server logs a "dropped message from chat=N (not allow-listed)" line.

- [ ] **Step 6: Test `both` mode**

```bash
AGENT_MODE=both npm run start
```

Expected: wake-word listener and Telegram poller both alive. Speak the wake word + a command — works. Send a Telegram text — works.

- [ ] **Step 7: Test offset persistence**

Send a message in Telegram. Stop the process (`Ctrl+C`). Restart. Confirm the just-sent message is _not_ re-processed (it was already acked by `offset` advance). The file `data/telegram-offset.json` should exist.

If anything misbehaves, fix in a follow-up commit before docs.

---

## Task 9: Update `README.md`

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add a Telegram section**

After the "Try the channels" block, insert:

````markdown
### Telegram bot (text)

The agent runs a Telegram bot that accepts text commands. Outbound messages
(via the `send_to_telegram` tool) already worked; this is the inbound side.

Setup:

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token.
2. Find your chat ID by messaging the bot once and running:

   ```bash
   curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" \
     | jq '.result[].message.chat.id' | sort -u
   ```
````

3. Set in `.env`:

   ```
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=123456789
   TELEGRAM_ALLOWED_CHAT_IDS=123456789      # comma-list, optional (defaults to TELEGRAM_CHAT_ID)
   ```

4. `npm run start` (default `AGENT_MODE=both`) runs the bot alongside the
   wake-word listener. Or `AGENT_MODE=telegram npm run start` for bot-only.

Commands: `/start`, `/help`, `/reset`, `/profile`. Voice notes are not yet
supported (see roadmap).

````

- [ ] **Step 2: Update the Status section**

Add a new bullet under "Working features":

```markdown
- Telegram bot accepts inbound text (polling). The agent answers in the
  same chat. Authorised by an allow-list of chat IDs.
````

- [ ] **Step 3: Update Requirements**

Confirm the existing requirements are unchanged (no new system deps).

- [ ] **Step 4: Format check**

Run: `npm run format`

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): document Telegram inbound bot"
```

---

## Task 10: Update `CLAUDE.md`

**Files:**

- Modify: `CLAUDE.md` — the "Telegram" section + the architecture map

- [ ] **Step 1: Replace the Telegram subsection**

Find the existing Telegram block (`### Telegram (src/telegram/)`). Replace it with:

```markdown
### Telegram (`src/telegram/`)

Bidirectional. **Outbound:** `TelegramSender` interface, `BotTelegramSender`
posts to `https://api.telegram.org/bot<token>/sendMessage`. Wired into the
agent as the `send_to_telegram` tool.

**Inbound:** `TelegramReceiver` interface, `PollingTelegramReceiver` long-polls
`getUpdates` (timeout 30s) and emits typed `TelegramMessage` events
(`text` / `voice` / `unsupported`). The persisted `update_id` lives in
`data/telegram-offset.json` so restarts don't replay history. The runner
`src/cli/runners/telegram.ts` wires the receiver to a per-channel
`OpenAiAgent`, applies the `TELEGRAM_ALLOWED_CHAT_IDS` allow-list, handles
`/reset` / `/profile` / `/start` locally, and forwards everything else.

Voice messages currently reply "not supported yet"; transcription is a
follow-up plan.

Required env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Optional:
`TELEGRAM_ALLOWED_CHAT_IDS` (comma list of integer chat ids; defaults to
`TELEGRAM_CHAT_ID`).
```

- [ ] **Step 2: Add the runner to the entry-points table**

In the table updated by Plan 1, add:

```markdown
| `src/cli/runners/telegram.ts` | Telegram bot loop: receiver → agent → sender. |
```

- [ ] **Step 3: Update the "Watch for" notes**

Add a bullet to the "Specifically watch for" list:

```markdown
- Changes to the Telegram message types (`TelegramMessage` union) — keep
  the runner's switch exhaustive, and update the test that exercises each
  branch.
```

- [ ] **Step 4: Format check + commit**

```bash
npm run format
git add CLAUDE.md
git commit -m "docs(claude.md): document Telegram inbound + receiver pattern"
```

---

## Task 11: Final verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all green. New tests: ~5 (offsetStore) + ~6 (pollingReceiver) + ~7 (runner) + 2 updated (unified) + 3 updated (config) = ~23 new/changed assertions.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 3: Manual smoke**

Re-run Task 8 if anything in the runner changed since.

- [ ] **Step 4: PR description draft**

Suggested title: `feat(telegram): inbound polling + runner`

Suggested body:

```
Plan 2 of personal-agent migration (docs/superpowers/plans/2026-04-26-telegram-inbound.md).

- TelegramReceiver interface + PollingTelegramReceiver (long-poll, persisted offset).
- TELEGRAM_ALLOWED_CHAT_IDS allow-list.
- New runner src/cli/runners/telegram.ts: handles /start /help /reset /profile,
  forwards text to the agent, replies in-chat. Voice messages get a stub reply.
- AGENT_MODE=telegram | both now schedule the runner alongside wake.
```

---

## Verification

End-to-end checklist (covered by Tasks 8 & 11):

- ✅ `AGENT_MODE=telegram npm run start` connects to Telegram and answers.
- ✅ Allow-list rejects non-listed chats silently.
- ✅ Slash-commands handled locally without an LLM call.
- ✅ Voice notes get a stub reply (no crash).
- ✅ `data/telegram-offset.json` advances; restart doesn't replay messages.
- ✅ `AGENT_MODE=both` runs wake-word + Telegram concurrently.
- ✅ `npm test` passes; old tests unchanged.

## Notes

- **Single-user assumption.** `MemoryAdapter` has no notion of `user_id`. We pass the same memory to every chat, so the allow-list effectively enforces single-user. Multi-user is out of scope.
- **Why polling, not webhooks.** Pi behind NAT — webhooks would need ngrok/Cloudflare Tunnel. Polling is fine for personal traffic.
- **Receiver stop() vs SIGINT.** `unified.ts::dispose` stops the active receiver. The polling loop's `currentAbort.abort()` cancels an in-flight `fetch`, so shutdown takes ~10ms in practice.
- **Reply target.** We use `perChatSender` so replies go to the _originating_ chat. In the single-user setup the originator is always the same chat, but this future-proofs for multi-user without a refactor.
- **Telegram rate limits.** 30 msg/sec to one chat. Personal traffic is ≪. If we ever hit it, the runner will see `ok: false; description: 429` and the existing retry-with-backoff handles it.
