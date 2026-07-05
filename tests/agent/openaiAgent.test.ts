import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';
import { OpenAiAgent } from '../../src/agent/openaiAgent.ts';
import { PENDING_ASK_TTL_MS, Session } from '../../src/agent/session.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';
import { IdentitiesStore } from '../../src/memory/identities.ts';
import { SqliteSettings } from '../../src/settings/sqliteSettings.ts';
import { SqliteRuntimeState } from '../../src/settings/sqliteRuntimeState.ts';
import { SqlitePrompts } from '../../src/settings/sqlitePrompts.ts';
import { SqliteIntegrations } from '../../src/integrations/sqliteIntegrations.ts';
import type { McpClient } from '../../src/mcp/types.ts';
import type { MemoryStore } from '../../src/memory/types.ts';
import type { TelegramSender } from '../../src/telegram/types.ts';
import { freshTestDb } from '../memory/helpers.ts';

const noopSender: TelegramSender = { send: async () => {} };
const noopTelegram = { senderFor: () => noopSender };

/** A no-op MemoryStore for tests that don't care about memory state. */
function emptyMemory(): MemoryStore {
  const noopScheduledActions = {
    add: () => {
      throw new Error('not used');
    },
    listActiveForOwner: () => [],
    listDue: () => [],
    markFired: () => {},
    markError: () => {},
    cancel: () => false,
    get: () => null,
  };
  const { db } = freshTestDb();
  const profileStore = new SqliteProfileMemory(db);
  const identities = new IdentitiesStore(db);
  return {
    profile: {
      remember: () => {},
      recall: () => ({}),
      forget: () => {},
      close: () => {},
    },
    profileStore,
    identities,
    scheduledActions: noopScheduledActions,
    telegramSessions: {
      get: () => null,
      save: () => {},
      delete: () => {},
    },
    settings: new SqliteSettings(db),
    runtimeState: new SqliteRuntimeState(db),
    prompts: new SqlitePrompts(db),
    integrations: new SqliteIntegrations(db),
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
  tools?: Array<Record<string, unknown>>;
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
    responses: { create },
  };
}

function textResponse(text: string, id = `resp_${Math.random().toString(36).slice(2, 8)}`) {
  return {
    id,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    output_text: text,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
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

  it('recovers from a stale previous_response_id by resetting the chain and retrying', async () => {
    // Custom fakeLlm that throws a 404 on the first call (with previous_response_id),
    // then succeeds on the retry (without previous_response_id).
    const calls: CreateArgs[] = [];
    let i = 0;
    const create = vi.fn(async (args: CreateArgs) => {
      calls.push(args);
      if (i++ === 0) {
        const err = new Error("Previous response with id 'resp_old' not found.") as Error & {
          status?: number;
        };
        err.status = 404;
        throw err;
      }
      return textResponse('Hi after reset', 'resp_fresh');
    });
    const llm = { calls, responses: { create } };
    const session = new Session({ idleTimeoutMs: 60_000 });
    // Simulate a session that has a stored, now-stale chain id.
    session.commit('resp_old');
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session,
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    const res = await agent.respond('hello');
    expect(res.text).toBe('Hi after reset');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.previous_response_id).toBe('resp_old');
    expect(calls[1]!.previous_response_id).toBeUndefined();
    // The retry must resend instructions (fresh chain).
    expect(calls[1]!.instructions).toContain('sys');
    // Session is committed to the new id.
    expect(session.isFresh()).toBe(false);
  });

  it('404 recovery with a pending ask retries as a plain user turn (no orphaned tool outputs)', async () => {
    const calls: CreateArgs[] = [];
    let i = 0;
    const create = vi.fn(async (args: CreateArgs) => {
      calls.push(args);
      if (i++ === 0) {
        const err = new Error("Previous response with id 'resp_old' not found.") as Error & {
          status?: number;
        };
        err.status = 404;
        throw err;
      }
      return textResponse('Hi after reset', 'resp_fresh');
    });
    const llm = { calls, responses: { create } };
    const session = new Session({ idleTimeoutMs: 60_000 });
    // A stale chain that ended in an ask with a sibling tool output stashed.
    session.commit('resp_old');
    session.pendingAskCallId = 'ask_1';
    session.pendingAskExpiresAt = Date.now() + PENDING_ASK_TTL_MS;
    session.pendingToolOutputs = [{ callId: 'mem_1', output: 'ok' }];
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session,
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });

    const res = await agent.respond('my answer');
    expect(res.text).toBe('Hi after reset');
    const retry = calls[1]!;
    expect(retry.previous_response_id).toBeUndefined();
    // The dropped chain has no open function_call on OpenAI's side — sending
    // the stale ask/tool outputs into a fresh chain 400s ("No tool call found
    // for function call output"). The retry must be a plain user turn.
    expect(retry.input).toEqual([{ role: 'user', content: 'my answer' }]);
    expect(session.pendingAskCallId).toBeUndefined();
    expect(session.pendingToolOutputs).toBeUndefined();
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
      responses: { create: rejectFn },
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
    const profile = new SqliteProfileMemory(freshTestDb().db);
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
    expect(profile.recall()).toEqual({ name: 'Maxim' });
    expect(mcp.callTool).not.toHaveBeenCalled();
    memory.close();
  });

  it('omits the ask tool when enableAsk=false (Telegram / chat REPL channels)', async () => {
    const llm = fakeLlm([textResponse('Hi', 'resp_1')]);
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
      enableAsk: false,
    });
    await agent.respond('hello');
    const tools = llm.calls[0]!.tools ?? [];
    expect(tools.find((t) => t.name === 'ask')).toBeUndefined();
  });

  it('keeps the ask tool when enableAsk=true (HTTP / Voice PE bridge)', async () => {
    const llm = fakeLlm([textResponse('Hi', 'resp_1')]);
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
      enableAsk: true,
    });
    await agent.respond('hello');
    const tools = llm.calls[0]!.tools ?? [];
    expect(tools.find((t) => t.name === 'ask')).toBeDefined();
  });

  it('treats a pending ask as expired after PENDING_ASK_TTL_MS — closes call_id with placeholder and sends user message as new turn', async () => {
    const session = new Session({ idleTimeoutMs: 60_000 });
    // Stash a stale ask manually — simulates a previous turn that called
    // ask but the user took too long to reply.
    session.commit('resp_old');
    session.pendingAskCallId = 'ask_stale';
    session.pendingAskExpiresAt = Date.now() - 1_000;
    const llm = fakeLlm([textResponse('Sure, will do.', 'resp_new')]);
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session,
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    await agent.respond('turn off the light');
    const input = llm.calls[0]!.input as Array<Record<string, unknown>>;
    // Two items: the placeholder closing the stale ask, then the user's
    // new request as a normal role:user message.
    expect(input).toHaveLength(2);
    expect(input[0]).toMatchObject({ type: 'function_call_output', call_id: 'ask_stale' });
    expect(input[0]!.output as string).toMatch(/no response/i);
    expect(input[1]).toMatchObject({ role: 'user', content: 'turn off the light' });
    expect(session.pendingAskCallId).toBeUndefined();
    expect(session.pendingAskExpiresAt).toBeUndefined();
  });

  it('restores pending ask state when the OpenAI call fails — the retry still answers the ask', async () => {
    const session = new Session({ idleTimeoutMs: 60_000 });
    session.commit('resp_prev');
    session.pendingAskCallId = 'ask_1';
    session.pendingAskExpiresAt = Date.now() + PENDING_ASK_TTL_MS;
    session.pendingToolOutputs = [{ callId: 'mem_1', output: 'ok' }];

    const boom = vi.fn().mockRejectedValue(new Error('network down'));
    const failing = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session,
      systemPrompt: 'You are helpful.',
      model: 'gpt-4o',
      llmClient: { responses: { create: boom } } as never,
      telegram: noopTelegram,
    });
    await expect(failing.respond('my answer')).rejects.toThrow('network down');

    // The ask is still open on OpenAI's side (no response succeeded), so the
    // session must keep it — otherwise the next turn sends a plain user
    // message into a chain with an unanswered function_call and 400s.
    expect(session.pendingAskCallId).toBe('ask_1');
    expect(session.pendingToolOutputs).toEqual([{ callId: 'mem_1', output: 'ok' }]);

    // Retry with a working client: the ask output is replayed.
    const llm = fakeLlm([textResponse('done', 'resp_2')]);
    const retrying = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session,
      systemPrompt: 'You are helpful.',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    await retrying.respond('my answer');
    const input = llm.calls[0]!.input;
    const callIds = input
      .filter((it) => it.type === 'function_call_output')
      .map((it) => it.call_id);
    expect(callIds).toEqual(expect.arrayContaining(['mem_1', 'ask_1']));
  });

  it('sets pendingAskExpiresAt when ask fires', async () => {
    const llm = fakeLlm([fnCallResponse('ask', '{"text":"Where?"}', 'ask_x', 'resp_x')]);
    const session = new Session({ idleTimeoutMs: 60_000 });
    const before = Date.now();
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session,
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });
    await agent.respond('turn it on');
    expect(session.pendingAskExpiresAt).toBeGreaterThanOrEqual(before + PENDING_ASK_TTL_MS);
    expect(session.pendingAskExpiresAt).toBeLessThanOrEqual(Date.now() + PENDING_ASK_TTL_MS);
  });

  it('ask emitted in parallel with other tools: executes the others, stashes their outputs, replays on next turn', async () => {
    const mcp = fakeMcp();
    const llm = fakeLlm([
      // Turn 1: model emits remember + ask in parallel.
      {
        id: 'resp_1',
        output: [
          {
            type: 'function_call',
            call_id: 'mem_1',
            name: 'remember',
            arguments: '{"key":"dog_name","value":"Pizza"}',
          },
          {
            type: 'function_call',
            call_id: 'ask_1',
            name: 'ask',
            arguments: '{"text":"What is your favourite temperature?"}',
          },
        ],
        output_text: '',
      },
      // Turn 2: after the user answers, model finalises with text.
      textResponse('Got it.', 'resp_2'),
    ]);
    const profile = new SqliteProfileMemory(freshTestDb().db);
    const memory: MemoryStore = {
      ...emptyMemory(),
      profile,
      close: () => profile.close(),
    };
    const session = new Session({ idleTimeoutMs: 60_000 });
    const agent = new OpenAiAgent({
      mcp,
      memory,
      session,
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: noopTelegram,
    });

    const first = await agent.respond('remember my dog');
    expect(first.text).toBe('What is your favourite temperature?');
    expect(first.expectsFollowUp).toBe(true);
    // Non-ask tool actually executed.
    expect(memory.profile.recall()).toEqual({ dog_name: 'Pizza' });
    // Both call_ids are queued on the session.
    expect(session.pendingAskCallId).toBe('ask_1');
    expect(session.pendingToolOutputs).toEqual([{ callId: 'mem_1', output: expect.any(String) }]);

    const second = await agent.respond('22 degrees');
    expect(second.text).toBe('Got it.');
    // Next API call sent BOTH function_call_outputs.
    const call = llm.calls[1]!;
    const callIds = (call.input as Array<{ call_id?: string }>).map((it) => it.call_id);
    expect(callIds).toEqual(expect.arrayContaining(['mem_1', 'ask_1']));
    // Session is cleared.
    expect(session.pendingAskCallId).toBeUndefined();
    expect(session.pendingToolOutputs).toBeUndefined();
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
    expect(res.expectsFollowUp).toBe(true);
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(llm.responses.create).toHaveBeenCalledOnce();
  });

  it('strips <title=...> API artifact from output text', async () => {
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

    it('omits ask / send_to_telegram / scheduled-action tools in goal mode', async () => {
      // A scheduled fire executes its goal; it must not re-plan (schedule/list/
      // cancel) or deliver itself (send_to_telegram — the goal runner owns
      // delivery to the author). ask is off too (no user present).
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
      const names = new Set((callArgs.tools ?? []).map((t) => t.name));
      expect(names.has('ask')).toBe(false);
      expect(names.has('send_to_telegram')).toBe(false);
      expect(names.has('schedule_action')).toBe(false);
      expect(names.has('list_scheduled')).toBe(false);
      expect(names.has('cancel_scheduled')).toBe(false);
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
    const added: Array<{ goal: string; ownerUserId: number }> = [];
    const memory = emptyMemory();
    // schedule_action requires an identified user with a Telegram chat.
    const uid = memory.identities.addUser('me');
    memory.identities.attachIdentity('telegram', '555', uid);
    const now = Date.now();
    memory.scheduledActions = {
      ...memory.scheduledActions,
      add: ({ goal, schedule, nextFireAt, ownerUserId }) => {
        added.push({ goal, ownerUserId });
        return {
          id: 1,
          goal,
          schedule,
          nextFireAt,
          status: 'active',
          createdAt: now,
          lastFiredAt: null,
          ownerUserId,
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
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'test',
      model: 'gpt-4o',
      llmClient: llm as unknown as OpenAI,
      telegram: noopTelegram,
    });
    const result = await agent.respond('schedule a call to mom', { scope: { userId: uid } });
    expect(result.text).toBe('Scheduled.');
    expect(added).toHaveLength(1);
    expect(added[0].goal).toBe('call mom');
    expect(added[0].ownerUserId).toBe(uid);
  });

  it('streams output text deltas through onTextDelta when provided', async () => {
    const finalResponse = textResponse('Hello there', 'resp_1');
    const stream = {
      on: vi.fn(),
      finalResponse: vi.fn().mockResolvedValue(finalResponse),
    };
    const create = vi.fn();
    const llm = { responses: { create, stream: vi.fn().mockReturnValue(stream) } };
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'You are helpful.',
      model: 'gpt-4o',
      llmClient: llm as unknown as OpenAI,
      telegram: noopTelegram,
    });

    const deltas: string[] = [];
    const reply = await agent.respond('hi', { onTextDelta: (d) => deltas.push(d) });

    expect(llm.responses.stream).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    // simulate what the SDK does: fire the registered delta listener
    const onDelta = stream.on.mock.calls.find(([ev]) => ev === 'response.output_text.delta')?.[1];
    expect(onDelta).toBeDefined();
    onDelta!({ delta: 'Hel' });
    onDelta!({ delta: 'lo' });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(reply.text).toBe('Hello there');
  });

  it('derives final text from message items when the stream response lacks output_text', async () => {
    // ResponseStream.finalResponse() only computes the SDK convenience field
    // `output_text` for auto-parseable requests; plain-text requests come back
    // without it. The agent must not depend on it.
    const finalResponse = textResponse('Привет! Чем могу помочь?', 'resp_1');
    delete (finalResponse as { output_text?: string }).output_text;
    const stream = {
      on: vi.fn(),
      finalResponse: vi.fn().mockResolvedValue(finalResponse),
    };
    const llm = { responses: { create: vi.fn(), stream: vi.fn().mockReturnValue(stream) } };
    const agent = new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'You are helpful.',
      model: 'gpt-4o',
      llmClient: llm as unknown as OpenAI,
      telegram: noopTelegram,
    });

    const reply = await agent.respond('привет', { onTextDelta: () => {} });

    expect(reply.text).toBe('Привет! Чем могу помочь?');
  });
});

describe('OpenAiAgent — web_search hosted tool', () => {
  function makeAgent(
    llm: ReturnType<typeof fakeLlm>,
    webSearch: boolean,
    mode: 'chat' | 'goal' = 'chat',
  ) {
    return new OpenAiAgent({
      mcp: fakeMcp(),
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'sys',
      model: 'gpt-4o',
      webSearch,
      llmClient: llm as unknown as OpenAI,
      telegram: noopTelegram,
      mode,
    });
  }

  it('does NOT include web_search in tools when disabled', async () => {
    const llm = fakeLlm([textResponse('hi', 'r1')]);
    await makeAgent(llm, false).respond('hello');
    const callArgs = llm.calls[0]! as unknown as { tools?: Array<{ type: string }> };
    expect((callArgs.tools ?? []).find((t) => t.type === 'web_search')).toBeUndefined();
  });

  it('includes web_search when enabled (chat mode)', async () => {
    const llm = fakeLlm([textResponse('hi', 'r1')]);
    await makeAgent(llm, true).respond('what is the weather in Madrid');
    const callArgs = llm.calls[0]! as unknown as { tools?: Array<{ type: string }> };
    expect((callArgs.tools ?? []).find((t) => t.type === 'web_search')).toBeDefined();
  });

  it('includes web_search when enabled (goal mode)', async () => {
    const llm = fakeLlm([textResponse('done', 'r1')]);
    await makeAgent(llm, true, 'goal').respond('check Madrid weather and tell me');
    const callArgs = llm.calls[0]! as unknown as { tools?: Array<{ type: string }> };
    expect((callArgs.tools ?? []).find((t) => t.type === 'web_search')).toBeDefined();
  });
});
