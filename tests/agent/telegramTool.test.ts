import { describe, it, expect, vi } from 'vitest';
import { OpenAiAgent } from '../../src/agent/openaiAgent.ts';
import { Session } from '../../src/agent/session.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';
import { IdentitiesStore } from '../../src/memory/identities.ts';
import { SqliteSettings } from '../../src/settings/sqliteSettings.ts';
import { SqlitePrompts } from '../../src/settings/sqlitePrompts.ts';
import { SqliteIntegrations } from '../../src/integrations/sqliteIntegrations.ts';
import { freshTestDb } from '../memory/helpers.ts';
import type { McpClient } from '../../src/mcp/types.ts';
import type { Channel, IdentitiesAdapter, MemoryStore } from '../../src/memory/types.ts';
import type { TelegramSender } from '../../src/telegram/types.ts';
import {
  buildTelegramTool,
  executeTelegramTool,
  TELEGRAM_TOOL_NAME,
  type TelegramToolContext,
} from '../../src/agent/telegramTool.ts';
import { BotTelegramSender } from '../../src/telegram/telegramSender.ts';

function emptyMemory(): MemoryStore {
  const { db } = freshTestDb();
  const profileStore = new SqliteProfileMemory(db);
  const identities = new IdentitiesStore(db);
  return {
    profile: { remember: () => {}, recall: () => ({}), forget: () => {}, close: () => {} },
    profileStore,
    identities,
    scheduledActions: {
      add: () => {
        throw new Error('not used');
      },
      listActiveForOwner: () => [],
      listDue: () => [],
      markFired: () => {},
      markError: () => {},
      cancel: () => false,
      get: () => null,
    },
    telegramSessions: {
      get: () => null,
      save: () => {},
      delete: () => {},
    },
    settings: new SqliteSettings(db),
    prompts: new SqlitePrompts(db),
    integrations: new SqliteIntegrations(db),
    close: () => {},
  };
}

/** Identities whose telegram chat id per user comes from the map. */
function fakeIdentities(telegramByUser: Record<number, string>): IdentitiesAdapter {
  return {
    resolve: () => null,
    touch: () => {},
    identityFor: (channel: Channel, userId: number) =>
      channel === 'telegram' ? (telegramByUser[userId] ?? null) : null,
    listTelegramUsers: () =>
      Object.entries(telegramByUser).map(([userId, chatId]) => ({
        userId: Number(userId),
        name: `user${userId}`,
        chatId,
      })),
    addUser: () => 0,
    attachIdentity: () => {},
    isAdmin: () => false,
    setAdmin: () => {},
    isEmpty: () => false,
  };
}

/** A senderFor that records what each chat id received. */
function recordingSenders(): {
  senderFor: (chatId: string) => TelegramSender;
  byChat: Record<string, string[]>;
} {
  const byChat: Record<string, string[]> = {};
  return {
    byChat,
    senderFor: (chatId) => ({
      send: async (t) => {
        (byChat[chatId] ??= []).push(t);
      },
    }),
  };
}

function ctx(over: Partial<TelegramToolContext> = {}): TelegramToolContext {
  const senders = recordingSenders();
  return {
    scope: { userId: 1 },
    identities: fakeIdentities({ 1: '42' }),
    senderFor: senders.senderFor,
    ...over,
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
    responses: { create },
  };
}

describe('telegramTool', () => {
  it('exposes a function tool with the expected name', () => {
    expect(buildTelegramTool().name).toBe(TELEGRAM_TOOL_NAME);
  });

  it('delivers to the current user (self) when no recipient is given', async () => {
    const senders = recordingSenders();
    const c = ctx({
      scope: { userId: 1 },
      identities: fakeIdentities({ 1: '42' }),
      senderFor: senders.senderFor,
    });
    const r = await executeTelegramTool(c, { text: 'hi' });
    expect(r).toEqual({ ok: true, recipientUserId: 1 });
    expect(senders.byChat['42']).toEqual(['hi']);
  });

  it('delivers to an explicit recipient user id', async () => {
    const senders = recordingSenders();
    const c = ctx({
      scope: { userId: 1 },
      identities: fakeIdentities({ 1: '42', 2: '99' }),
      senderFor: senders.senderFor,
    });
    const r = await executeTelegramTool(c, { text: 'yo', recipient: 2 });
    expect(r).toEqual({ ok: true, recipientUserId: 2 });
    expect(senders.byChat['99']).toEqual(['yo']);
    expect(senders.byChat['42']).toBeUndefined();
  });

  it('errors (listing recipients) when the current user has no Telegram', async () => {
    const senders = recordingSenders();
    const c = ctx({
      scope: { userId: 5 }, // not in the map
      identities: fakeIdentities({ 1: '42' }),
      senderFor: senders.senderFor,
    });
    await expect(executeTelegramTool(c, { text: 'hi' })).rejects.toThrow(
      /no Telegram linked|1=user1/,
    );
    expect(senders.byChat).toEqual({});
  });

  it('errors when there is no current user and no recipient', async () => {
    const c = ctx({ scope: null, identities: fakeIdentities({ 1: '42' }) });
    await expect(executeTelegramTool(c, { text: 'hi' })).rejects.toThrow(/no recipient/i);
  });

  it('rejects empty text', async () => {
    const senders = recordingSenders();
    const c = ctx({ senderFor: senders.senderFor });
    await expect(executeTelegramTool(c, { text: '   ' })).rejects.toThrow();
    expect(senders.byChat).toEqual({});
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
  it('routes send_to_telegram to the caller’s chat via identities, not MCP', async () => {
    const memory = emptyMemory();
    const uid = memory.identities.addUser('me');
    memory.identities.attachIdentity('telegram', '42', uid);
    const senders = recordingSenders();
    const mcp = fakeMcp();
    const llm = fakeLlm([
      {
        id: 'resp_1',
        output: [
          {
            type: 'function_call',
            call_id: 'tg_1',
            name: 'send_to_telegram',
            arguments: '{"text":"Pancake recipe: ..."}',
          },
        ],
        output_text: '',
      },
      {
        id: 'resp_2',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Sent.' }],
          },
        ],
        output_text: 'Sent.',
      },
    ]);
    const agent = new OpenAiAgent({
      mcp,
      memory,
      session: new Session({ idleTimeoutMs: 60_000 }),
      systemPrompt: 'sys',
      model: 'gpt-4o',
      llmClient: llm as never,
      telegram: { senderFor: senders.senderFor },
    });
    const res = await agent.respond('send the recipe to telegram', { scope: { userId: uid } });
    expect(res.text).toBe('Sent.');
    expect(senders.byChat['42']).toEqual(['Pancake recipe: ...']);
    expect(mcp.callTool).not.toHaveBeenCalled();
  });
});
