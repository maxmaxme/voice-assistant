import { describe, it, expect, vi } from 'vitest';
import { OpenAiAgent } from '../../src/agent/openaiAgent.ts';
import { Session } from '../../src/agent/session.ts';
import type { McpClient } from '../../src/mcp/types.ts';
import type { MemoryStore } from '../../src/memory/types.ts';
import type { TelegramSender } from '../../src/telegram/types.ts';
import {
  buildTelegramTool,
  executeTelegramTool,
  TELEGRAM_TOOL_NAME,
} from '../../src/agent/telegramTool.ts';
import { BotTelegramSender } from '../../src/telegram/telegramSender.ts';

function emptyMemory(): MemoryStore {
  return {
    profile: { remember: () => {}, recall: () => ({}), forget: () => {}, close: () => {} },
    reminders: {
      add: () => {
        throw new Error('not used');
      },
      listPending: () => [],
      listDue: () => [],
      markFired: () => {},
      cancel: () => false,
      get: () => null,
    },
    timers: {
      add: () => {
        throw new Error('not used');
      },
      listActive: () => [],
      listDue: () => [],
      markFired: () => {},
      cancel: () => false,
      get: () => null,
    },
    close: () => {},
  };
}

function fakeMcp(): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi
      .fn()
      .mockResolvedValue({ isError: false, content: [{ type: 'text', text: 'ok' }] }),
  };
}

function fakeLlm(scripted: Array<unknown>) {
  let i = 0;
  const create = vi.fn(async () => scripted[i++]);
  return {
    responses: { create, parse: create },
  };
}

describe('telegramTool', () => {
  it('exposes a function tool with the expected name', () => {
    expect(buildTelegramTool().name).toBe(TELEGRAM_TOOL_NAME);
  });

  it('executeTelegramTool delegates to the sender', async () => {
    const sent: string[] = [];
    const sender: TelegramSender = {
      send: async (t) => {
        sent.push(t);
      },
    };
    const r = await executeTelegramTool(sender, { text: 'hi' });
    expect(r).toEqual({ ok: true });
    expect(sent).toEqual(['hi']);
  });

  it('executeTelegramTool rejects empty text', async () => {
    const sender: TelegramSender = { send: vi.fn() };
    await expect(executeTelegramTool(sender, { text: '   ' })).rejects.toThrow();
    expect(sender.send).not.toHaveBeenCalled();
  });
});

describe('BotTelegramSender', () => {
  it('instantiates with botToken and chatId', () => {
    const sender = new BotTelegramSender({ botToken: 'TKN', chatId: '42' });
    expect(sender).toBeDefined();
  });

  it('has a send method', () => {
    const sender = new BotTelegramSender({ botToken: 'TKN', chatId: '42' });
    expect(typeof sender.send).toBe('function');
  });
});

describe('OpenAiAgent + telegram', () => {
  it('routes send_to_telegram tool calls to the telegram adapter, not MCP', async () => {
    const sent: string[] = [];
    const telegram: TelegramSender = {
      send: async (t) => {
        sent.push(t);
      },
    };
    const mcp = fakeMcp();
    const llm = fakeLlm([
      {
        id: 'resp_1',
        output: [
          {
            type: 'function_call',
            call_id: 'tg_1',
            name: 'send_to_telegram',
            arguments: '{"text":"Рецепт блинов: ..."}',
          },
        ],
        output_text: '',
      },
      {
        id: 'resp_2',
        output_parsed: { speak: 'Отправил.', direction: null },
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '{"speak":"Отправил.","direction":null}' }],
          },
        ],
      },
    ]);
    const agent = new OpenAiAgent({
      mcp,
      memory: emptyMemory(),
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram,
    });
    const res = await agent.respond('отправь рецепт в телеграм');
    expect(res.text).toBe('Отправил.');
    expect(sent).toEqual(['Рецепт блинов: ...']);
    expect(mcp.callTool).not.toHaveBeenCalled();
  });
});
