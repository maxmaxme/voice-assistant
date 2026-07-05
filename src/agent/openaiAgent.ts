import type OpenAI from 'openai';
import type {
  Response as OpenAiResponse,
  ResponseInputItem,
  ResponseInputImage,
  ResponseInputText,
  ResponseFunctionToolCall,
  Tool,
} from 'openai/resources/responses/responses';
import type { Agent, AgentImage, AgentResponse, AgentRespondOptions } from './types.ts';
import type { McpClient } from '../mcp/types.ts';
import type { MemoryStore } from '../memory/types.ts';
import { householdFromAdapter, type ScopedProfile } from '../memory/scope.ts';
import { Session } from './session.ts';
import { mcpToolsToOpenAi } from './toolBridge.ts';
import { ASK_TOOL_NAME, buildAskTool } from './askTool.ts';
import { buildLocalToolset } from './localTools.ts';
import { executeRoutedTool } from './toolExecutor.ts';
import type { ToolsConfig } from '../settings/toolsConfig.ts';
import type { TelegramSender } from '../telegram/types.ts';
import { createLogger } from '../utils/logger.ts';
import { isPreviousResponseGoneError } from '../utils/openaiErrors.ts';

const log = createLogger('agent');

export interface OpenAiAgentOptions {
  mcp: McpClient;
  memory: MemoryStore;
  session: Session;
  systemPrompt: string;
  model: string;
  maxToolIterations?: number;
  llmClient: OpenAI;
  /** Builds a Telegram sender bound to a chat id. `send_to_telegram` resolves
   *  its recipient (the current scope's user by default) to a chat via
   *  `memory.identities` and delivers through this. */
  telegram: { senderFor: (chatId: string) => TelegramSender };
  /** When 'goal', the agent runs in scheduled-fire mode:
   *   - The system message is replaced by a directive to execute the
   *     incoming user text as a previously-scheduled goal.
   *   - The `ask` tool is omitted (no user is present).
   *   - Each call uses a fresh chain (Session is reset before begin()).
   *   Default: 'chat' */
  mode?: 'chat' | 'goal';
  /** Whether to expose the `ask` tool to the model. Useful only on channels
   * where a positive `expectsFollowUp` signal actually reopens the mic for
   * the user — currently only HTTP (Voice PE via HA bridge reads
   * continue_conversation from the /text response and reopens the
   * pipeline). On Telegram the model just asks in its reply text, so leaving
   * `ask` off avoids chain-lock risks. Default: true. */
  enableAsk?: boolean;
  /** Reasoning effort for reasoning-capable models (gpt-5 family, o-series).
   * Ignored by the API for non-reasoning models. Default 'low' — enough for
   * tool routing and most household requests, keeps reasoning-token spend
   * bounded. Bump to 'medium'/'high' for puzzle-heavy workloads. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Expose OpenAI's hosted `web_search` tool to the model. Costs tokens per
   *  call. Comes from the OpenAI integration. Default: false. */
  webSearch?: boolean;
  /** Built-in tool gates + weather config (web panel's Tools page). When
   *  omitted, all built-in tools are on (back-compat). Reminders/telegram are
   *  additionally gated by goal mode + adapter wiring. */
  tools?: ToolsConfig;
}

export class OpenAiAgent implements Agent {
  private readonly maxIters: number;
  private readonly opts: OpenAiAgentOptions;
  private readonly mode: 'chat' | 'goal';

  constructor(opts: OpenAiAgentOptions) {
    this.opts = opts;
    this.maxIters = opts.maxToolIterations ?? 20;
    this.mode = opts.mode ?? 'chat';
  }

  get session(): Session {
    return this.opts.session;
  }

  async respond(userText: string, opts: AgentRespondOptions = {}): Promise<AgentResponse> {
    const { mcp, model, llmClient } = this.opts;
    const session = opts.session ?? this.opts.session;
    const profile: ScopedProfile = opts.profile ?? householdFromAdapter(this.opts.memory.profile);
    // Owner for scheduled-action tools (author of new reminders, owner-scoped
    // list/cancel). Goal-mode fires and unscoped callers have no principal.
    const ownerUserId = opts.scope?.userId ?? null;
    const images = opts.images ?? [];
    const respondStartedAt = Date.now();

    log.info(
      { mode: this.mode, hasImages: images.length > 0, imageCount: images.length },
      `user → ${userText}`,
    );

    // In goal mode, every fire is a fresh chain — the directive (system
    // prompt) must apply on every call, and there's no continuing user
    // conversation to chain into.
    if (this.mode === 'goal') {
      session.reset();
    }

    let previousResponseId = session.begin();
    // Send `instructions` (system prompt + profile) only when starting a
    // fresh chain. Within a chain OpenAI keeps the original instructions
    // alongside the rest of the conversation state.
    const buildInstructions = (): string =>
      this.mode === 'goal'
        ? this.buildGoalSystemMessage(userText)
        : this.buildSystemMessage(profile);
    let instructions: string | undefined =
      previousResponseId === undefined ? buildInstructions() : undefined;

    // `ask` only makes sense where a positive `expectsFollowUp` actually
    // reopens the mic for the user: HTTP (Voice PE via HA bridge, which
    // forwards continue_conversation). On Telegram the model just asks
    // in its reply text. Goal-fire mode never has a user.
    const askEnabled = this.mode !== 'goal' && (this.opts.enableAsk ?? true);
    const mcpTools = mcpToolsToOpenAi(await mcp.listTools());
    // Goal mode is a scheduled fire, not an interactive turn:
    //  - no send_to_telegram: delivery is owned by the goal runner, which
    //    sends the agent's reply to the action's *author*. Exposing the tool
    //    would deliver to the wrong, fixed chat.
    //  - no schedule/list/cancel: a fire executes its goal, it does not
    //    re-plan. The goal carries no user scope, so these would only confuse
    //    the model (and schedule_action would throw on the null owner).
    const goalMode = this.mode === 'goal';
    // One registry for build + dispatch — the same `buildLocalToolset` the
    // realtime bridge uses. Goal mode simply doesn't wire the adapters whose
    // tools it must not expose; the registry omits them. `ask` stays separate:
    // it's terminal control flow, not an executable tool.
    const localToolset = buildLocalToolset({
      profile,
      scheduledActions: goalMode ? undefined : this.opts.memory.scheduledActions,
      telegram: goalMode ? undefined : this.opts.telegram,
      identities: this.opts.memory.identities,
      ownerUserId,
      enableMemory: this.opts.tools?.memory,
      enableReminders: this.opts.tools?.reminders,
      enableWeather: this.opts.tools?.weather.enabled,
      weatherUnits: this.opts.tools?.weather.units,
      weatherDefaultLocation: this.opts.tools?.weather.defaultLocation,
    });
    const localTools = [...localToolset.tools, ...(askEnabled ? [buildAskTool()] : [])];
    // Our function-tool shape (`OpenAiFunctionTool`-derived) matches the
    // SDK's `FunctionTool` member of the `Tool` union structurally, but our
    // locally-built objects don't carry the SDK's exact nominal type — type
    // the result as Tool[] directly so the spread below yields the union.
    const functionTools: Tool[] = [...mcpTools, ...localTools].map((t) => ({
      ...t,
      strict: t.strict ?? null,
    }));
    // Hosted tools (e.g. OpenAI's web_search) have a different shape than
    // function tools — no name/parameters, just `{ type: 'web_search' }`.
    const tools: Tool[] = [...functionTools];
    if (this.opts.webSearch) {
      tools.push({ type: 'web_search' });
    }

    // If the previous turn ended with an `ask` tool call, the API still has
    // an open function_call that needs a function_call_output. Submit the
    // user's answer as that output instead of a plain user message.
    // When `ask` was emitted in parallel with other tools, those tools were
    // executed locally last turn and their outputs were stashed on the
    // session — replay them here too, or OpenAI 400s with "No tool output
    // found for function call <id>".
    let nextInput: ResponseInputItem[];
    // consumePendingAsk owns the whole lifecycle (TTL check on the session
    // clock, clearing the fields, snapshotting for the failure-restore path).
    // If the OpenAI call below fails, the ask is still open on OpenAI's side —
    // the catch restores the snapshot, otherwise the next turn sends a plain
    // user message into a chain with an unanswered function_call and 400s.
    const consumedAsk = session.consumePendingAsk();
    const askSnapshot = consumedAsk.state === 'none' ? undefined : consumedAsk.snapshot;
    // Replayed in both ask branches: outputs of tools that ran in parallel
    // with the ask last turn.
    const stashed: ResponseInputItem[] = (
      consumedAsk.state === 'none' ? [] : consumedAsk.stashed
    ).map((po) => ({
      type: 'function_call_output',
      call_id: po.callId,
      output: po.output,
    }));
    if (consumedAsk.state === 'live') {
      const askOutput: ResponseInputItem = {
        type: 'function_call_output',
        call_id: consumedAsk.callId,
        output: images.length > 0 ? userContentParts(userText, images) : userText,
      };
      nextInput = [...stashed, askOutput];
    } else if (consumedAsk.state === 'expired') {
      // Past the TTL the user's next utterance is much more likely a new
      // request than a delayed answer — but the API still requires an output
      // for every emitted function_call, so close the stale ask with a
      // placeholder and send the user's message as a fresh user-turn.
      const askPlaceholder: ResponseInputItem = {
        type: 'function_call_output',
        call_id: consumedAsk.callId,
        output:
          '(no response — too much time passed; the user is starting a new request, not answering this question)',
      };
      nextInput = [...stashed, askPlaceholder, userTurn(userText, images)];
    } else {
      nextInput = [userTurn(userText, images)];
    }

    const toolsUsed: string[] = [];

    for (let i = 0; i < this.maxIters; i++) {
      // ParsedResponse (the stream branch) extends Response — pin the common
      // base type so downstream narrowing (the function_call filter) works.
      let response: OpenAiResponse;
      try {
        const params = {
          model,
          ...(instructions !== undefined && i === 0 ? { instructions } : {}),
          input: nextInput,
          tools: tools.length > 0 ? tools : undefined,
          store: true,
          previous_response_id: previousResponseId,
          // Server-side compaction: when the rendered chain crosses the
          // threshold, OpenAI replaces older turns with an opaque compaction
          // item. Keeps cost and context-window growth bounded on long chains.
          // 30k tokens is well below gpt-4o's 128k window — gives the model
          // plenty of headroom for tools and the current turn.
          context_management: [{ type: 'compaction' as const, compact_threshold: 30_000 }],
          reasoning: { effort: this.opts.reasoningEffort ?? 'low' },
        };
        const onTextDelta = opts.onTextDelta;
        if (onTextDelta) {
          const stream = llmClient.responses.stream(params);
          // Listener event type comes from the SDK (ResponseTextDeltaEvent).
          stream.on('response.output_text.delta', (event) => {
            onTextDelta(event.delta);
          });
          response = await stream.finalResponse();
        } else {
          response = await llmClient.responses.create(params);
        }
      } catch (err) {
        // OpenAI evicts `previous_response_id` after ~30 days (the Responses
        // API retention window). When that happens we get back a 404 saying
        // the previous response wasn't found. Recover by dropping the chain
        // and retrying this turn fresh — but only on the first iteration,
        // when previousResponseId is the stale one from disk. Later
        // iterations chain off the response we just got, which is fresh.
        if (i === 0 && previousResponseId !== undefined && isPreviousResponseGoneError(err)) {
          log.warn(
            { err },
            'previous_response_id missing on OpenAI side — resetting chain and retrying',
          );
          session.reset();
          previousResponseId = undefined;
          instructions = buildInstructions();
          // The chain is gone, and with it any open function_call a pending
          // ask left behind — replaying its function_call_output items into
          // a fresh chain 400s ("No tool call found for function call
          // output"). Retry with the user's message as a plain user turn.
          nextInput = [userTurn(userText, images)];
          i--; // retry this iteration with no chain
          continue;
        }
        // First call failed → the cleared pending ask never reached OpenAI.
        // Restore it so the next respond() replays the ask output. Skip when
        // the chain was dropped (404 recovery above): a restored ask without
        // its chain would itself 400.
        if (i === 0 && askSnapshot && previousResponseId !== undefined) {
          session.restorePendingAsk(askSnapshot);
        }
        throw err;
      }

      const fnCalls = (response.output ?? []).filter(
        (it): it is ResponseFunctionToolCall => it.type === 'function_call',
      );

      // Tool calls take precedence over any message text in the same response:
      // leaving a function_call unanswered would 400 the next turn ("No tool output found").
      if (fnCalls.length === 0) {
        session.commit(response.id);
        const text = stripApiArtifacts(outputTextOf(response));
        if (text === '') {
          log.warn(
            { outputItems: (response.output ?? []).map((it) => it.type) },
            'assistant returned empty text',
          );
        }
        const usage = response.usage;
        log.info(
          {
            elapsedMs: Date.now() - respondStartedAt,
            iterations: i + 1,
            streamed: opts.onTextDelta !== undefined,
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

      // `ask` is terminal: it ends the agent turn with the question text as
      // the final reply, signalling that the orchestrator should reopen
      // capture for the user's answer. When the model emits `ask` in
      // parallel with other tools, we still must execute those other tools
      // and stash their function_call_outputs on the session — otherwise
      // the next user turn 400s with "No tool output found for function
      // call <id>" (the API requires outputs for every emitted call_id).
      const askCall = fnCalls.find((tc) => tc.name === ASK_TOOL_NAME);
      const nonAskCalls = askCall ? fnCalls.filter((tc) => tc !== askCall) : fnCalls;

      for (const tc of fnCalls) {
        toolsUsed.push(tc.name);
      }

      // Execute all tool calls in parallel. Each handler catches its own
      // errors; we use allSettled as defense-in-depth so an unexpected
      // throw in one call can't drop the others' outputs.
      const settled = await Promise.allSettled(
        nonAskCalls.map(async (tc) => {
          const args = this.parseArgs(tc.arguments);
          // Executing with silently-empty args would hit the wrong device or
          // surface a cryptic adapter error — tell the model its call was
          // malformed so it re-emits with valid JSON instead.
          if (args === null) {
            log.warn(
              { tool: tc.name, rawArguments: tc.arguments },
              `${tc.name} got malformed argument JSON`,
            );
            return {
              type: 'function_call_output' as const,
              call_id: tc.call_id,
              output:
                'ERROR: invalid JSON in tool arguments — re-emit this tool call with valid JSON arguments',
            };
          }
          const startedAt = Date.now();
          const { text: resultText, isError } = await executeRoutedTool(
            localToolset,
            mcp,
            tc.name,
            args,
          );
          const durationMs = Date.now() - startedAt;
          const argsStr = JSON.stringify(args);
          const fields = { tool: tc.name, args, isError, durationMs };
          if (isError) {
            log.warn(fields, `${tc.name}(${argsStr}) → ${resultText} (${durationMs}ms)`);
          } else {
            log.debug(fields, `${tc.name}(${argsStr}) → ${resultText} (${durationMs}ms)`);
          }
          const output = isError
            ? `ERROR: ${resultText}${appendRecoveryHint(tc.name, resultText)}`
            : resultText;
          return {
            type: 'function_call_output' as const,
            call_id: tc.call_id,
            output,
          };
        }),
      );

      const toolOutputs: ResponseInputItem[] = settled.map((res, idx) => {
        if (res.status === 'fulfilled') {
          return res.value;
        }
        const tc = nonAskCalls[idx]!;
        const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
        log.error({ tool: tc.name }, `${tc.name} unexpected throw: ${reason}`);
        return {
          type: 'function_call_output',
          call_id: tc.call_id,
          output: `ERROR: ${reason}`,
        };
      });

      if (askCall) {
        // Stash non-ask outputs alongside the pending ask call_id. The next
        // user turn replays the stashed outputs together with the user's
        // answer (which serves as ask's output) — keeping the chain valid.
        const askArgs = this.parseArgs(askCall.arguments) ?? {};
        const askText = typeof askArgs.text === 'string' ? askArgs.text : '';
        log.debug(
          { tool: 'ask', args: askArgs },
          `ask(${JSON.stringify(askArgs)}) → reopen capture`,
        );
        session.setPendingAsk(
          askCall.call_id,
          nonAskCalls.map((tc, idx) => {
            const res = settled[idx]!;
            const output =
              res.status === 'fulfilled'
                ? res.value.output
                : `ERROR: ${res.reason instanceof Error ? res.reason.message : String(res.reason)}`;
            return { callId: tc.call_id, output };
          }),
        );
        session.commit(response.id);
        return { text: askText, expectsFollowUp: true, toolsUsed };
      }

      previousResponseId = response.id;
      nextInput = toolOutputs;
    }

    throw new Error('Agent exceeded max tool iterations');
  }

  private buildSystemMessage(profile: ScopedProfile): string {
    const base = this.opts.systemPrompt;
    const facts = profile.recall();
    // No static clock: a long-lived chain keeps its original instructions, so a
    // baked-in timestamp would go stale (yesterday's date after midnight). The
    // agent reads the current time on demand via the get_current_time tool.
    const timeBlock =
      `\n\nYou do NOT know the current date/time from this prompt — call the ` +
      `get_current_time tool whenever you need "now" or to resolve a relative date ` +
      `(today/tomorrow/this weekend), e.g. before get_weather or schedule_action.`;
    const webSearchBlock = this.opts.webSearch
      ? `\n\nThe web_search tool is available — use it for weather, news, and general-knowledge queries that no Home Assistant entity covers.`
      : '';
    if (Object.keys(facts).length === 0) {
      return base + timeBlock + webSearchBlock;
    }
    return `${base}${timeBlock}${webSearchBlock}\n\nKnown user profile: ${JSON.stringify(facts)}`;
  }

  private buildGoalSystemMessage(goal: string): string {
    // Goal mode never carries a per-user scope; the household view of the
    // agent's own adapter is the correct (and only) profile here.
    const base = this.buildSystemMessage(householdFromAdapter(this.opts.memory.profile));
    return (
      base +
      `\n\nYou are running a previously-scheduled goal. There is NO USER PRESENT: do NOT ask clarifying questions and do NOT request any details — the goal is final and self-contained, act on it as-is. You cannot message the user mid-task and have no Telegram/send tool. Your final reply text is delivered to the user who scheduled this automatically, so write it AS the message to them: if the goal is just a reminder (even if it literally says "send to Telegram …" or similar), output ONLY the reminder content, in the user's language (e.g. goal "send a Telegram reminder: walk the dog" → reply "Reminder: walk the dog"); if it is an action, perform it via your tools and reply with a short confirmation. Plain text, no preamble, no questions.\n\nThe goal: ${goal}`
    );
  }

  /** Returns null on malformed JSON so the tool loop can refuse to execute
   *  the call (the `ask` path stays lenient — it only extracts display text). */
  private parseArgs(raw: string | undefined): Record<string, unknown> | null {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return null;
    }
  }
}

function toInputImage(img: AgentImage): ResponseInputImage {
  const dataUrl = `data:${img.mimeType};base64,${img.data.toString('base64')}`;
  return { type: 'input_image', image_url: dataUrl, detail: 'auto' };
}

/** Multimodal content parts for a user message with images attached. */
function userContentParts(
  userText: string,
  images: AgentImage[],
): (ResponseInputText | ResponseInputImage)[] {
  const textPart: ResponseInputText = {
    type: 'input_text',
    text: userText && userText.length > 0 ? userText : '(image)',
  };
  return [textPart, ...images.map(toInputImage)];
}

/** A plain user turn — string content when text-only, parts when images ride along. */
function userTurn(userText: string, images: AgentImage[]): ResponseInputItem {
  return images.length > 0
    ? { role: 'user', content: userContentParts(userText, images) }
    : { role: 'user', content: userText };
}

// The SDK computes the convenience field `output_text` only on
// responses.create(); ResponseStream.finalResponse() skips that step for
// plain-text (non-auto-parseable) requests and leaves it undefined. Derive
// the final text from the message items directly so both branches agree.
function outputTextOf(response: OpenAiResponse): string {
  const texts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message') {
      continue;
    }
    for (const content of item.content) {
      if (content.type === 'output_text') {
        texts.push(content.text);
      }
    }
  }
  return texts.join('');
}

// OpenAI Responses API with store:true sometimes leaks conversation-title
// annotations (e.g. `<title="...": ...>`) into the output text.
function stripApiArtifacts(text: string): string {
  return text.replace(/<title=[^>]*>/g, '').trim();
}

// HA tools that return MatchFailedError when the user's phrasing doesn't
// resolve to a known entity/area. Soft prompt rules alone weren't enough to
// stop the model from immediately falling back to `ask` on these errors —
// inject a directive into the tool output so the next turn is forced into
// discovery + retry.
const HA_MATCH_FAILED_PATTERNS = ['MatchFailedError', 'MatchFailedReason', 'no_match_reason'];

function appendRecoveryHint(toolName: string, errorText: string): string {
  if (toolName === 'GetLiveContext') {
    return '';
  }
  const isMatchFailure = HA_MATCH_FAILED_PATTERNS.some((p) => errorText.includes(p));
  if (!isMatchFailure) {
    return '';
  }
  return (
    '\n\nNEXT ACTION REQUIRED: your very next tool call MUST be `GetLiveContext` ' +
    'with no arguments. Do NOT call `ask`. Do NOT reply in plain text. After ' +
    'GetLiveContext returns, pick the closest real entity/area name to what ' +
    'the user said (account for typos, declensions, partial names, synonyms ' +
    'in any language) and retry the original action. Only if that retry also ' +
    'fails OR there are several plausible candidates may you then call `ask`.'
  );
}
