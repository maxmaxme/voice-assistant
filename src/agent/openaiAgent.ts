import type OpenAI from 'openai';
import type { Agent, AgentResponse, Message } from './types.ts';
import type { McpClient } from '../mcp/types.ts';
import type { MemoryAdapter } from '../memory/types.ts';
import { ConversationStore } from './conversationStore.ts';
import { mcpToolsToOpenAi } from './toolBridge.ts';
import { MEMORY_TOOL_NAMES, buildMemoryTools, executeMemoryTool } from './memoryTools.ts';

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
      const tools = this.opts.memory ? [...mcpTools, ...buildMemoryTools()] : mcpTools;

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
    } catch (err) {
      store.truncateTo(snapshot);
      throw err;
    }
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
