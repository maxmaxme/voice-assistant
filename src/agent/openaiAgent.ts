import type OpenAI from 'openai';
import type {
  ResponseInputItem,
  ParsedResponseFunctionToolCall,
} from 'openai/resources/responses/responses';
import type { Agent, AgentResponse } from './types.ts';
import type { McpClient } from '../mcp/types.ts';
import type { MemoryStore } from '../memory/types.ts';
import { Session } from './session.ts';
import { mcpToolsToOpenAi } from './toolBridge.ts';
import { MEMORY_TOOL_NAMES, buildMemoryTools, executeMemoryTool } from './memoryTools.ts';
import { REMINDER_TOOL_NAMES, buildReminderTools, executeReminderTool } from './reminderTools.ts';
import { TIMER_TOOL_NAMES, buildTimerTools, executeTimerTool } from './timerTools.ts';
import { ASK_TOOL_NAME, buildAskTool } from './askTool.ts';
import { TELEGRAM_TOOL_NAME, buildTelegramTool, executeTelegramTool } from './telegramTool.ts';
import type { TelegramSender } from '../telegram/types.ts';
import { VOICE_TEXT_FORMAT, CHAT_TEXT_FORMAT } from './agentOutput.ts';

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
}

export class OpenAiAgent implements Agent {
  private readonly maxIters: number;
  private readonly opts: OpenAiAgentOptions;

  constructor(opts: OpenAiAgentOptions) {
    this.opts = opts;
    this.maxIters = opts.maxToolIterations ?? 5;
  }

  async respond(userText: string): Promise<AgentResponse> {
    const { mcp, session, model, llmClient } = this.opts;

    let previousResponseId = session.begin();
    // Send `instructions` (system prompt + profile) only when starting a
    // fresh chain. Within a chain OpenAI keeps the original instructions
    // alongside the rest of the conversation state.
    const isFreshChain = previousResponseId === undefined;
    const instructions = isFreshChain ? this.buildSystemMessage() : undefined;

    const mcpTools = mcpToolsToOpenAi(await mcp.listTools());
    const tools = [
      ...mcpTools,
      ...buildMemoryTools(),
      ...buildReminderTools(),
      ...buildTimerTools(),
      buildAskTool(),
      buildTelegramTool(),
    ].map((t) => ({ ...t, strict: t.strict ?? null }));

    // If the previous turn ended with an `ask` tool call, the API still has
    // an open function_call that needs a function_call_output. Submit the
    // user's answer as that output instead of a plain user message.
    let nextInput: ResponseInputItem[];
    const pendingAskCallId = session.pendingAskCallId;
    if (pendingAskCallId) {
      session.pendingAskCallId = undefined;
      nextInput = [{ type: 'function_call_output', call_id: pendingAskCallId, output: userText }];
    } else {
      nextInput = [{ role: 'user', content: userText }];
    }

    for (let i = 0; i < this.maxIters; i++) {
      const response = await llmClient.responses.parse({
        model,
        ...(instructions !== undefined && i === 0 ? { instructions } : {}),
        input: nextInput,
        tools: tools.length > 0 ? tools : undefined,
        store: true,
        previous_response_id: previousResponseId,
        text: { format: (this.opts.textFormat ?? VOICE_TEXT_FORMAT) as typeof VOICE_TEXT_FORMAT },
      });

      if (response.output_parsed != null) {
        session.commit(response.id);
        return {
          text: response.output_parsed.speak ?? '',
          direction: response.output_parsed.direction ?? null,
        };
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
          process.stderr.write(`[tool] ask(${JSON.stringify(args)}) → reopen capture\n`);
          session.pendingAskCallId = askCall.call_id;
          session.commit(response.id);
          return { text, direction: null, expectsFollowUp: true };
        }

        const toolOutputs: ResponseInputItem[] = [];
        for (const tc of fnCalls) {
          const args = this.parseArgs(tc.arguments);
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
          } else if (REMINDER_TOOL_NAMES.has(tc.name)) {
            try {
              const r = executeReminderTool(this.opts.memory.reminders, tc.name, args);
              resultText = JSON.stringify(r);
            } catch (e) {
              resultText = e instanceof Error ? e.message : String(e);
              isError = true;
            }
          } else if (TIMER_TOOL_NAMES.has(tc.name)) {
            try {
              const r = executeTimerTool(this.opts.memory.timers, tc.name, args);
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
            const result = await mcp.callTool(tc.name, args);
            resultText = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
            isError = result.isError;
          }
          const argsStr = JSON.stringify(args);
          const tag = isError ? 'tool✗' : 'tool';
          process.stderr.write(`[${tag}] ${tc.name}(${argsStr}) → ${resultText}\n`);
          toolOutputs.push({
            type: 'function_call_output',
            call_id: tc.call_id,
            output: isError ? `ERROR: ${resultText}` : resultText,
          });
        }
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
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const nowLocal = new Intl.DateTimeFormat('sv-SE', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: tzName,
      timeZoneName: 'longOffset',
    })
      .format(new Date(nowMs))
      .replace(',', '');
    // Give the LLM a direct formula so it doesn't need to do timezone math.
    const timeBlock =
      `\n\nCurrent time: ${nowUtcIso} UTC = ${nowLocal} (timezone: ${tzName}).` +
      ` Unix ms now: ${nowMs}.` +
      ` For add_reminder: fire_at = ${nowMs} + (seconds_from_now × 1000). Do NOT do timezone arithmetic — just add milliseconds to Unix ms now.`;
    if (Object.keys(profile).length === 0) return base + timeBlock;
    return `${base}${timeBlock}\n\nKnown user profile: ${JSON.stringify(profile)}`;
  }

  private parseArgs(raw: string | undefined): Record<string, unknown> {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }
}
