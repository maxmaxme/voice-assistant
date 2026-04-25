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
    // Snapshot before mutating so we can roll back the whole turn on error.
    const snapshot = store.length();
    try {
      store.append({ role: 'user', content: userText });

      const tools = mcpToolsToOpenAi(await mcp.listTools());

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
              arguments: JSON.parse(tc.function.arguments || '{}'),
            })),
          });
          for (const tc of fnCalls) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments || '{}');
            } catch {
              args = {};
            }
            const result = await mcp.callTool(tc.function.name, args);
            const text = result.content
              .map((c) => (c.type === 'text' ? c.text ?? '' : ''))
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
    } catch (err) {
      // Roll back any partial turn so the next call sees a clean history.
      store.truncateTo(snapshot);
      throw err;
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
