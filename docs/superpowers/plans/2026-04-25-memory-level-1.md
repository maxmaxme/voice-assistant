# Memory Level 1 (User Profile, SQLite) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Long-term user profile stored in SQLite. The LLM can `remember(key, value)`, `recall(key?)`, and `forget(key)` via tools. The current profile is injected into the agent's system prompt on each turn so the assistant feels like it knows the user.

**Architecture:** A `MemoryAdapter` interface with one initial implementation `SqliteProfileMemory` backed by `better-sqlite3`. The agent registers three local tools (alongside MCP-provided tools) that delegate to the memory adapter. The system prompt is rebuilt per turn with current profile values injected.

**Tech Stack:** `better-sqlite3` (prebuilt for macOS x64/arm64 and Linux arm64), TypeScript, Vitest.

**Prerequisite:** Iteration 2 complete (`OpenAiAgent` exists).

---

## File Structure

```
src/
├── memory/
│   ├── types.ts                 # MemoryAdapter interface + facts type
│   ├── migrations.ts            # SQL migrations as TS constants (no .sql on disk)
│   ├── migrate.ts               # apply migrations on startup
│   └── sqliteProfileMemory.ts   # better-sqlite3 implementation
├── agent/
│   ├── memoryTools.ts           # remember/recall/forget as OpenAI tools
│   └── openaiAgent.ts           # MODIFIED: accept local tool registry
└── cli/
    └── chat.ts                  # MODIFIED: wire memory in
tests/
└── memory/
    ├── sqliteProfileMemory.test.ts
    └── migrate.test.ts
data/                            # gitignored, created at runtime
```

---

## Task 1: Install + gitignore + types

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `src/memory/types.ts`

- [x] **Step 1: Install**

```bash
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

- [x] **Step 2: Update `.gitignore`**

Append:

```
# Runtime data
data/
*.db
*.db-journal
*.db-wal
*.db-shm
```

- [x] **Step 3: Create `src/memory/types.ts`**

```ts
export type ProfileFacts = Record<string, unknown>;

export interface MemoryAdapter {
  remember(key: string, value: unknown): void;
  recall(key?: string): ProfileFacts;
  forget(key: string): void;
  close(): void;
}
```

- [x] **Step 4: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [x] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore src/memory/types.ts
git commit -m "chore(memory): install better-sqlite3 and add MemoryAdapter interface"
```

---

## Task 2: Migration runner

**Files:**
- Create: `src/memory/migrations.ts` (SQL embedded as TS string constants)
- Create: `src/memory/migrate.ts`
- Test: `tests/memory/migrate.test.ts`

**Why no `.sql` files:** `tsc` does not copy non-TS files into `dist/`, so a `.sql`-on-disk approach silently breaks the production build on the Pi (`readdirSync` ENOENT). Embedding the SQL as TS string literals avoids the entire build-copy problem; SQL is small and rarely changes.

- [x] **Step 1: Create `src/memory/migrations.ts`**

```ts
export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS profile (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO schema_version (version) VALUES (1);
    `,
  },
];
```

- [x] **Step 2: Write failing test**

`tests/memory/migrate.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.js';

describe('runMigrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  it('creates profile and schema_version tables', () => {
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('profile');
    expect(names).toContain('schema_version');
  });

  it('records version 1', () => {
    runMigrations(db);
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(1);
  });

  it('is idempotent', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
```

- [x] **Step 3: Verify failure**

```bash
npx vitest run tests/memory/migrate.test.ts
```

Expected: FAIL — module not found.

- [x] **Step 4: Implement `src/memory/migrate.ts`**

```ts
import type Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

export function runMigrations(db: Database.Database): void {
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    db.exec(m.sql);
  }
}
```

No filesystem access — works identically under `tsx` (dev) and compiled `node dist/...` (prod).

- [x] **Step 5: Run tests**

```bash
npx vitest run tests/memory/migrate.test.ts
```

Expected: 3 passed.

- [x] **Step 6: Commit**

```bash
git add src/memory/migrate.ts src/memory/migrations.ts tests/memory/migrate.test.ts
git commit -m "feat(memory): add SQLite migration runner with profile schema"
```

---

## Task 3: SqliteProfileMemory implementation

**Files:**
- Create: `src/memory/sqliteProfileMemory.ts`
- Test: `tests/memory/sqliteProfileMemory.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/memory/sqliteProfileMemory.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.js';

describe('SqliteProfileMemory', () => {
  let m: SqliteProfileMemory;

  beforeEach(() => {
    m = new SqliteProfileMemory({ dbPath: ':memory:' });
  });
  afterEach(() => m.close());

  it('starts empty', () => {
    expect(m.recall()).toEqual({});
  });

  it('remember + recall by key', () => {
    m.remember('name', 'Maxim');
    expect(m.recall('name')).toEqual({ name: 'Maxim' });
  });

  it('remember overwrites existing key', () => {
    m.remember('temp', 22);
    m.remember('temp', 21);
    expect(m.recall('temp')).toEqual({ temp: 21 });
  });

  it('recall() with no key returns full profile', () => {
    m.remember('name', 'Maxim');
    m.remember('coffee', { sugar: false });
    expect(m.recall()).toEqual({ name: 'Maxim', coffee: { sugar: false } });
  });

  it('forget removes a key', () => {
    m.remember('name', 'Maxim');
    m.forget('name');
    expect(m.recall()).toEqual({});
  });

  it('forget on missing key is a no-op', () => {
    expect(() => m.forget('nope')).not.toThrow();
  });

  it('handles non-string values via JSON', () => {
    m.remember('list', [1, 2, 3]);
    m.remember('flag', true);
    expect(m.recall()).toEqual({ list: [1, 2, 3], flag: true });
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
npx vitest run tests/memory/sqliteProfileMemory.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `src/memory/sqliteProfileMemory.ts`**

```ts
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';
import type { MemoryAdapter, ProfileFacts } from './types.js';

export interface SqliteProfileMemoryOptions {
  dbPath: string;
}

export class SqliteProfileMemory implements MemoryAdapter {
  private readonly db: Database.Database;

  constructor(opts: SqliteProfileMemoryOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    runMigrations(this.db);
  }

  remember(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO profile (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  recall(key?: string): ProfileFacts {
    if (key !== undefined) {
      const row = this.db.prepare('SELECT value FROM profile WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      if (!row) return {};
      return { [key]: JSON.parse(row.value) };
    }
    const rows = this.db.prepare('SELECT key, value FROM profile').all() as Array<{
      key: string;
      value: string;
    }>;
    const out: ProfileFacts = {};
    for (const r of rows) out[r.key] = JSON.parse(r.value);
    return out;
  }

  forget(key: string): void {
    this.db.prepare('DELETE FROM profile WHERE key = ?').run(key);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/memory/sqliteProfileMemory.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/memory/sqliteProfileMemory.ts tests/memory/sqliteProfileMemory.test.ts
git commit -m "feat(memory): add SqliteProfileMemory adapter"
```

---

## Task 4: Memory tools for the agent

**Files:**
- Create: `src/agent/memoryTools.ts`
- Test: `tests/agent/memoryTools.test.ts`

These are the `remember` / `recall` / `forget` tools the LLM can call. They look like OpenAI function tools but execute against the local `MemoryAdapter` instead of going through MCP.

- [ ] **Step 1: Write failing tests**

`tests/agent/memoryTools.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildMemoryTools, executeMemoryTool } from '../../src/agent/memoryTools.js';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.js';

describe('memoryTools', () => {
  it('exposes three function tools with sensible names', () => {
    const tools = buildMemoryTools();
    const names = tools.map((t) => t.function.name);
    expect(names).toEqual(['remember', 'recall', 'forget']);
  });

  it('executeMemoryTool routes calls', () => {
    const m = new SqliteProfileMemory({ dbPath: ':memory:' });
    try {
      executeMemoryTool(m, 'remember', { key: 'name', value: 'Maxim' });
      const out = executeMemoryTool(m, 'recall', {});
      expect(out).toEqual({ name: 'Maxim' });
      executeMemoryTool(m, 'forget', { key: 'name' });
      expect(executeMemoryTool(m, 'recall', {})).toEqual({});
    } finally {
      m.close();
    }
  });

  it('throws on unknown tool', () => {
    const m = new SqliteProfileMemory({ dbPath: ':memory:' });
    try {
      expect(() => executeMemoryTool(m, 'does_not_exist', {})).toThrow();
    } finally {
      m.close();
    }
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
npx vitest run tests/agent/memoryTools.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `src/agent/memoryTools.ts`**

```ts
import type { MemoryAdapter } from '../memory/types.js';
import type { OpenAiFunctionTool } from './toolBridge.js';

export const MEMORY_TOOL_NAMES = new Set(['remember', 'recall', 'forget']);

export function buildMemoryTools(): OpenAiFunctionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'remember',
        description:
          'Persist a fact about the user across sessions. Call when the user shares a preference or fact you should remember.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Short snake_case identifier, e.g. "name", "comfort_temp"' },
            value: { description: 'Any JSON-serializable value' },
          },
          required: ['key', 'value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recall',
        description: 'Read user profile. Omit "key" to get the full profile.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'forget',
        description: 'Delete a profile entry by key.',
        parameters: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
        },
      },
    },
  ];
}

export function executeMemoryTool(
  memory: MemoryAdapter,
  name: string,
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case 'remember':
      memory.remember(String(args.key), args.value);
      return { ok: true };
    case 'recall':
      return memory.recall(args.key as string | undefined);
    case 'forget':
      memory.forget(String(args.key));
      return { ok: true };
    default:
      throw new Error(`Unknown memory tool: ${name}`);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/agent/memoryTools.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/agent/memoryTools.ts tests/agent/memoryTools.test.ts
git commit -m "feat(memory): add remember/recall/forget tools for the agent"
```

---

## Task 5: Wire memory into the agent

**Files:**
- Modify: `src/agent/openaiAgent.ts`
- Modify: `tests/agent/openaiAgent.test.ts` (one new test)

Goal: agent accepts an optional `MemoryAdapter`, merges memory tools with MCP tools, and routes tool calls to either MCP or memory based on tool name. Profile content is appended to system prompt at the start of each turn.

- [ ] **Step 1: Add a test for memory tool routing**

Append to `tests/agent/openaiAgent.test.ts`:

```ts
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.js';

it('routes memory-tool calls to MemoryAdapter, not MCP', async () => {
  const mcp = fakeMcp();
  const memory = new SqliteProfileMemory({ dbPath: ':memory:' });
  const llm = fakeLlm([
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'mem_1',
                type: 'function',
                function: {
                  name: 'remember',
                  arguments: '{"key":"name","value":"Maxim"}',
                },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [{ message: { role: 'assistant', content: 'Got it.' } }],
    },
  ]);
  const agent = new OpenAiAgent({
    mcp,
    memory,
    store: new ConversationStore({ idleTimeoutMs: 60_000, maxMessages: 20 }),
    systemPrompt: 'You are helpful.',
    model: 'gpt-4o',
    llmClient: llm as never,
  });
  const res = await agent.respond('меня зовут Максим');
  expect(res.text).toBe('Got it.');
  expect(memory.recall()).toEqual({ name: 'Maxim' });
  expect(mcp.callTool).not.toHaveBeenCalled();
  memory.close();
});
```

- [ ] **Step 2: Verify failure**

```bash
npx vitest run tests/agent/openaiAgent.test.ts
```

Expected: FAIL — `OpenAiAgentOptions` does not accept `memory`.

- [ ] **Step 3a: Add `replaceSystem` to `ConversationStore`**

In `src/agent/conversationStore.ts`, add this method to the class:

```ts
replaceSystem(content: string): void {
  if (this.messages.length > 0 && this.messages[0].role === 'system') {
    this.messages[0] = { role: 'system', content };
  } else {
    this.messages.unshift({ role: 'system', content });
    this.lastTouch = this.opts.now();
  }
}
```

This avoids the issue that `history()` returns a copy — the agent cannot mutate it directly.

- [ ] **Step 3b: Replace `src/agent/openaiAgent.ts` with the final version**

Overwrite the file completely. This supersedes the version produced in Iteration 2 Task 4 — the Iteration 2 version did the system-prompt seeding in the constructor; this version moves it into `respond()` so it can refresh from current memory state on every turn.

```ts
import type OpenAI from 'openai';
import type { Agent, AgentResponse, Message } from './types.js';
import type { McpClient } from '../mcp/types.js';
import type { MemoryAdapter } from '../memory/types.js';
import { ConversationStore } from './conversationStore.js';
import { mcpToolsToOpenAi } from './toolBridge.js';
import { MEMORY_TOOL_NAMES, buildMemoryTools, executeMemoryTool } from './memoryTools.js';

export interface OpenAiAgentOptions {
  mcp: McpClient;
  store: ConversationStore;
  systemPrompt: string;
  model: string;
  maxToolIterations?: number;
  llmClient: OpenAI;
  memory?: MemoryAdapter;
}

export class OpenAiAgent implements Agent {
  private readonly maxIters: number;

  constructor(private readonly opts: OpenAiAgentOptions) {
    this.maxIters = opts.maxToolIterations ?? 5;
  }

  async respond(userText: string): Promise<AgentResponse> {
    const { mcp, store, model, llmClient } = this.opts;

    store.replaceSystem(this.buildSystemMessage());
    store.append({ role: 'user', content: userText });

    const mcpTools = mcpToolsToOpenAi(await mcp.listTools());
    const tools = this.opts.memory ? [...mcpTools, ...buildMemoryTools()] : mcpTools;

    for (let i = 0; i < this.maxIters; i++) {
      const completion = await llmClient.chat.completions.create({
        model,
        messages: this.toOpenAi(store.history()),
        tools: tools.length > 0 ? tools : undefined,
      });
      const choice = completion.choices[0].message;

      if (choice.tool_calls && choice.tool_calls.length > 0) {
        store.append({
          role: 'assistant',
          content: choice.content ?? '',
          toolCalls: choice.tool_calls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: this.parseArgs(tc.function.arguments),
          })),
        });
        for (const tc of choice.tool_calls) {
          const args = this.parseArgs(tc.function.arguments);
          let resultText: string;
          let isError = false;
          if (MEMORY_TOOL_NAMES.has(tc.function.name) && this.opts.memory) {
            try {
              const r = executeMemoryTool(this.opts.memory, tc.function.name, args);
              resultText = JSON.stringify(r);
            } catch (e) {
              resultText = e instanceof Error ? e.message : String(e);
              isError = true;
            }
          } else {
            const result = await mcp.callTool(tc.function.name, args);
            resultText = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
            isError = result.isError;
          }
          store.append({
            role: 'tool',
            toolCallId: tc.id,
            content: isError ? `ERROR: ${resultText}` : resultText,
          });
        }
        continue;
      }

      const finalText = choice.content ?? '';
      store.append({ role: 'assistant', content: finalText });
      return { text: finalText };
    }

    throw new Error('Agent exceeded max tool iterations');
  }

  private buildSystemMessage(): string {
    const base = this.opts.systemPrompt;
    if (!this.opts.memory) return base;
    const profile = this.opts.memory.recall();
    if (Object.keys(profile).length === 0) return base;
    return `${base}\n\nKnown user profile: ${JSON.stringify(profile)}`;
  }

  private parseArgs(raw: string | undefined): Record<string, unknown> {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }

  private toOpenAi(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId!, content: m.content };
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }
      return { role: m.role, content: m.content } as OpenAI.ChatCompletionMessageParam;
    });
  }
}
```

- [ ] **Step 3c: Update Iteration 2 tests that depended on constructor-seeded system prompt**

The Iteration 2 test "returns assistant text when no tool calls" was written when the constructor seeded the system message. After this rewrite the system message is appended on the first `respond()` call. Existing assertions (`res.text === 'Hi there'`, `create` called once) still hold — this test should keep passing without changes. If it doesn't, run it and inspect what changed; the most likely fix is that the LLM now sees a slightly different message list, but the LLM is mocked and ignores the messages, so the assertion outcome is unaffected.

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

Expected: all pass, including the new memory-routing test and the updated existing ones. If existing test "returns assistant text when no tool calls" fails because it expected the constructor to seed system, fix the assertion to inspect history *after* `respond()` is called.

- [ ] **Step 5: Commit**

```bash
git add src/agent/openaiAgent.ts src/agent/conversationStore.ts tests/agent/openaiAgent.test.ts
git commit -m "feat(agent): route memory tools to MemoryAdapter, inject profile into system prompt"
```

---

## Task 6: Wire memory into the chat CLI

**Files:**
- Modify: `src/cli/chat.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Add `memoryDbPath` to config**

In `src/config.ts`, extend the schema:

```ts
const ConfigSchema = z.object({
  ha: z.object({ url: z.string().url(), token: z.string().min(1) }),
  openai: z.object({
    apiKey: z.string().min(1),
    model: z.string().default('gpt-4o'),
  }),
  memory: z.object({
    dbPath: z.string().default('data/assistant.db'),
  }),
});
```

And `raw`:

```ts
memory: { dbPath: process.env.MEMORY_DB_PATH },
```

Append to `.env.example`:

```
# Memory
MEMORY_DB_PATH=data/assistant.db
```

- [ ] **Step 2: Update `src/cli/chat.ts`**

Replace the body of `main()`:

```ts
async function main(): Promise<void> {
  const cfg = loadConfig();
  fs.mkdirSync(path.dirname(cfg.memory.dbPath), { recursive: true });
  const llm = new OpenAI({ apiKey: cfg.openai.apiKey });
  const mcp = new HaMcpClient({ url: cfg.ha.url, token: cfg.ha.token });
  const memory = new SqliteProfileMemory({ dbPath: cfg.memory.dbPath });
  await mcp.connect();
  const store = new ConversationStore({ idleTimeoutMs: 3 * 60 * 1000, maxMessages: 20 });
  const agent = new OpenAiAgent({
    mcp,
    memory,
    store,
    systemPrompt: SYSTEM_PROMPT,
    model: cfg.openai.model,
    llmClient: llm,
  });

  const rl = readline.createInterface({ input, output });
  console.log('Chat ready. /reset to clear context. /profile to dump profile. Ctrl+C to exit.');

  try {
    while (true) {
      const line = (await rl.question('> ')).trim();
      if (!line) continue;
      if (line === '/reset') { store.reset(); console.log('(context cleared)'); continue; }
      if (line === '/profile') { console.log(JSON.stringify(memory.recall(), null, 2)); continue; }
      try {
        const res = await agent.respond(line);
        console.log(res.text);
      } catch (err) {
        console.error('Agent error:', err instanceof Error ? err.message : err);
      }
    }
  } finally {
    rl.close();
    await mcp.disconnect();
    memory.close();
  }
}
```

Add imports at the top:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SqliteProfileMemory } from '../memory/sqliteProfileMemory.js';
```

Tighten `SYSTEM_PROMPT` to mention memory:

```ts
const SYSTEM_PROMPT = `You are a smart-home voice assistant for the user's home.
You control devices through Home Assistant tools.
You have a long-term user profile via remember/recall/forget tools — use them to persist
useful preferences (name, comfort temperature, routines). Do NOT remember sensitive data.
Be concise: under 2 sentences when possible. Speak Russian if the user does.`;
```

- [ ] **Step 3: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Manual smoke test**

```bash
npm run chat
```

Try:
```
> меня зовут Максим
(expected: agent calls remember and confirms)
> /profile
{ "name": "Максим" }
```

Restart `npm run chat`:
```
> как меня зовут?
(expected: "Максим" — recalled from SQLite even after restart)
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/chat.ts src/config.ts .env.example
git commit -m "feat(cli): wire SqliteProfileMemory into chat REPL"
```

---

## Definition of done

- All unit tests pass.
- After running `npm run chat` and saying "меня зовут Максим", `data/assistant.db` exists and contains the entry.
- After restarting the REPL, the assistant correctly answers "как меня зовут?" using the persisted profile.
- `/profile` prints current profile as JSON.
