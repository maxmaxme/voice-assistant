import { describe, it, expect, vi } from 'vitest';
import { OpenAiAgent } from '../../src/agent/openaiAgent.js';
import { ConversationStore } from '../../src/agent/conversationStore.js';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.js';
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

  it('rolls back history when the LLM call throws mid-turn', async () => {
    const store = new ConversationStore({ idleTimeoutMs: 60_000, maxMessages: 20 });
    const llm = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('boom')),
        },
      },
    };
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      store,
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
    });
    const before = store.length();
    await expect(agent.respond('hi')).rejects.toThrow(/boom/);
    expect(store.length()).toBe(before);
  });

  it('routes memory-tool calls to MemoryAdapter, not MCP', async () => {
    const mcp = fakeMcp();
    const memory = new SqliteProfileMemory({ dbPath: ':memory:' });
    const llm = fakeLlm([
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'mem_1',
                  type: 'function',
                  function: {
                    name: 'remember',
                    arguments: '{"key":"name","value":"Maxim"}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ message: { role: 'assistant', content: 'Got it.' } }],
      },
    ]);
    const agent = new OpenAiAgent({
      mcp,
      memory,
      store: new ConversationStore({ idleTimeoutMs: 60_000, maxMessages: 20 }),
      systemPrompt: 'You are helpful.',
      model: 'gpt-4o',
      llmClient: llm as never,
    });
    const res = await agent.respond('меня зовут Максим');
    expect(res.text).toBe('Got it.');
    expect(memory.recall()).toEqual({ name: 'Maxim' });
    expect(mcp.callTool).not.toHaveBeenCalled();
    memory.close();
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
