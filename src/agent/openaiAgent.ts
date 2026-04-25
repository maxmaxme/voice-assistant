import type OpenAI from 'openai';
import type { Agent, AgentResponse, Message } from './types.ts';
import type { McpClient } from '../mcp/types.ts';
import type { MemoryAdapter } from '../memory/types.ts';
import { ConversationStore } from './conversationStore.ts';
import { mcpToolsToOpenAi } from './toolBridge.ts';
import { MEMORY_TOOL_NAMES, buildMemoryTools, executeMemoryTool } from './memoryTools.ts';
import { ASK_TOOL_NAME, buildAskTool } from './askTool.ts';
import { TELEGRAM_TOOL_NAME, buildTelegramTool, executeTelegramTool } from './telegramTool.ts';
import type { TelegramSender } from '../telegram/types.ts';

export interface OpenAiAgentOptions {
  mcp: McpClient;
  memory: MemoryAdapter;
  store: ConversationStore;
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
    const { mcp, store, model, llmClient } = this.opts;

    const snapshot = store.length();
    try {
      store.replaceSystem(this.buildSystemMessage());
      store.append({ role: 'user', content: userText });

      const mcpTools = mcpToolsToOpenAi(await mcp.listTools());
      const tools = [...mcpTools, ...buildMemoryTools(), buildAskTool(), buildTelegramTool()];

      for (let i = 0; i < this.maxIters; i++) {
      const completion = await llmClient.chat.completions.create({
        model,
        messages: this.toOpenAi(store.history()),
        tools: tools.length > 0 ? tools : undefined,
      });
      const choice = completion.choices[0].message;

      const fnCalls = (choice.tool_calls ?? []).filter(
        (tc: { type?: string }): tc is { id: string; type: 'function'; function: { name: string; arguments: string } } =>
          tc.type === 'function' || (tc as { function?: unknown }).function !== undefined,
      );
      if (fnCalls.length > 0) {
        // Special-case the `ask` tool: it's terminal — calling it ends the
        // agent turn with the question text as the final reply, signalling
        // that the orchestrator should reopen capture for the user's answer.
        const askCall = fnCalls.find((tc) => tc.function.name === ASK_TOOL_NAME);
        if (askCall) {
          const args = this.parseArgs(askCall.function.arguments);
          const text = typeof args.text === 'string' ? args.text : '';
          process.stderr.write(`[tool] ask(${JSON.stringify(args)}) → reopen capture\n`);
          store.append({ role: 'assistant', content: text });
          return { text, expectsFollowUp: true };
        }

        store.append({
          role: 'assistant',
          content: choice.content ?? '',
          toolCalls: fnCalls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: this.parseArgs(tc.function.arguments),
          })),
        });
        for (const tc of fnCalls) {
          const args = this.parseArgs(tc.function.arguments);
          let resultText: string;
          let isError = false;
          if (MEMORY_TOOL_NAMES.has(tc.function.name)) {
            try {
              const r = executeMemoryTool(this.opts.memory, tc.function.name, args);
              resultText = JSON.stringify(r);
            } catch (e) {
              resultText = e instanceof Error ? e.message : String(e);
              isError = true;
            }
          } else if (tc.function.name === TELEGRAM_TOOL_NAME) {
            try {
              const r = await executeTelegramTool(this.opts.telegram, args);
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
          // Make tool calls visible.
          const argsStr = JSON.stringify(args);
          const tag = isError ? 'tool✗' : 'tool';
          process.stderr.write(`[${tag}] ${tc.function.name}(${argsStr}) → ${resultText}\n`);
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
    } catch (err) {
      store.truncateTo(snapshot);
      throw err;
    }
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
