import type OpenAI from 'openai';
import type { ResponseInputItem, ResponseOutputItem } from 'openai/resources/responses/responses';
import type { Agent, AgentResponse } from './types.ts';
import type { McpClient } from '../mcp/types.ts';
import type { MemoryAdapter } from '../memory/types.ts';
import { Session } from './session.ts';
import { mcpToolsToOpenAi } from './toolBridge.ts';
import { MEMORY_TOOL_NAMES, buildMemoryTools, executeMemoryTool } from './memoryTools.ts';
import { ASK_TOOL_NAME, buildAskTool } from './askTool.ts';
import { TELEGRAM_TOOL_NAME, buildTelegramTool, executeTelegramTool } from './telegramTool.ts';
import type { TelegramSender } from '../telegram/types.ts';

export interface OpenAiAgentOptions {
  mcp: McpClient;
  memory: MemoryAdapter;
  session: Session;
  systemPrompt: string;
  model: string;
  maxToolIterations?: number;
  llmClient: OpenAI;
  telegram: TelegramSender;
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
    const tools = [...mcpTools, ...buildMemoryTools(), buildAskTool(), buildTelegramTool()].map(
      (t) => ({ ...t, strict: t.strict ?? null }),
    );

    let nextInput: ResponseInputItem[] = [{ role: 'user', content: userText }];

    for (let i = 0; i < this.maxIters; i++) {
      const response = await llmClient.responses.create({
        model,
        ...(instructions !== undefined && i === 0 ? { instructions } : {}),
        input: nextInput,
        tools: tools.length > 0 ? tools : undefined,
        store: true,
        previous_response_id: previousResponseId,
      });

      const output: ResponseOutputItem[] = response.output ?? [];
      const fnCalls = output.filter(
        (it): it is Extract<ResponseOutputItem, { type: 'function_call' }> =>
          it.type === 'function_call',
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
          session.commit(response.id);
          return { text, expectsFollowUp: true };
        }

        const toolOutputs: ResponseInputItem[] = [];
        for (const tc of fnCalls) {
          const args = this.parseArgs(tc.arguments);
          let resultText: string;
          let isError = false;
          if (MEMORY_TOOL_NAMES.has(tc.name)) {
            try {
              const r = executeMemoryTool(this.opts.memory, tc.name, args);
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
          // Make tool calls visible.
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

      const finalText =
        (response as { output_text?: string }).output_text ?? this.extractAssistantText(output);
      session.commit(response.id);
      return { text: finalText };
    }

    throw new Error('Agent exceeded max tool iterations');
  }

  private buildSystemMessage(): string {
    const base = this.opts.systemPrompt;
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

  /** Pull the assistant's plain text out of a Responses `output` array. */
  private extractAssistantText(output: ResponseOutputItem[]): string {
    const parts: string[] = [];
    for (const item of output) {
      if (item.type !== 'message') continue;
      for (const c of item.content) {
        if (c.type === 'output_text') parts.push(c.text);
      }
    }
    return parts.join('');
  }
}
