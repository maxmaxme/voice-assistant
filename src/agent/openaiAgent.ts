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
import { PENDING_ASK_TTL_MS, Session } from './session.ts';
import { mcpToolsToOpenAi } from './toolBridge.ts';
import { ASK_TOOL_NAME, buildAskTool } from './askTool.ts';
import { buildLocalToolset } from './localTools.ts';
import type { TelegramSender } from '../telegram/types.ts';
import { getServerTimezone, toLocalIso } from '../utils/time.ts';
import { createLogger } from '../utils/logger.ts';
import { isValidContent } from '../utils/mcpContent.ts';
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
    // Re-read the env var on every turn so toggling it on a running process
    // takes effect immediately, no restart required.
    const tools: Tool[] = [...functionTools];
    if (process.env.OPENAI_WEB_SEARCH === '1') {
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
    const pendingAskCallId = session.pendingAskCallId;
    const pendingAskExpiresAt = session.pendingAskExpiresAt;
    const pendingToolOutputs = session.pendingToolOutputs ?? [];
    // The pending ask is "live" only briefly: if the user takes too long
    // to reply, their next utterance is much more likely a new request
    // than a delayed answer. After the TTL we still must close the ask's
    // call_id (the API requires an output for every emitted function_call)
    // but we do it with a placeholder and send the user's message as a
    // normal user-turn instead of stuffing it into the ask's output.
    const pendingAskExpired =
      pendingAskCallId !== undefined &&
      pendingAskExpiresAt !== undefined &&
      Date.now() > pendingAskExpiresAt;
    // The branches below clear the pending-ask fields on the session before
    // the OpenAI call. If that call then fails, the ask is still open on
    // OpenAI's side — keep a snapshot so the catch below can restore it,
    // otherwise the next turn sends a plain user message into a chain with
    // an unanswered function_call and 400s ("No tool output found").
    const askSnapshot =
      pendingAskCallId !== undefined
        ? {
            callId: pendingAskCallId,
            expiresAt: pendingAskExpiresAt,
            outputs: session.pendingToolOutputs,
          }
        : undefined;
    // Replayed in both ask branches: outputs of tools that ran in parallel
    // with the ask last turn.
    const stashed: ResponseInputItem[] = pendingToolOutputs.map((po) => ({
      type: 'function_call_output',
      call_id: po.callId,
      output: po.output,
    }));
    if (pendingAskCallId && !pendingAskExpired) {
      clearPendingAsk(session);
      const askOutput: ResponseInputItem = {
        type: 'function_call_output',
        call_id: pendingAskCallId,
        output: images.length > 0 ? userContentParts(userText, images) : userText,
      };
      nextInput = [...stashed, askOutput];
    } else if (pendingAskCallId && pendingAskExpired) {
      // Close the stale ask + replay any stashed sibling outputs, then send
      // the user's message as a fresh user-turn rather than as the ask's
      // answer.
      clearPendingAsk(session);
      const askPlaceholder: ResponseInputItem = {
        type: 'function_call_output',
        call_id: pendingAskCallId,
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
          i--; // retry this iteration with no chain
          continue;
        }
        // First call failed → the cleared pending ask never reached OpenAI.
        // Restore it so the next respond() replays the ask output. Skip when
        // the chain was dropped (404 recovery above): a restored ask without
        // its chain would itself 400.
        if (i === 0 && askSnapshot && previousResponseId !== undefined) {
          session.pendingAskCallId = askSnapshot.callId;
          session.pendingAskExpiresAt = askSnapshot.expiresAt;
          session.pendingToolOutputs = askSnapshot.outputs;
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
          const startedAt = Date.now();
          let resultText: string;
          let isError = false;
          if (localToolset.names.has(tc.name)) {
            try {
              const r = await localToolset.execute(tc.name, args);
              resultText = JSON.stringify(r);
            } catch (e) {
              resultText = e instanceof Error ? e.message : String(e);
              isError = true;
            }
          } else {
            try {
              const result = await mcp.callTool(tc.name, args);
              if (!isValidContent(result.content)) {
                throw new Error('Invalid content');
              }
              resultText = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
              isError = result.isError ?? false;
            } catch (e) {
              resultText = e instanceof Error ? e.message : String(e);
              isError = true;
            }
          }
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
        const askArgs = this.parseArgs(askCall.arguments);
        const askText = typeof askArgs.text === 'string' ? askArgs.text : '';
        log.debug(
          { tool: 'ask', args: askArgs },
          `ask(${JSON.stringify(askArgs)}) → reopen capture`,
        );
        session.pendingAskCallId = askCall.call_id;
        session.pendingAskExpiresAt = Date.now() + PENDING_ASK_TTL_MS;
        session.pendingToolOutputs = nonAskCalls.map((tc, idx) => {
          const res = settled[idx]!;
          const output =
            res.status === 'fulfilled'
              ? res.value.output
              : `ERROR: ${res.reason instanceof Error ? res.reason.message : String(res.reason)}`;
          return { callId: tc.call_id, output };
        });
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
    const nowMs = Date.now();
    // Include both UTC ISO and local time with offset so the LLM can express
    // dates in the server's local timezone without doing timezone arithmetic.
    const nowUtcIso = new Date(nowMs).toISOString();
    const tzName = getServerTimezone();
    const nowLocal = toLocalIso(nowMs);
    // Give the LLM a direct formula so it doesn't need to do timezone math.
    // Scheduling mechanics (formats, examples, reminder→Telegram rule) live
    // on the schedule_action tool description.
    const timeBlock =
      `\n\nCurrent time: ${nowUtcIso} UTC = ${nowLocal} (server timezone: ${tzName}).` +
      ` Unix ms now: ${nowMs}.`;
    const webSearchBlock =
      process.env.OPENAI_WEB_SEARCH === '1'
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

  private parseArgs(raw: string | undefined): Record<string, unknown> {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }
}

function toInputImage(img: AgentImage): ResponseInputImage {
  const dataUrl = `data:${img.mimeType};base64,${img.data.toString('base64')}`;
  return { type: 'input_image', image_url: dataUrl, detail: 'auto' };
}

function clearPendingAsk(session: Session): void {
  session.pendingAskCallId = undefined;
  session.pendingAskExpiresAt = undefined;
  session.pendingToolOutputs = undefined;
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
