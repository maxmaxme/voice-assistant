import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import { OpenAiAgent } from '../../src/agent/openaiAgent.ts';
import { Session } from '../../src/agent/session.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';
import type { McpClient } from '../../src/mcp/types.ts';
import type { MemoryStore } from '../../src/memory/types.ts';
import type { TelegramSender } from '../../src/telegram/types.ts';

const noopTelegram: TelegramSender = { send: async () => {} };

/** A no-op MemoryStore for tests that don't care about memory state. */
function emptyMemory(): MemoryStore {
  const noopScheduledActions = {
    add: () => {
      throw new Error('not used');
    },
    listActive: () => [],
    listDue: () => [],
    markFired: () => {},
    markError: () => {},
    cancel: () => false,
    get: () => null,
  };
  return {
    profile: {
      remember: () => {},
      recall: () => ({}),
      forget: () => {},
      close: () => {},
    },
    scheduledActions: noopScheduledActions,
    close: () => {},
  };
}

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

interface CreateArgs {
  instructions?: string;
  previous_response_id?: string;
  input: Array<Record<string, unknown>>;
}

function fakeLlm(scripted: Array<unknown>) {
  let i = 0;
  const calls: CreateArgs[] = [];
  const create = vi.fn(async (args: CreateArgs) => {
    calls.push(args);
    return scripted[i++];
  });
  return {
    calls,
    responses: {
      create,
      // responses.parse is a SDK helper wrapping create; reuse the same mock.
      // extractParsedOutput falls back to parseAgentOutput when parsed is absent.
      parse: create,
    },
  };
}

function textResponse(
  speak: string,
  id = `resp_${Math.random().toString(36).slice(2, 8)}`,
  direction: 'on' | 'off' | 'neutral' | null = null,
) {
  const output_parsed = { speak, direction };
  return {
    id,
    output_parsed,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify(output_parsed) }],
      },
    ],
  };
}

function silentConfirmResponse(
  direction: 'on' | 'off' | 'neutral',
  id = `resp_${Math.random().toString(36).slice(2, 8)}`,
) {
  return textResponse('', id, direction);
}

function fnCallResponse(
  name: string,
  args: string,
  callId = `call_${name}`,
  id = `resp_${callId}`,
) {
  return {
    id,
    output: [
      {
        type: 'function_call',
        call_id: callId,
        name,
        arguments: args,
      },
    ],
    output_text: '',
  };
}

describe('OpenAiAgent', () => {
  it('returns assistant text when no tool calls', async () => {
    const llm = fakeLlm([textResponse('Hi there', 'resp_1')]);
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'You are helpful.',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    const res = await agent.respond('hello');
    expect(res.text).toBe('Hi there');
    expect(res.direction).toBeNull();
    expect(llm.responses.create).toHaveBeenCalledOnce();
    const args = llm.calls[0]!;
    // First call in a fresh session sends instructions and no previous_response_id.
    expect(args.instructions).toContain('You are helpful.');
    expect(args.previous_response_id).toBeUndefined();
  });

  it('chains the next turn via previous_response_id', async () => {
    const llm = fakeLlm([textResponse('Hi', 'resp_1'), textResponse('Hi again', 'resp_2')]);
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    await agent.respond('one');
    await agent.respond('two');
    const second = llm.calls[1]!;
    expect(second.previous_response_id).toBe('resp_1');
    // Within an established chain we don't resend instructions.
    expect(second.instructions).toBeUndefined();
  });

  it('runs tool-call loop and returns final text', async () => {
    const mcp = fakeMcp();
    const llm = fakeLlm([
      fnCallResponse('HassTurnOn', '{"name":"Test Lamp"}', 'call_1', 'resp_1'),
      textResponse('Lamp is on.', 'resp_2'),
    ]);
    const agent = new OpenAiAgent({
      mcp,
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'You are helpful.',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    const res = await agent.respond('turn on the lamp');
    expect(res.text).toBe('Lamp is on.');
    expect(res.direction).toBeNull();
    expect(mcp.callTool).toHaveBeenCalledWith('HassTurnOn', { name: 'Test Lamp' });
    // Second call (the tool-result loop) chains from the function_call response id.
    const second = llm.calls[1]!;
    expect(second.previous_response_id).toBe('resp_1');
    expect(second.input[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_1',
    });
  });

  it('does not advance session.previous_response_id when LLM call throws', async () => {
    const session = new Session({ idleTimeoutMs: 60_000 });
    const rejectFn = vi.fn().mockRejectedValue(new Error('boom'));
    const llm = {
      responses: { create: rejectFn, parse: rejectFn },
    };
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session,
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    await expect(agent.respond('hi')).rejects.toThrow(/boom/);
    expect(session.isFresh()).toBe(true);
  });

  it('routes memory-tool calls to MemoryAdapter, not MCP', async () => {
    const mcp = fakeMcp();
    const profile = new SqliteProfileMemory({ dbPath: ':memory:' });
    const memory: MemoryStore = {
      ...emptyMemory(),
      profile,
      close: () => profile.close(),
    };
    const llm = fakeLlm([
      fnCallResponse('remember', '{"key":"name","value":"Maxim"}', 'mem_1', 'resp_1'),
      textResponse('Got it.', 'resp_2'),
    ]);
    const agent = new OpenAiAgent({
      mcp,
      memory,
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'You are helpful.',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    const res = await agent.respond('my name is Maxim');
    expect(res.text).toBe('Got it.');
    expect(res.direction).toBeNull();
    expect(profile.recall()).toEqual({ name: 'Maxim' });
    expect(mcp.callTool).not.toHaveBeenCalled();
    memory.close();
  });

  it('ask tool ends the turn and sets expectsFollowUp=true', async () => {
    const mcp = fakeMcp();
    const llm = fakeLlm([
      fnCallResponse(
        'ask',
        '{"text":"Where should I turn it on — in the kitchen or bedroom?"}',
        'ask_1',
        'resp_1',
      ),
    ]);
    const agent = new OpenAiAgent({
      mcp,
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    const res = await agent.respond('turn on the light');
    expect(res.text).toBe('Where should I turn it on — in the kitchen or bedroom?');
    expect(res.direction).toBeNull();
    expect(res.expectsFollowUp).toBe(true);
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(llm.responses.create).toHaveBeenCalledOnce();
  });

  it('returns direction from silent confirm JSON response', async () => {
    const mcp = fakeMcp();
    const llm = fakeLlm([
      fnCallResponse('HassTurnOn', '{"name":"Test Lamp"}', 'call_1', 'resp_1'),
      silentConfirmResponse('on', 'resp_2'),
    ]);
    const agent = new OpenAiAgent({
      mcp,
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    const res = await agent.respond('turn on the lamp');
    expect(res.text).toBe('');
    expect(res.direction).toBe('on');
  });

  it('strips <title=...> API artifact from speak text', async () => {
    const raw =
      'I can help with these tasks!\n<title="Small debut": The debut of personal devices control>';
    const llm = fakeLlm([textResponse(raw, 'resp_title')]);
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    const res = await agent.respond('what can you do?');
    expect(res.text).toBe('I can help with these tasks!');
    expect(res.text).not.toContain('<title=');
  });

  it('leaves normal text untouched when no API artifact present', async () => {
    const llm = fakeLlm([textResponse('All good.', 'resp_clean')]);
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    const res = await agent.respond('how are you?');
    expect(res.text).toBe('All good.');
  });

  it('throws after max iterations to avoid infinite tool-loops', async () => {
    const looping = fnCallResponse('HassTurnOn', '{}', 'c', 'resp_loop');
    const llm = fakeLlm([looping, looping, looping, looping, looping, looping]);
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 's',
      model: 'gpt-4o',
      maxToolIterations: 3,
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    await expect(agent.respond('x')).rejects.toThrow(/max tool iterations/i);
  });

  describe('goal mode', () => {
    it('runs a goal end-to-end and returns the final text', async () => {
      const llm = fakeLlm([textResponse('I turned the kitchen lights on', 'resp_1')]);
      const agent = new OpenAiAgent({
        mcp: fakeMcp(),
        memory: emptyMemory(),
        session: new Session({ idleTimeoutMs: 60_000 }),
        systemPrompt: 'You are helpful.',
        model: 'gpt-4o',
        llmClient: llm as never,
        telegram: noopTelegram,
        mode: 'goal',
      });
      const res = await agent.respond('turn on the kitchen light');
      expect(res.text).toBe('I turned the kitchen lights on');
      const args = llm.calls[0]!;
      expect(typeof args.instructions).toBe('string');
      expect(args.instructions).toContain('turn on the kitchen light');
      expect(args.instructions).toMatch(/scheduled goal|NO USER PRESENT/);
      // Must not contain chat-mode-only profile directive when chat would
      // (in chat mode the system message ends after the time block when no
      // profile is set; goal mode appends additional directive text).
      expect(args.instructions).toContain('previously-scheduled goal');
    });

    it('omits the ask tool from the tools array in goal mode', async () => {
      const llm = fakeLlm([textResponse('ok', 'resp_1')]);
      const agent = new OpenAiAgent({
        mcp: fakeMcp(),
        memory: emptyMemory(),
        session: new Session({ idleTimeoutMs: 60_000 }),
        systemPrompt: 'sys',
        model: 'gpt-4o',
        llmClient: llm as never,
        telegram: noopTelegram,
        mode: 'goal',
      });
      await agent.respond('do it');
      const callArgs = llm.calls[0]! as unknown as {
        tools?: Array<{ name: string }>;
      };
      const tools = callArgs.tools ?? [];
      expect(tools.find((t) => t.name === 'ask')).toBeUndefined();
    });

    it('does not chain across calls in goal mode (every call sends instructions, no previous_response_id)', async () => {
      const llm = fakeLlm([textResponse('one', 'resp_1'), textResponse('two', 'resp_2')]);
      const agent = new OpenAiAgent({
        mcp: fakeMcp(),
        memory: emptyMemory(),
        session: new Session({ idleTimeoutMs: 60_000 }),
        systemPrompt: 'sys',
        model: 'gpt-4o',
        llmClient: llm as never,
        telegram: noopTelegram,
        mode: 'goal',
      });
      await agent.respond('goal one');
      await agent.respond('goal two');
      expect(llm.calls[0]!.previous_response_id).toBeUndefined();
      expect(llm.calls[0]!.instructions).toBeDefined();
      expect(llm.calls[1]!.previous_response_id).toBeUndefined();
      expect(llm.calls[1]!.instructions).toBeDefined();
      expect(llm.calls[1]!.instructions).toContain('goal two');
    });
  });

  it('routes schedule_action to the scheduledActions adapter', async () => {
    const added: Array<{ goal: string }> = [];
    const memory = emptyMemory();
    const now = Date.now();
    memory.scheduledActions = {
      ...memory.scheduledActions,
      add: ({ goal, schedule, nextFireAt }) => {
        added.push({ goal });
        return {
          id: 1,
          goal,
          schedule,
          nextFireAt,
          status: 'active',
          createdAt: now,
          lastFiredAt: null,
        };
      },
    };

    const llm = fakeLlm([
      fnCallResponse(
        'schedule_action',
        JSON.stringify({
          goal: 'call mom',
          schedule_kind: 'once',
          schedule_expr: '2099-01-01 09:00',
        }),
      ),
      textResponse('Scheduled.'),
    ]);
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory,
      session: new Session(),
      systemPrompt: 'test',
      model: 'gpt-4o',
      llmClient: llm as unknown as OpenAI,
      telegram: noopTelegram,
    });
    const result = await agent.respond('schedule a call to mom');
    expect(result.text).toBe('Scheduled.');
    expect(added).toHaveLength(1);
    expect(added[0].goal).toBe('call mom');
  });
});

describe('OpenAiAgent — OPENAI_WEB_SEARCH hosted tool', () => {
  const original = process.env.OPENAI_WEB_SEARCH;
  beforeEach(() => {
    delete process.env.OPENAI_WEB_SEARCH;
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env.OPENAI_WEB_SEARCH;
    } else {
      process.env.OPENAI_WEB_SEARCH = original;
    }
  });

  function makeAgent(llm: ReturnType<typeof fakeLlm>, mode: 'chat' | 'goal' = 'chat') {
    return new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as unknown as OpenAI,
      telegram: noopTelegram,
      mode,
    });
  }

  it('does NOT include web_search in tools by default', async () => {
    const llm = fakeLlm([textResponse('hi', 'r1')]);
    const agent = makeAgent(llm);
    await agent.respond('hello');
    const callArgs = llm.calls[0]! as unknown as { tools?: Array<{ type: string }> };
    const tools = callArgs.tools ?? [];
    expect(tools.find((t) => t.type === 'web_search')).toBeUndefined();
  });

  it('includes web_search when OPENAI_WEB_SEARCH=1 (chat mode)', async () => {
    process.env.OPENAI_WEB_SEARCH = '1';
    const llm = fakeLlm([textResponse('hi', 'r1')]);
    const agent = makeAgent(llm);
    await agent.respond('what is the weather in Madrid');
    const callArgs = llm.calls[0]! as unknown as { tools?: Array<{ type: string }> };
    const tools = callArgs.tools ?? [];
    expect(tools.find((t) => t.type === 'web_search')).toBeDefined();
  });

  it('includes web_search when OPENAI_WEB_SEARCH=1 (goal mode)', async () => {
    process.env.OPENAI_WEB_SEARCH = '1';
    const llm = fakeLlm([textResponse('done', 'r1')]);
    const agent = makeAgent(llm, 'goal');
    await agent.respond('check Madrid weather and tell me');
    const callArgs = llm.calls[0]! as unknown as { tools?: Array<{ type: string }> };
    const tools = callArgs.tools ?? [];
    expect(tools.find((t) => t.type === 'web_search')).toBeDefined();
  });
});
