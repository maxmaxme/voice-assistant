import type OpenAI from 'openai';
import type {
  ResponseInputItem,
  ResponseInputImage,
  ResponseInputText,
  ParsedResponseFunctionToolCall,
  Tool,
} from 'openai/resources/responses/responses';
import type { Agent, AgentImage, AgentResponse, AgentRespondOptions } from './types.ts';
import type { McpClient } from '../mcp/types.ts';
import type { MemoryStore } from '../memory/types.ts';
import { Session } from './session.ts';
import { mcpToolsToOpenAi } from './toolBridge.ts';
import { MEMORY_TOOL_NAMES, buildMemoryTools, executeMemoryTool } from './memoryTools.ts';
import {
  SCHEDULED_ACTION_TOOL_NAMES,
  buildScheduledActionTools,
  executeScheduledActionTool,
} from './scheduledActionTools.ts';
import { ASK_TOOL_NAME, buildAskTool } from './askTool.ts';
import { TELEGRAM_TOOL_NAME, buildTelegramTool, executeTelegramTool } from './telegramTool.ts';
import type { TelegramSender } from '../telegram/types.ts';
import { VOICE_TEXT_FORMAT, CHAT_TEXT_FORMAT } from './agentOutput.ts';
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
  telegram: TelegramSender;
  /** Structured-output format for the final agent reply. Use VOICE_TEXT_FORMAT
   * for voice/wake channels (speak nullable + direction), CHAT_TEXT_FORMAT for
   * chat/telegram (speak always required, no direction). */
  textFormat?: typeof VOICE_TEXT_FORMAT | typeof CHAT_TEXT_FORMAT;
  /** When 'goal', the agent runs in scheduled-fire mode:
   *   - The system message is replaced by a directive to execute the
   *     incoming user text as a previously-scheduled goal.
   *   - The `ask` tool is omitted (no user is present).
   *   - Each call uses a fresh chain (Session is reset before begin()).
   *   Default: 'chat' */
  mode?: 'chat' | 'goal';
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
    const images = opts.images ?? [];

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
      this.mode === 'goal' ? this.buildGoalSystemMessage(userText) : this.buildSystemMessage();
    let instructions: string | undefined =
      previousResponseId === undefined ? buildInstructions() : undefined;

    const mcpTools = mcpToolsToOpenAi(await mcp.listTools());
    const localTools = [
      ...buildMemoryTools(),
      ...buildScheduledActionTools(),
      ...(this.mode === 'goal' ? [] : [buildAskTool()]),
      buildTelegramTool(),
    ];
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
    let nextInput: ResponseInputItem[];
    const pendingAskCallId = session.pendingAskCallId;
    if (pendingAskCallId) {
      session.pendingAskCallId = undefined;
      if (images.length > 0) {
        // function_call_output.output accepts an array of input parts — text
        // plus images is fine. Use that to answer an `ask` with a picture.
        const textPart: ResponseInputText = {
          type: 'input_text',
          text: userText && userText.length > 0 ? userText : '(image)',
        };
        const imageParts: ResponseInputImage[] = images.map(toInputImage);
        nextInput = [
          {
            type: 'function_call_output',
            call_id: pendingAskCallId,
            output: [textPart, ...imageParts],
          },
        ];
      } else {
        nextInput = [{ type: 'function_call_output', call_id: pendingAskCallId, output: userText }];
      }
    } else if (images.length > 0) {
      const textPart: ResponseInputText = {
        type: 'input_text',
        text: userText && userText.length > 0 ? userText : '(image)',
      };
      const imageParts: ResponseInputImage[] = images.map(toInputImage);
      nextInput = [{ role: 'user', content: [textPart, ...imageParts] }];
    } else {
      nextInput = [{ role: 'user', content: userText }];
    }

    for (let i = 0; i < this.maxIters; i++) {
      let response;
      try {
        response = await llmClient.responses.parse({
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
          context_management: [{ type: 'compaction', compact_threshold: 30_000 }],
          text: {
            format: this.opts.textFormat ?? VOICE_TEXT_FORMAT,
          },
        });
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
        throw err;
      }

      if (response.output_parsed != null) {
        session.commit(response.id);
        const parsed = response.output_parsed;
        const text = stripApiArtifacts(parsed.speak ?? '');
        const direction = 'direction' in parsed ? (parsed.direction ?? null) : null;
        log.info({ direction }, `assistant → ${text}`);
        return { text, direction };
      }

      const fnCalls = (response.output ?? []).filter(
        (it): it is ParsedResponseFunctionToolCall => it.type === 'function_call',
      );

      if (fnCalls.length > 0) {
        // Special-case the `ask` tool: it's terminal — calling it ends the
        // agent turn with the question text as the final reply, signalling
        // that the orchestrator should reopen capture for the user's answer.
        const askCall = fnCalls.find((tc) => tc.name === ASK_TOOL_NAME);
        if (askCall) {
          const args = this.parseArgs(askCall.arguments);
          const text = typeof args.text === 'string' ? args.text : '';
          log.debug({ tool: 'ask', args }, `ask(${JSON.stringify(args)}) → reopen capture`);
          session.pendingAskCallId = askCall.call_id;
          session.commit(response.id);
          return { text, direction: null, expectsFollowUp: true };
        }

        // Execute all tool calls in parallel. Each handler catches its own
        // errors; we use allSettled as defense-in-depth so an unexpected
        // throw in one call can't drop the others' outputs.
        const settled = await Promise.allSettled(
          fnCalls.map(async (tc) => {
            const args = this.parseArgs(tc.arguments);
            const startedAt = Date.now();
            let resultText: string;
            let isError = false;
            if (MEMORY_TOOL_NAMES.has(tc.name)) {
              try {
                const r = executeMemoryTool(this.opts.memory.profile, tc.name, args);
                resultText = JSON.stringify(r);
              } catch (e) {
                resultText = e instanceof Error ? e.message : String(e);
                isError = true;
              }
            } else if (SCHEDULED_ACTION_TOOL_NAMES.has(tc.name)) {
              try {
                const r = executeScheduledActionTool(
                  this.opts.memory.scheduledActions,
                  tc.name,
                  args,
                );
                resultText = JSON.stringify(r);
              } catch (e) {
                resultText = e instanceof Error ? e.message : String(e);
                isError = true;
              }
            } else if (tc.name === TELEGRAM_TOOL_NAME) {
              try {
                const r = await executeTelegramTool(this.opts.telegram, args);
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
                resultText = result.content
                  .map((c) => (c.type === 'text' ? c.text : ''))
                  .join('\n');
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
          const tc = fnCalls[idx]!;
          const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
          log.error({ tool: tc.name }, `${tc.name} unexpected throw: ${reason}`);
          return {
            type: 'function_call_output',
            call_id: tc.call_id,
            output: `ERROR: ${reason}`,
          };
        });
        previousResponseId = response.id;
        nextInput = toolOutputs;
        continue;
      }

      // No tool calls and no parsed output — shouldn't happen, but guard anyway
      session.commit(response.id);
      return { text: '', direction: null };
    }

    throw new Error('Agent exceeded max tool iterations');
  }

  private buildSystemMessage(): string {
    const base = this.opts.systemPrompt;
    const profile = this.opts.memory.profile.recall();
    const nowMs = Date.now();
    // Include both UTC ISO and local time with offset so the LLM can express
    // dates in the server's local timezone without doing timezone arithmetic.
    const nowUtcIso = new Date(nowMs).toISOString();
    const tzName = getServerTimezone();
    const nowLocal = toLocalIso(nowMs);
    // Give the LLM a direct formula so it doesn't need to do timezone math.
    const timeBlock =
      `\n\nCurrent time: ${nowUtcIso} UTC = ${nowLocal} (server timezone: ${tzName}).` +
      ` Unix ms now: ${nowMs}.` +
      `\n\nScheduling actions: use schedule_action(goal, schedule_kind, schedule_expr).` +
      `\n  • One-shot: schedule_kind="once", schedule_expr is a wall-clock string in the server timezone, e.g. "2026-04-27 09:00" or "2026-04-27 09:00:00". NO timezone offset — the server resolves it.` +
      `\n  • Recurring: schedule_kind="cron", schedule_expr is a POSIX 5-field cron string evaluated in the server timezone. Examples: "0 8 * * *" (daily 08:00), "30 7 * * 1-5" (weekdays 07:30), "*/15 * * * *" (every 15 min).` +
      `\n  • The "goal" is replayed verbatim to the agent at fire time, so write it as a self-contained instruction that can be acted on with no extra context (e.g. "turn on the kitchen light", not "do the thing we discussed").` +
      `\n  • Compound goals are allowed in a single schedule_action: "turn on the kitchen light and send me a good morning message in Telegram" → at fire time the agent calls both tools.` +
      `\n  • Use list_scheduled / cancel_scheduled to inspect or remove existing schedules.`;
    const webSearchBlock =
      process.env.OPENAI_WEB_SEARCH === '1'
        ? `\n\nThe web_search tool is available — use it for weather, news, and general-knowledge queries that no Home Assistant entity covers.`
        : '';
    if (Object.keys(profile).length === 0) {
      return base + timeBlock + webSearchBlock;
    }
    return `${base}${timeBlock}${webSearchBlock}\n\nKnown user profile: ${JSON.stringify(profile)}`;
  }

  private buildGoalSystemMessage(goal: string): string {
    const base = this.buildSystemMessage();
    return (
      base +
      `\n\nYou are running a previously-scheduled goal. There is NO USER PRESENT — do NOT call the 'ask' tool. Execute the goal end-to-end using your tools, then return a one-sentence summary of what you did.\n\nThe goal: ${goal}`
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

// OpenAI Responses API with store:true sometimes leaks conversation-title
// annotations (e.g. `<title="...": ...>`) into the structured output text.
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
