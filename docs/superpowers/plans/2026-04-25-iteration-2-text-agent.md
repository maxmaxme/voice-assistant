# Iteration 2: Text Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A text REPL where the user types a command in natural language and the agent uses Claude/GPT with tool-calling via MCP to control Home Assistant. No voice, no memory yet — just the LLM-driven brain.

**Architecture:** `Agent` interface owns the tool-loop. The OpenAI implementation pulls MCP tools from the `McpClient`, exposes them to the LLM as functions, runs the tool-calling loop until the model returns a final assistant message, and returns it. A `ConversationStore` keeps short-term history with a 3-minute idle timeout.

**Tech Stack:** OpenAI SDK (`gpt-4o`), `@modelcontextprotocol/sdk` (already added in Iteration 1), TypeScript, Vitest.

**Prerequisite:** Iteration 1 complete. `HaMcpClient` and `npm run mcp:call` work.

---

## File Structure

```
src/
├── agent/
│   ├── types.ts                 # Agent interface, Message, ToolCall
│   ├── conversationStore.ts     # in-memory history with timeout
│   ├── toolBridge.ts            # convert McpTool[] ↔ OpenAI tools
│   └── openaiAgent.ts           # Agent impl using OpenAI SDK
└── cli/
    └── chat.ts                  # REPL entry
tests/
└── agent/
    ├── conversationStore.test.ts
    ├── toolBridge.test.ts
    └── openaiAgent.test.ts      # uses fake LLM client + fake McpClient
```

---

## Task 1: Install OpenAI SDK + extend config

**Files:**
- Modify: `package.json`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Install**

```bash
npm install openai
```

- [ ] **Step 2: Update `tests/config.test.ts` — add OpenAI key check**

Append to existing test file inside the `describe('loadConfig')` block:

```ts
  it('reads openai api key', () => {
    process.env.HA_URL = 'http://localhost:8123';
    process.env.HA_TOKEN = 'tok_abc';
    process.env.OPENAI_API_KEY = 'sk-xxx';
    const cfg = loadConfig();
    expect(cfg.openai.apiKey).toBe('sk-xxx');
  });

  it('throws when OPENAI_API_KEY is missing', () => {
    process.env.HA_URL = 'http://localhost:8123';
    process.env.HA_TOKEN = 'tok_abc';
    delete process.env.OPENAI_API_KEY;
    expect(() => loadConfig()).toThrow(/openai/i);
  });
```

Add `delete process.env.OPENAI_API_KEY;` to `beforeEach`.

- [ ] **Step 3: Run tests to verify failure**

```bash
npx vitest run tests/config.test.ts
```

Expected: 2 new tests fail (no `cfg.openai`).

- [ ] **Step 4: Update `src/config.ts`**

Replace the `ConfigSchema` block:

```ts
const ConfigSchema = z.object({
  ha: z.object({
    url: z.string().url(),
    token: z.string().min(1),
  }),
  openai: z.object({
    apiKey: z.string().min(1),
    model: z.string().default('gpt-4o'),
  }),
});
```

And the `raw` object inside `loadConfig()`:

```ts
const raw = {
  ha: {
    url: process.env.HA_URL,
    token: process.env.HA_TOKEN,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
  },
};
```

- [ ] **Step 5: Update `.env.example`**

Append:

```
# OpenAI
OPENAI_API_KEY=sk-replace-me
OPENAI_MODEL=gpt-4o
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run tests/config.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/config.ts tests/config.test.ts .env.example
git commit -m "feat(config): add OpenAI configuration"
```

---

## Task 2: Conversation store with idle timeout

**Files:**
- Create: `src/agent/types.ts`
- Create: `src/agent/conversationStore.ts`
- Test: `tests/agent/conversationStore.test.ts`

- [ ] **Step 1: Define types**

`src/agent/types.ts`:

```ts
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

export interface AgentResponse {
  text: string;
}

export interface Agent {
  respond(userText: string): Promise<AgentResponse>;
}
```

- [ ] **Step 2: Write failing tests**

`tests/agent/conversationStore.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConversationStore } from '../../src/agent/conversationStore.js';

describe('ConversationStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stores and returns messages', () => {
    const s = new ConversationStore({ idleTimeoutMs: 60_000, maxMessages: 20 });
    s.append({ role: 'user', content: 'hi' });
    s.append({ role: 'assistant', content: 'hello' });
    expect(s.history()).toHaveLength(2);
  });

  it('clears history after idle timeout since last append', () => {
    const s = new ConversationStore({ idleTimeoutMs: 1000, maxMessages: 20 });
    s.append({ role: 'user', content: 'hi' });
    vi.advanceTimersByTime(500);
    s.append({ role: 'assistant', content: 'hello' });
    vi.advanceTimersByTime(1001);
    expect(s.history()).toHaveLength(0);
  });

  it('does not clear when accessed within timeout', () => {
    const s = new ConversationStore({ idleTimeoutMs: 1000, maxMessages: 20 });
    s.append({ role: 'user', content: 'hi' });
    vi.advanceTimersByTime(999);
    expect(s.history()).toHaveLength(1);
  });

  it('trims oldest non-system messages over maxMessages', () => {
    const s = new ConversationStore({ idleTimeoutMs: 60_000, maxMessages: 3 });
    s.append({ role: 'system', content: 'sys' });
    s.append({ role: 'user', content: 'm1' });
    s.append({ role: 'user', content: 'm2' });
    s.append({ role: 'user', content: 'm3' });
    s.append({ role: 'user', content: 'm4' });
    const h = s.history();
    expect(h[0].content).toBe('sys');
    expect(h.map((m) => m.content)).toEqual(['sys', 'm3', 'm4']);
  });

  it('reset() clears immediately', () => {
    const s = new ConversationStore({ idleTimeoutMs: 60_000, maxMessages: 20 });
    s.append({ role: 'user', content: 'hi' });
    s.reset();
    expect(s.history()).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Verify failure**

```bash
npx vitest run tests/agent/conversationStore.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/agent/conversationStore.ts`**

```ts
import type { Message } from './types.js';

export interface ConversationStoreOptions {
  idleTimeoutMs: number;
  maxMessages: number;
  now?: () => number;
}

export class ConversationStore {
  private messages: Message[] = [];
  private lastTouch = 0;
  private readonly opts: Required<ConversationStoreOptions>;

  constructor(opts: ConversationStoreOptions) {
    this.opts = { now: () => Date.now(), ...opts };
  }

  append(msg: Message): void {
    this.evictIfStale();
    this.messages.push(msg);
    this.lastTouch = this.opts.now();
    this.trim();
  }

  history(): Message[] {
    this.evictIfStale();
    return [...this.messages];
  }

  reset(): void {
    this.messages = [];
    this.lastTouch = 0;
  }

  private evictIfStale(): void {
    if (this.lastTouch === 0) return;
    if (this.opts.now() - this.lastTouch >= this.opts.idleTimeoutMs) {
      this.messages = [];
      this.lastTouch = 0;
    }
  }

  private trim(): void {
    if (this.messages.length <= this.opts.maxMessages) return;
    const system = this.messages.filter((m) => m.role === 'system');
    const rest = this.messages.filter((m) => m.role !== 'system');
    const keepRest = rest.slice(-(this.opts.maxMessages - system.length));
    this.messages = [...system, ...keepRest];
  }
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/agent/conversationStore.test.ts
```

Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add src/agent/types.ts src/agent/conversationStore.ts tests/agent/conversationStore.test.ts
git commit -m "feat(agent): add conversation store with idle timeout and trim"
```

---

## Task 3: Tool bridge — convert MCP tools ↔ OpenAI tools

**Files:**
- Create: `src/agent/toolBridge.ts`
- Test: `tests/agent/toolBridge.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/agent/toolBridge.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mcpToolsToOpenAi } from '../../src/agent/toolBridge.js';
import type { McpTool } from '../../src/mcp/types.js';

describe('mcpToolsToOpenAi', () => {
  it('maps name, description, and inputSchema to OpenAI function format', () => {
    const mcp: McpTool[] = [
      {
        name: 'HassTurnOn',
        description: 'Turn on a device',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
    ];
    const out = mcpToolsToOpenAi(mcp);
    expect(out).toEqual([
      {
        type: 'function',
        function: {
          name: 'HassTurnOn',
          description: 'Turn on a device',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      },
    ]);
  });

  it('handles empty list', () => {
    expect(mcpToolsToOpenAi([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
npx vitest run tests/agent/toolBridge.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent/toolBridge.ts`**

```ts
import type { McpTool } from '../mcp/types.js';

export interface OpenAiFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function mcpToolsToOpenAi(tools: McpTool[]): OpenAiFunctionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/agent/toolBridge.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/agent/toolBridge.ts tests/agent/toolBridge.test.ts
git commit -m "feat(agent): add MCP→OpenAI tool format bridge"
```

---

## Task 4: OpenAI agent — tool-calling loop

**Files:**
- Create: `src/agent/openaiAgent.ts`
- Test: `tests/agent/openaiAgent.test.ts`

The agent runs a loop: send messages to LLM → if LLM returns tool_calls, execute via McpClient, append results, loop → otherwise return assistant text. Max iterations protects against infinite loops.

- [ ] **Step 1: Write failing tests**

`tests/agent/openaiAgent.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { OpenAiAgent } from '../../src/agent/openaiAgent.js';
import { ConversationStore } from '../../src/agent/conversationStore.js';
import type { McpClient } from '../../src/mcp/types.js';

function fakeMcp(): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([
      {
        name: 'HassTurnOn',
        description: 'Turn on',
        inputSchema: { type: 'object' },
      },
    ]),
    callTool: vi.fn().mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    }),
  };
}

function fakeLlm(scripted: Array<unknown>) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async () => scripted[i++]),
      },
    },
  };
}

describe('OpenAiAgent', () => {
  it('returns assistant text when no tool calls', async () => {
    const llm = fakeLlm([
      {
        choices: [{ message: { role: 'assistant', content: 'Hi there' } }],
      },
    ]);
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      store: new ConversationStore({ idleTimeoutMs: 60_000, maxMessages: 20 }),
      systemPrompt: 'You are helpful.',
      model: 'gpt-4o',
      llmClient: llm as never,
    });
    const res = await agent.respond('hello');
    expect(res.text).toBe('Hi there');
    expect(llm.chat.completions.create).toHaveBeenCalledOnce();
  });

  it('runs tool-call loop and returns final text', async () => {
    const mcp = fakeMcp();
    const llm = fakeLlm([
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'HassTurnOn',
                    arguments: '{"name":"Test Lamp"}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ message: { role: 'assistant', content: 'Lamp is on.' } }],
      },
    ]);
    const agent = new OpenAiAgent({
      mcp,
      store: new ConversationStore({ idleTimeoutMs: 60_000, maxMessages: 20 }),
      systemPrompt: 'You are helpful.',
      model: 'gpt-4o',
      llmClient: llm as never,
    });
    const res = await agent.respond('turn on the lamp');
    expect(res.text).toBe('Lamp is on.');
    expect(mcp.callTool).toHaveBeenCalledWith('HassTurnOn', { name: 'Test Lamp' });
  });

  it('throws after max iterations to avoid infinite tool-loops', async () => {
    const looping = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'c',
                type: 'function',
                function: { name: 'HassTurnOn', arguments: '{}' },
              },
            ],
          },
        },
      ],
    };
    const llm = fakeLlm([looping, looping, looping, looping, looping, looping]);
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      store: new ConversationStore({ idleTimeoutMs: 60_000, maxMessages: 20 }),
      systemPrompt: 's',
      model: 'gpt-4o',
      maxToolIterations: 3,
      llmClient: llm as never,
    });
    await expect(agent.respond('x')).rejects.toThrow(/max tool iterations/i);
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
npx vitest run tests/agent/openaiAgent.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `src/agent/openaiAgent.ts`**

```ts
import type OpenAI from 'openai';
import type { Agent, AgentResponse, Message } from './types.js';
import type { McpClient } from '../mcp/types.js';
import { ConversationStore } from './conversationStore.js';
import { mcpToolsToOpenAi } from './toolBridge.js';

export interface OpenAiAgentOptions {
  mcp: McpClient;
  store: ConversationStore;
  systemPrompt: string;
  model: string;
  maxToolIterations?: number;
  llmClient: OpenAI;
}

export class OpenAiAgent implements Agent {
  private readonly maxIters: number;

  constructor(private readonly opts: OpenAiAgentOptions) {
    this.maxIters = opts.maxToolIterations ?? 5;
    if (opts.store.history().length === 0) {
      opts.store.append({ role: 'system', content: opts.systemPrompt });
    }
  }

  async respond(userText: string): Promise<AgentResponse> {
    const { mcp, store, model, llmClient } = this.opts;
    store.append({ role: 'user', content: userText });

    const tools = mcpToolsToOpenAi(await mcp.listTools());

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
            arguments: JSON.parse(tc.function.arguments || '{}'),
          })),
        });
        for (const tc of choice.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }
          const result = await mcp.callTool(tc.function.name, args);
          const text = result.content
            .map((c) => (c.type === 'text' ? c.text : ''))
            .join('\n');
          store.append({
            role: 'tool',
            toolCallId: tc.id,
            content: result.isError ? `ERROR: ${text}` : text,
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

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/agent/openaiAgent.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/agent/openaiAgent.ts tests/agent/openaiAgent.test.ts
git commit -m "feat(agent): add OpenAI agent with MCP tool-calling loop"
```

---

## Task 5: REPL CLI

**Files:**
- Create: `src/cli/chat.ts`
- Modify: `package.json` (add script)

- [ ] **Step 1: Implement `src/cli/chat.ts`**

```ts
import OpenAI from 'openai';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../config.js';
import { HaMcpClient } from '../mcp/haMcpClient.js';
import { OpenAiAgent } from '../agent/openaiAgent.js';
import { ConversationStore } from '../agent/conversationStore.js';

const SYSTEM_PROMPT = `You are a smart-home voice assistant for the user's home.
You control devices through Home Assistant tools available to you.
Be concise: under 2 sentences when possible. Speak Russian if the user does.
If a tool fails, explain briefly. Do not invent device names — list tools first if unsure.`;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const llm = new OpenAI({ apiKey: cfg.openai.apiKey });
  const mcp = new HaMcpClient({ url: cfg.ha.url, token: cfg.ha.token });
  await mcp.connect();
  const store = new ConversationStore({ idleTimeoutMs: 3 * 60 * 1000, maxMessages: 20 });
  const agent = new OpenAiAgent({
    mcp,
    store,
    systemPrompt: SYSTEM_PROMPT,
    model: cfg.openai.model,
    llmClient: llm,
  });

  const rl = readline.createInterface({ input, output });
  console.log('Chat ready. Type your command. Ctrl+C to exit. /reset to clear context.');

  try {
    while (true) {
      const line = (await rl.question('> ')).trim();
      if (!line) continue;
      if (line === '/reset') {
        store.reset();
        console.log('(context cleared)');
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
    await mcp.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add script to `package.json`**

In `scripts`, add:

```json
"chat": "tsx src/cli/chat.ts",
```

- [ ] **Step 3: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Manual smoke test**

Prerequisites: HA running, `.env` filled (including `OPENAI_API_KEY`).

```bash
npm run chat
```

Try:
```
> включи лампу
(expected: turns on Test Lamp, agent confirms)
> а теперь выключи
(expected: agent uses context to know "lamp" = Test Lamp)
> /reset
> что ты включил минуту назад?
(expected: agent says it doesn't remember)
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/chat.ts package.json
git commit -m "feat(cli): add interactive text chat REPL"
```

---

## Definition of done for Iteration 2

- All unit tests pass: `npm test` exits 0.
- `npm run chat` starts a REPL that controls Test Lamp via natural-language commands.
- Follow-up references work: «включи лампу» → «а выключи» — second command resolves context correctly.
- After 3 minutes of inactivity, follow-up references stop working (idle timeout).
- `/reset` immediately clears context.

## What's next

After Iteration 2: either Memory Level 1 plan (add long-term profile) or Iteration 3 (voice on macOS). Recommend Memory first — it's small and makes the agent feel personal before bothering with audio.
