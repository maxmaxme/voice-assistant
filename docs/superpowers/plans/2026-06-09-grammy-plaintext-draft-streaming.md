# grammY + Plain-Text Output + Telegram Draft Streaming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream the agent's reply into Telegram in real time via Bot API `sendMessageDraft`, which requires (a) migrating the Telegram layer from the dead `telegraf` package to `grammY`, and (b) dropping the legacy `{"speak": ...}` structured output so text deltas stream as-is.

**Architecture:** Three independent phases, each leaving the app working. Phase 1 swaps `telegraf` → `grammy` behind the existing adapter interfaces (`TelegramSender`, `TelegramReceiver`, transcriber/photo-loader). Phase 2 removes the Responses-API structured output (`AGENT_TEXT_FORMAT` / `text-format-addendum.md`) — the JSON wrapper's only payload field is `speak`; the `direction` field it was built for was removed in `06d02a9`. Phase 3 adds an `onTextDelta` callback to `OpenAiAgent.respond()` (streaming Responses API) and a throttled `DraftStreamer` in the Telegram runner: empty draft = "Thinking…" placeholder while tools run, accumulated text deltas ≤1/s, final `sendMessage` persists the reply (drafts are ephemeral 30-second previews).

**Tech Stack:** Node 24 native TS (`.ts` imports, no param properties), grammY ^1.43 (`@grammyjs/types` covers Bot API 10.0 incl. `sendMessageDraft`), OpenAI Responses API (`responses.create` / `responses.stream`), vitest.

**Repo conventions that bite:** relative imports use `.ts` extensions; NO constructor parameter properties; commit messages without Co-Authored-By trailers; pre-push runs `npm run typecheck && npm test`.

---

## File map

| File                                                                                                           | Phase | Action                                                                      |
| -------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------- |
| `package.json`                                                                                                 | 1     | `telegraf` → `grammy`                                                       |
| `src/telegram/fileLink.ts`                                                                                     | 1     | **Create** — `TelegramFileLinkResolver` (replaces telegraf's `getFileLink`) |
| `src/telegram/telegramSender.ts`                                                                               | 1, 3  | Port to grammY `Api`; later add `sendDraft`                                 |
| `src/telegram/voiceTranscriber.ts`                                                                             | 1     | Inject `TelegramFileLinkResolver` instead of `Pick<Telegram,'getFileLink'>` |
| `src/telegram/photoLoader.ts`                                                                                  | 1     | Same swap                                                                   |
| `src/telegram/grammyReceiver.ts`                                                                               | 1     | **Create** (port of `telegrafReceiver.ts`, then delete old file)            |
| `src/telegram/fromConfig.ts`                                                                                   | 1     | Point at `GrammyReceiver`                                                   |
| `tests/telegram/*`                                                                                             | 1     | Mock `grammy` instead of `telegraf`                                         |
| `src/agent/openaiAgent.ts`                                                                                     | 2, 3  | Plain-text output; streaming branch                                         |
| `src/agent/agentOutput.ts`                                                                                     | 2     | **Delete**                                                                  |
| `src/cli/prompts/text-format-addendum.md`                                                                      | 2     | **Delete**                                                                  |
| `src/cli/prompts/voice-addendum.md`                                                                            | 2     | Reword `speak`-field references                                             |
| `src/cli/shared.ts`                                                                                            | 2     | Drop `TEXT_FORMAT_ADDENDUM` from prompt building                            |
| `tests/agent/openaiAgent.test.ts`, `tests/agent/openaiAgent.scope.test.ts`, `tests/agent/telegramTool.test.ts` | 2     | `output_parsed` → `output_text` mocks                                       |
| `src/agent/types.ts`                                                                                           | 3     | `AgentRespondOptions.onTextDelta`                                           |
| `src/telegram/types.ts`                                                                                        | 3     | Optional `TelegramSender.sendDraft`                                         |
| `src/telegram/draftStreamer.ts`                                                                                | 3     | **Create** — throttled draft updater                                        |
| `src/cli/runners/telegram.ts`                                                                                  | 3     | Wire streamer into text/voice/photo paths                                   |
| `CLAUDE.md`                                                                                                    | 1–3   | Update Telegram / agent-core sections in the same commits                   |

---

## Phase 1 — telegraf → grammY

### Task 1: Swap the dependency

**Files:**

- Modify: `package.json`

- [x] **Step 1: Replace the package**

```bash
cd /Users/mlepekha/Developer/home/voice-assistant
npm uninstall telegraf
npm install grammy@^1.43.0
```

Expected: `telegraf` gone from `package.json` dependencies, `grammy` added. `npm run typecheck` will now FAIL (imports of `'telegraf'` in 4 src files + 1 test) — that's expected; the following tasks fix each file. Do NOT commit yet.

### Task 2: File-link resolver (`getFileLink` replacement)

grammY has no `getFileLink` helper in core; build a tiny adapter over `api.getFile`.

**Files:**

- Create: `src/telegram/fileLink.ts`
- Test: `tests/telegram/fileLink.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/telegram/fileLink.test.ts
import { describe, it, expect, vi } from 'vitest';
import { fileLinkResolver } from '../../src/telegram/fileLink.ts';

describe('fileLinkResolver', () => {
  it('builds a download URL from getFile().file_path', async () => {
    const api = { getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file_42.oga' }) };
    const resolver = fileLinkResolver('TOKEN', api);
    await expect(resolver.getFileLink('abc')).resolves.toBe(
      'https://api.telegram.org/file/botTOKEN/voice/file_42.oga',
    );
    expect(api.getFile).toHaveBeenCalledWith('abc');
  });

  it('throws when file_path is missing', async () => {
    const api = { getFile: vi.fn().mockResolvedValue({}) };
    const resolver = fileLinkResolver('TOKEN', api);
    await expect(resolver.getFileLink('abc')).rejects.toThrow(/file_path/);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram/fileLink.test.ts`
Expected: FAIL — `Cannot find module '../../src/telegram/fileLink.ts'`

- [x] **Step 3: Implement**

```ts
// src/telegram/fileLink.ts
import { Api } from 'grammy';

/** Resolves a Telegram file_id into a direct download URL.
 *  Replaces telegraf's `Telegram.getFileLink`; tests inject a fake `api`. */
export interface TelegramFileLinkResolver {
  getFileLink(fileId: string): Promise<string>;
}

type GetFileApi = Pick<Api, 'getFile'>;

export function fileLinkResolver(botToken: string, api?: GetFileApi): TelegramFileLinkResolver {
  const client: GetFileApi = api ?? new Api(botToken);
  return {
    async getFileLink(fileId: string): Promise<string> {
      const file = await client.getFile(fileId);
      if (!file.file_path) {
        throw new Error(`Telegram getFile(${fileId}) returned no file_path`);
      }
      return `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    },
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/telegram/fileLink.test.ts`
Expected: PASS (2 tests)

### Task 3: Port `BotTelegramSender` to grammY

**Files:**

- Modify: `src/telegram/telegramSender.ts`

- [x] **Step 1: Rewrite the sender**

```ts
// src/telegram/telegramSender.ts — full new content
import { Api } from 'grammy';
import telegramifyMarkdown from 'telegramify-markdown';
import type { TelegramSender } from './types.ts';

export interface BotTelegramSenderOptions {
  botToken: string;
  chatId: string;
  /** Test injection point; production builds its own Api from the token. */
  api?: Api;
}

export class BotTelegramSender implements TelegramSender {
  private readonly api: Api;
  private readonly chatId: string;

  constructor(opts: BotTelegramSenderOptions) {
    this.api = opts.api ?? new Api(opts.botToken);
    this.chatId = opts.chatId;
  }

  async send(text: string): Promise<void> {
    const formatted = telegramifyMarkdown(text, 'escape');
    await this.api.sendMessage(this.chatId, formatted, {
      parse_mode: 'MarkdownV2',
    });
  }
}
```

- [x] **Step 2: Verify no telegraf import remains in the file**

Run: `grep -c telegraf src/telegram/telegramSender.ts`
Expected: `0` (grep exits 1)

### Task 4: Port transcriber and photo loader to the resolver

**Files:**

- Modify: `src/telegram/voiceTranscriber.ts`
- Modify: `src/telegram/photoLoader.ts`
- Modify: `tests/telegram/voiceTranscriber.test.ts`

- [x] **Step 1: Update `voiceTranscriber.ts`**

Replace the telegraf import and the `telegram` option (lines 1, 16–18, 26, 31, 36) so the class consumes `TelegramFileLinkResolver`:

```ts
// imports — replace `import { Telegram } from 'telegraf';` with:
import { fileLinkResolver, type TelegramFileLinkResolver } from './fileLink.ts';
```

```ts
export interface BotVoiceTranscriberOptions {
  botToken: string;
  fetchImpl?: typeof fetch;
  stt: AudioFileStt;
  /** Override the file-link resolver. Tests inject this so they don't need a
   *  real bot token / network. Production builds one from the bot token. */
  links?: TelegramFileLinkResolver;
}
```

```ts
// field + constructor + usage
  private readonly links: TelegramFileLinkResolver;

  constructor(opts: BotVoiceTranscriberOptions) {
    this.stt = opts.stt;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.links = opts.links ?? fileLinkResolver(opts.botToken);
  }

  // in transcribe():
    const url = await this.links.getFileLink(fileId);
```

- [x] **Step 2: Update `photoLoader.ts` the same way**

Replace `import { Telegram } from 'telegraf';` with the `fileLink.ts` import; replace the `telegram?: Pick<Telegram, 'getFileLink'>` option with `links?: TelegramFileLinkResolver`; replace the internal field and the `getFileLink` call site identically to Step 1. The URL-extension → MIME logic is untouched (the resolver returns a `string`, and `photoLoader` already parses the extension from the URL string).

- [x] **Step 3: Update `tests/telegram/voiceTranscriber.test.ts`**

The test currently injects `telegram: { getFileLink: ... }` (returning a `URL`). Change the injection to `links: { getFileLink: vi.fn().mockResolvedValue('https://api.telegram.org/file/botX/voice.oga') }` — a plain string. Adjust any assertion that compared against a `URL` object to compare against the string.

- [x] **Step 4: Run the affected tests**

Run: `npx vitest run tests/telegram/`
Expected: voiceTranscriber + fileLink PASS; `telegrafReceiver.test.ts` still FAILS to import `telegraf` — fixed in Task 5.

### Task 5: Port the receiver to grammY

**Files:**

- Create: `src/telegram/grammyReceiver.ts`
- Delete: `src/telegram/telegrafReceiver.ts`
- Modify: `src/telegram/fromConfig.ts`
- Rename+rewrite test: `tests/telegram/telegrafReceiver.test.ts` → `tests/telegram/grammyReceiver.test.ts`

- [x] **Step 1: Rewrite the test against grammY**

`git mv tests/telegram/telegrafReceiver.test.ts tests/telegram/grammyReceiver.test.ts`, then change the mock header and class name; the ctx fixtures (`textCtx`, `voiceCtx`, …) and all assertions stay byte-identical because `classify()` reads `ctx.update`, whose shape is the same `Update` type in both libraries:

```ts
import { GrammyReceiver } from '../../src/telegram/grammyReceiver.ts';

vi.mock('grammy', () => {
  const MockBot = vi.fn(function () {
    let messageHandler: Handler | null = null;
    const bot: FakeBot = {
      on: (_event: string, handler: Handler) => {
        messageHandler = handler;
      },
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      catch: vi.fn(),
      _fire: (ctx: unknown) => {
        messageHandler?.(ctx);
      },
    };
    latestBot = bot;
    return bot;
  });
  return { Bot: MockBot };
});
```

Update the `FakeBot` interface to match (`start`/`stop`/`catch` instead of `launch`/`stop`), and every `new TelegrafReceiver(...)` → `new GrammyReceiver(...)`. Where the old test asserted `bot.launch` was called, assert `bot.start`.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram/grammyReceiver.test.ts`
Expected: FAIL — `Cannot find module '../../src/telegram/grammyReceiver.ts'`

- [x] **Step 3: Create `grammyReceiver.ts`**

Port of `telegrafReceiver.ts` with the same queue machinery. Full content (only the bot-API surface changes; `classify`, `enqueue`, `dequeue`, album-dedup logic are copied verbatim from the old file):

```ts
// src/telegram/grammyReceiver.ts
import { Bot, type Context } from 'grammy';
import type { TelegramReceiver, TelegramMessage } from './types.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('telegram-receiver');

export interface GrammyReceiverOptions {
  botToken: string;
  /** Called after stop() finishes. Use for closing resources tied to the store. */
  onStop?: () => void;
}

export class GrammyReceiver implements TelegramReceiver {
  private readonly bot: Bot;
  private readonly onStop: (() => void) | undefined;
  private readonly pending: TelegramMessage[] = [];
  private readonly resolvers: Array<(value: TelegramMessage | null) => void> = [];
  private stopped = false;
  /** Track media_group_ids we've already replied to with a "rejected" message,
   * so subsequent updates from the same album are silently dropped. */
  private readonly seenAlbumGroups = new Set<string>();

  constructor(opts: GrammyReceiverOptions) {
    this.bot = new Bot(opts.botToken);
    this.onStop = opts.onStop;

    this.bot.on('message', (ctx: Context) => {
      const msg = this.classify(ctx);
      if (msg) {
        this.enqueue(msg);
      }
    });
  }

  // enqueue() and dequeue(): copy verbatim from telegrafReceiver.ts lines 36–52.

  async *messages(): AsyncIterable<TelegramMessage> {
    // bot.start() long-polls; its promise resolves when the bot is stopped and
    // rejects on a fatal polling failure (invalid token, 409 from a duplicate
    // poller). Same crash-hard contract as the telegraf version: a dead polling
    // loop with no log line means the container looks healthy while messages
    // pile up unread.
    this.bot.start({ drop_pending_updates: false }).catch((err: unknown) => {
      if (this.stopped) {
        return;
      }
      log.fatal({ err }, 'telegram long-polling failed — exiting so the container restarts');
      process.exit(1);
    });

    while (!this.stopped) {
      const msg = await this.dequeue();
      if (msg === null || this.stopped) {
        return;
      }
      yield msg;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    await this.bot.stop();
    for (const resolve of this.resolvers) {
      resolve(null);
    }
    this.resolvers.length = 0;
    this.onStop?.();
  }

  // classify(): copy verbatim from telegrafReceiver.ts lines 96–142 —
  // grammY's Context also exposes `ctx.update` with the identical Update shape.
}
```

Then `git rm src/telegram/telegrafReceiver.ts`.

- [x] **Step 4: Update `fromConfig.ts`**

```ts
import type { Config } from '../config.ts';
import { GrammyReceiver } from './grammyReceiver.ts';
import type { TelegramReceiver } from './types.ts';

export function receiverFromConfig(cfg: Config): TelegramReceiver {
  return new GrammyReceiver({ botToken: cfg.telegram.botToken });
}
```

- [x] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/telegram/ && npm run typecheck`
Expected: all telegram tests PASS; typecheck clean (no `telegraf` imports anywhere: verify with `grep -rn "from 'telegraf'" src tests` → no hits).

### Task 6: Phase-1 verification, docs, commit

- [x] **Step 1: Full suite**

Run: `npm run typecheck && npm test && npm run lint`
Expected: all PASS.

- [x] **Step 2: Update CLAUDE.md (Telegram section)**

In `voice-assistant/CLAUDE.md`, Telegram section: replace mentions of telegraf / `PollingTelegramReceiver` / `TelegrafReceiver` with grammY / `GrammyReceiver`; note that file downloads go through `fileLink.ts` (`api.getFile` → direct URL).

- [x] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(telegram): migrate from telegraf to grammY

telegraf's last release was Feb 2024 (Bot API ~7.x) and it no longer
tracks the Bot API. grammY is actively maintained and its types cover
Bot API 10.0 including sendMessageDraft, which the draft-streaming
feature needs. Behavior-preserving: same adapter interfaces, same
long-poll crash-hard contract, same classify() logic."
```

---

## Phase 2 — drop structured output, reply in plain text

### Task 7: Plain-text final replies in `OpenAiAgent`

**Files:**

- Modify: `src/agent/openaiAgent.ts`
- Modify: `tests/agent/openaiAgent.test.ts`, `tests/agent/openaiAgent.scope.test.ts`, `tests/agent/telegramTool.test.ts`

- [x] **Step 1: Update the test mocks to plain text**

In `tests/agent/openaiAgent.test.ts`: the response factory currently builds `{ output_parsed: { speak }, output: [message with JSON text], output_text: '' }`. Change it to produce what the real API returns without a text format:

```ts
// inside the response-factory helper (around line 94):
  return {
    id,
    output,            // message item below
    output_text: speak,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
// and the message output item becomes:
  {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: speak }],
  }
```

Drop `parse: create` aliases — the agent will call `responses.create` directly, so the mock shape `{ responses: { create } }` suffices (keep `parse: create` temporarily if removing it breaks unrelated assertions, then delete after Step 3). In `tests/agent/telegramTool.test.ts:202` replace `output_parsed: { speak: 'Sent.' }` with `output_text: 'Sent.'` plus a matching `message` output item. Apply the same factory change in `openaiAgent.scope.test.ts` if it builds responses itself.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/openaiAgent.test.ts`
Expected: FAIL — agent still looks at `output_parsed`, which is now absent (returns empty text / falls through).

- [x] **Step 3: Rewire `respond()`**

In `src/agent/openaiAgent.ts`:

1. Delete `import { AGENT_TEXT_FORMAT } from './agentOutput.ts';` (line 18).
2. In the API call (line 220): `llmClient.responses.parse(` → `llmClient.responses.create(`, and delete the `text: { format: AGENT_TEXT_FORMAT },` property.
3. Replace the final-reply detection. Current order is: `output_parsed != null` → final; else function calls; else guard. New order — **tool calls first, then any text is final**:

```ts
const fnCalls = (response.output ?? []).filter(
  (it): it is ParsedResponseFunctionToolCall => it.type === 'function_call',
);

if (fnCalls.length === 0) {
  session.commit(response.id);
  const text = stripApiArtifacts(response.output_text ?? '');
  const usage = response.usage;
  log.info(
    {
      elapsedMs: Date.now() - respondStartedAt,
      iterations: i + 1,
      toolsUsed,
      inputTokens: usage?.input_tokens,
      cachedTokens: usage?.input_tokens_details?.cached_tokens,
      outputTokens: usage?.output_tokens,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
    },
    `assistant → ${text}`,
  );
  return { text, toolsUsed };
}

// ... existing fnCalls handling continues unchanged, minus the trailing
// "No tool calls and no parsed output" guard block, which is now the
// fnCalls.length === 0 branch above.
```

The old `output_parsed` block (lines 268–286) and the bottom guard (lines 401–403) are both subsumed.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/`
Expected: PASS.

### Task 8: Remove the format addendum from prompts

**Files:**

- Modify: `src/cli/shared.ts`
- Modify: `src/cli/prompts/voice-addendum.md`
- Delete: `src/agent/agentOutput.ts`, `src/cli/prompts/text-format-addendum.md`

- [x] **Step 1: `shared.ts`**

Delete line 67 (`const TEXT_FORMAT_ADDENDUM = ...`) and both `parts.push(TEXT_FORMAT_ADDENDUM);` calls (lines 75 and 86). Update the `PromptChannel` doc comment (lines 58–63): the `realtime` entry's rationale ("no JSON parsing layer ... `{"speak": ...}`") is obsolete — reword to "Output is spoken DIRECTLY by the Realtime model; uses a lean audio-only addendum instead of the text-channel voice rules."

- [x] **Step 2: Reword `voice-addendum.md`**

The file addresses a `speak` JSON field that no longer exists. Replace field references with "your reply", keeping every rule intact:

- Heading `### HARD RULE — TTS-safe \`speak\` (non-negotiable)`→`### HARD RULE — TTS-safe output (non-negotiable)`
- `The \`speak\` field is read aloud by a TTS engine. Before you emit it, ...`→`Your reply is read aloud by a TTS engine. Before you emit it, ...`
- `**Forbidden in \`speak\` (zero tolerance):**`→`**Forbidden in the reply (zero tolerance):\*\*`
- Heading `### HARD RULE — \`speak\` is final TTS output, not a draft`→`### HARD RULE — the reply is final TTS output, not a draft`
- `\`speak\` is read aloud verbatim. It is the finished utterance, not a scratchpad.`→`Your reply is read aloud verbatim. It is the finished utterance, not a scratchpad.`
- `forbidden tokens anywhere in \`speak\` include`→`forbidden tokens anywhere in the reply include`
- `No language mixing: \`speak\` is entirely in the user's reply language. If the user wrote in Russian, every word in \`speak\` is Russian`→`No language mixing: the reply is entirely in the user's language. If the user wrote in Russian, every word is Russian`
- `No questions to the user inside \`speak\`.`→`No questions to the user inside the reply.`
- `DO NOT append the question to \`speak\`.`→`DO NOT append the question to the reply.`

Run `grep -n 'speak' src/cli/prompts/voice-addendum.md` afterwards — expected: no hits.

- [x] **Step 3: Delete the dead files**

```bash
git rm src/agent/agentOutput.ts src/cli/prompts/text-format-addendum.md
```

Then `grep -rn "agentOutput\|AGENT_TEXT_FORMAT\|text-format-addendum" src tests` — expected: no hits.

- [x] **Step 4: Run typecheck + full tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

### Task 9: Phase-2 docs + commit

- [x] **Step 1: Update CLAUDE.md**

In `voice-assistant/CLAUDE.md`: remove `src/cli/prompts/text-format-addendum.md` from the prompt-layout list (it names it explicitly under "Prompt text lives in markdown files"); fix the `/assist` and agent-core wording if it mentions the JSON output shape ("JSON output shape" appears in the `base-system.md` bullet — verify with `grep -n 'JSON' CLAUDE.md` and reword the hits that describe the removed contract).

- [x] **Step 2: Commit**

```bash
git add -A
git commit -m "refactor(agent): reply in plain text, drop {speak} structured output

The structured-output wrapper existed for the 'direction' field, which
was removed in 06d02a9 — since then the schema carried a single 'speak'
string, costing JSON-skeleton tokens and blocking incremental text
streaming. Final replies now come from response.output_text; the
'no tool calls' condition replaces the output_parsed check."
```

---

## Phase 3 — streaming into Telegram drafts

### Task 10: `onTextDelta` in the agent

**Files:**

- Modify: `src/agent/types.ts`
- Modify: `src/agent/openaiAgent.ts`
- Test: `tests/agent/openaiAgent.test.ts`

- [x] **Step 1: Write the failing test**

Add to `tests/agent/openaiAgent.test.ts`:

```ts
it('streams output text deltas through onTextDelta when provided', async () => {
  const finalResponse = makeTextResponse('resp-1', 'Hello there'); // existing factory
  const stream = {
    on: vi.fn(),
    finalResponse: vi.fn().mockResolvedValue(finalResponse),
  };
  const create = vi.fn();
  const llm = { responses: { create, stream: vi.fn().mockReturnValue(stream) } };
  const agent = buildAgent(llm); // existing helper that wires mcp/memory/session

  const deltas: string[] = [];
  const reply = await agent.respond('hi', { onTextDelta: (d) => deltas.push(d) });

  expect(llm.responses.stream).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
  // simulate what the SDK does: fire the registered delta listener
  const onDelta = stream.on.mock.calls.find(([ev]) => ev === 'response.output_text.delta')?.[1];
  expect(onDelta).toBeDefined();
  onDelta!({ delta: 'Hel' });
  onDelta!({ delta: 'lo' });
  expect(deltas).toEqual(['Hel', 'lo']);
  expect(reply.text).toBe('Hello there');
});
```

(Adapt `makeTextResponse` / `buildAgent` to the file's actual helper names — the factory from Task 7 Step 1 and the existing agent-construction boilerplate at the top of the file.)

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/openaiAgent.test.ts -t 'streams output text deltas'`
Expected: FAIL — `llmClient.responses.stream is not a function` is never called / `onTextDelta` unknown option.

- [x] **Step 3: Implement**

In `src/agent/types.ts`, add to `AgentRespondOptions`:

```ts
  /** Called with each output-text delta as the model generates it. Fires on
   * EVERY tool-loop iteration, including ones that end in tool calls — the
   * caller shows deltas as an ephemeral draft and replaces it with the final
   * text, so stray pre-tool-call text is harmless. */
  onTextDelta?: (delta: string) => void;
```

In `src/agent/openaiAgent.ts`, extract the request params into a local and branch on the callback (replacing the bare `responses.create` call from Task 7):

```ts
const params = {
  model,
  ...(instructions !== undefined && i === 0 ? { instructions } : {}),
  input: nextInput,
  tools: tools.length > 0 ? tools : undefined,
  store: true,
  previous_response_id: previousResponseId,
  context_management: [{ type: 'compaction' as const, compact_threshold: 30_000 }],
  reasoning: { effort: this.opts.reasoningEffort ?? 'low' },
};
if (opts.onTextDelta) {
  const stream = llmClient.responses.stream(params);
  stream.on('response.output_text.delta', (event: { delta: string }) => {
    opts.onTextDelta!(event.delta);
  });
  response = await stream.finalResponse();
} else {
  response = await llmClient.responses.create(params);
}
```

(Keep the surrounding try/catch exactly as is — both branches throw the same way on API errors. Preserve the existing comment block about server-side compaction on the `context_management` line.)

- [x] **Step 4: Run tests**

Run: `npx vitest run tests/agent/`
Expected: PASS (new test + all existing ones, which take the non-streaming branch).

### Task 11: `sendDraft` on the sender + `DraftStreamer`

**Files:**

- Modify: `src/telegram/types.ts`
- Modify: `src/telegram/telegramSender.ts`
- Create: `src/telegram/draftStreamer.ts`
- Test: `tests/telegram/draftStreamer.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/telegram/draftStreamer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DraftStreamer } from '../../src/telegram/draftStreamer.ts';

describe('DraftStreamer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('start() sends an empty draft (Thinking… placeholder)', async () => {
    const sendDraft = vi.fn().mockResolvedValue(undefined);
    const s = new DraftStreamer({ sendDraft }, 7);
    s.start();
    await vi.runAllTimersAsync();
    expect(sendDraft).toHaveBeenCalledWith('', 7);
  });

  it('throttles deltas to one draft per interval, sending accumulated text', async () => {
    const sendDraft = vi.fn().mockResolvedValue(undefined);
    const s = new DraftStreamer({ sendDraft }, 7, 1000);
    s.onDelta('Hel');
    await vi.advanceTimersByTimeAsync(0);
    expect(sendDraft).toHaveBeenLastCalledWith('Hel', 7); // leading edge
    s.onDelta('lo ');
    s.onDelta('world');
    await vi.advanceTimersByTimeAsync(999);
    expect(sendDraft).toHaveBeenCalledTimes(1); // still inside the window
    await vi.advanceTimersByTimeAsync(1);
    expect(sendDraft).toHaveBeenLastCalledWith('Hello world', 7); // trailing edge
  });

  it('finish() cancels pending flushes', async () => {
    const sendDraft = vi.fn().mockResolvedValue(undefined);
    const s = new DraftStreamer({ sendDraft }, 7, 1000);
    s.onDelta('a');
    await vi.advanceTimersByTimeAsync(0);
    s.onDelta('b');
    s.finish();
    await vi.runAllTimersAsync();
    expect(sendDraft).toHaveBeenCalledTimes(1); // only the leading flush
  });

  it('swallows sendDraft errors (drafts are best-effort)', async () => {
    const sendDraft = vi.fn().mockRejectedValue(new Error('network'));
    const s = new DraftStreamer({ sendDraft }, 7);
    s.onDelta('x');
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram/draftStreamer.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `DraftStreamer`**

```ts
// src/telegram/draftStreamer.ts
import { createLogger } from '../utils/logger.ts';

const log = createLogger('telegram-draft');

export interface DraftSink {
  sendDraft(text: string, draftId: number): Promise<void>;
}

/** Pushes accumulated reply text into a Telegram message draft
 *  (sendMessageDraft), throttled to one API call per interval. Drafts are
 *  ephemeral 30-second previews — the caller still sends the final message
 *  via the regular sender. All draft sends are best-effort: a failure must
 *  never break the reply path. */
export class DraftStreamer {
  private readonly sink: DraftSink;
  private readonly draftId: number;
  private readonly intervalMs: number;
  private buffer = '';
  private timer: NodeJS.Timeout | null = null;
  private lastSentAt = 0;
  private finished = false;

  constructor(sink: DraftSink, draftId: number, intervalMs = 1000) {
    this.sink = sink;
    this.draftId = draftId;
    this.intervalMs = intervalMs;
  }

  /** Show the "Thinking…" placeholder (empty draft) immediately. */
  start(): void {
    this.schedule();
  }

  onDelta(delta: string): void {
    if (this.finished) {
      return;
    }
    this.buffer += delta;
    this.schedule();
  }

  /** Stop all future draft sends; the final message supersedes the draft. */
  finish(): void {
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.timer || this.finished) {
      return;
    }
    const wait = Math.max(0, this.lastSentAt + this.intervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    if (this.finished) {
      return;
    }
    this.lastSentAt = Date.now();
    try {
      // Telegram caps message text at 4096 chars after entity parsing.
      await this.sink.sendDraft(this.buffer.slice(0, 4096), this.draftId);
    } catch (err) {
      log.debug({ err }, 'sendMessageDraft failed (best-effort, ignoring)');
    }
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/telegram/draftStreamer.test.ts`
Expected: PASS (4 tests).

- [x] **Step 5: Add `sendDraft` to the sender contract and implementation**

`src/telegram/types.ts`:

```ts
export interface TelegramSender {
  send(text: string): Promise<void>;
  /** Stream a partial reply as an ephemeral draft (Bot API sendMessageDraft,
   * private chats only). Optional — senders without it just don't stream. */
  sendDraft?(text: string, draftId: number): Promise<void>;
}
```

`src/telegram/telegramSender.ts` — add to `BotTelegramSender`:

```ts
  async sendDraft(text: string, draftId: number): Promise<void> {
    // Drafts are plain text on purpose: partial markdown would break
    // MarkdownV2 parsing mid-stream. The final send() formats normally.
    await this.api.raw.sendMessageDraft({
      chat_id: Number(this.chatId),
      draft_id: draftId,
      text,
    });
  }
```

- [x] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean. (`api.raw.sendMessageDraft` is typed in `@grammyjs/types` ≥3.27.)

### Task 12: Wire streaming into the Telegram runner

**Files:**

- Modify: `src/cli/runners/telegram.ts`

- [x] **Step 1: Add a streaming-respond helper and use it on all three agent paths**

In `src/cli/runners/telegram.ts`, add near the bottom (after `handleMessage`):

```ts
import { DraftStreamer } from '../../telegram/draftStreamer.ts';
import type { AgentImage } from '../../agent/types.ts';

/** Run agent.respond() while live-streaming the reply into a Telegram draft
 * when the sender supports it. draftId = updateId (unique per message,
 * non-zero as required by sendMessageDraft). */
async function respondWithDraft(
  ctx: {
    agent: OpenAiAgent;
    session: Session;
    profile: ScopedProfile;
    scope: Scope;
    sender: TelegramSender;
  },
  draftId: number,
  userText: string,
  images?: AgentImage[],
) {
  const sendDraft = ctx.sender.sendDraft?.bind(ctx.sender);
  const streamer = sendDraft ? new DraftStreamer({ sendDraft }, draftId || 1) : null;
  streamer?.start();
  try {
    return await ctx.agent.respond(userText, {
      session: ctx.session,
      profile: ctx.profile,
      scope: ctx.scope,
      ...(images ? { images } : {}),
      ...(streamer ? { onTextDelta: (d: string) => streamer.onDelta(d) } : {}),
    });
  } finally {
    streamer?.finish();
  }
}
```

Then replace the three `ctx.agent.respond(...)` call sites in `handleMessage`:

- voice path (line ~154): `reply = await respondWithDraft(ctx, msg.updateId, transcript);`
- photo path (line ~188): `reply = await respondWithDraft(ctx, msg.updateId, msg.caption ?? '', [image]);`
- text path (line ~240): `reply = await respondWithDraft(ctx, msg.updateId, text);`

The surrounding try/catch and the final `await ctx.sender.send(reply.text)` stay exactly as they are — the persisted message still goes through `send()` with MarkdownV2 formatting.

- [x] **Step 2: Run the runner tests**

Run: `npx vitest run tests/cli/ tests/telegram/ 2>/dev/null || npm test`
Expected: PASS — existing runner tests use senders without `sendDraft`, so the streamer is skipped and behavior is unchanged for them.

### Task 13: Final verification, docs, commit

- [x] **Step 1: Full suite**

Run: `npm run typecheck && npm test && npm run lint`
Expected: all PASS.

- [x] **Step 2: Update CLAUDE.md (Telegram + agent core)**

Document: Telegram replies stream via `sendMessageDraft` (empty draft = "Thinking…" placeholder, throttled accumulated deltas, final `sendMessage` persists); `AgentRespondOptions.onTextDelta` streams output-text deltas (Responses API `responses.stream`); drafts are plain-text, final message stays MarkdownV2.

- [x] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(telegram): stream replies via Bot API sendMessageDraft

While the agent generates a reply, the user sees a live-updating draft:
an empty draft (Telegram renders 'Thinking…') as soon as the request
starts, then accumulated output-text deltas throttled to one
sendMessageDraft per second, and finally the regular sendMessage that
persists the reply (drafts are ephemeral 30-second previews). Senders
without sendDraft keep the old send-once behavior."
```

- [ ] **Step 4: Manual smoke test (requires real bot token)**

Run locally: `AGENT_MODE=telegram npm run start`, message the bot something tool-heavy ("какая температура в спальне и на улице?"). Expected: "Thinking…" appears immediately, text types out incrementally, final message replaces the draft and is markdown-formatted.

---

## Self-review notes

- **Phase independence:** each phase ends with green typecheck+tests and a commit; Phase 3 depends on both earlier phases (grammY for the typed `sendMessageDraft`, plain text for meaningful deltas).
- **Out of scope (deliberately):** goal-runner / `send_to_telegram` tool keep plain `send()` (no inbound updateId to derive a draft_id from, and no user waiting on a live draft); `/assist` and `/text` HTTP responses stay non-streaming (single-shot JSON contract shared with other repos).
- **Known trade-off:** `onTextDelta` fires on tool-call iterations too if the model emits text before calling tools; the draft gets overwritten by later deltas and superseded by the final message, so this is cosmetic.
