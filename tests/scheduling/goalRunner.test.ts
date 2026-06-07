import { describe, it, expect } from 'vitest';
import { buildGoalRunner } from '../../src/scheduling/goalRunner.ts';
import type { Agent, AgentResponse } from '../../src/agent/types.ts';
import type { TelegramSender } from '../../src/telegram/types.ts';
import type { Channel, IdentitiesAdapter } from '../../src/memory/types.ts';
import { captureLogs } from '../helpers/captureLogs.ts';

function passingAgent(response: Partial<AgentResponse> = {}): Agent & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    respond: async (text: string): Promise<AgentResponse> => {
      calls.push(text);
      return { text: 'done', direction: null, toolsUsed: [], ...response };
    },
  };
}

function throwingAgent(err: Error): Agent {
  return {
    respond: async () => {
      throw err;
    },
  };
}

/** Identities whose `identityFor('telegram', userId)` returns the mapped chat
 *  id (or null). */
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

/** A senderFor factory that records which chat ids it built senders for and
 *  what each one sent. */
function makeSenderFactory(): {
  senderFor: (chatId: string) => TelegramSender;
  sentByChat: Record<string, string[]>;
} {
  const sentByChat: Record<string, string[]> = {};
  return {
    sentByChat,
    senderFor: (chatId: string): TelegramSender => ({
      send: async (text: string): Promise<void> => {
        (sentByChat[chatId] ??= []).push(text);
      },
    }),
  };
}

describe('buildGoalRunner', () => {
  it('delivers the agent reply to the author’s Telegram chat', async () => {
    const agent = passingAgent({ text: 'buy milk' });
    const { senderFor, sentByChat } = makeSenderFactory();
    const runner = buildGoalRunner({
      agent,
      identities: fakeIdentities({ 7: '555' }),
      senderFor,
    });
    await expect(runner.fire('remind me to buy milk', 7)).resolves.toBeUndefined();
    expect(agent.calls).toEqual(['remind me to buy milk']);
    expect(sentByChat['555']).toEqual(['buy milk']);
  });

  it('drops delivery (and warns) when the author has no Telegram identity', async () => {
    const logs = captureLogs();
    try {
      const agent = passingAgent({ text: 'reminder text' });
      const { senderFor, sentByChat } = makeSenderFactory();
      const runner = buildGoalRunner({
        agent,
        identities: fakeIdentities({}), // user 7 has no telegram
        senderFor,
      });
      await runner.fire('do thing', 7);
      expect(sentByChat).toEqual({});
      expect(logs.text()).toMatch(/no Telegram identity|dropping delivery/);
    } finally {
      logs.restore();
    }
  });

  it('does not send when the goal completed with empty text', async () => {
    const agent = passingAgent({ text: '', toolsUsed: ['HassTurnOn'] });
    const { senderFor, sentByChat } = makeSenderFactory();
    const runner = buildGoalRunner({
      agent,
      identities: fakeIdentities({ 7: '555' }),
      senderFor,
    });
    await runner.fire('turn on the kitchen light', 7);
    expect(sentByChat).toEqual({});
  });

  it('rethrows when agent.respond throws, without delivering anything', async () => {
    const { senderFor, sentByChat } = makeSenderFactory();
    const runner = buildGoalRunner({
      agent: throwingAgent(new Error('llm boom')),
      identities: fakeIdentities({ 7: '555' }),
      senderFor,
    });
    await expect(runner.fire('break it', 7)).rejects.toThrow(/llm boom/);
    expect(sentByChat).toEqual({});
  });

  it('does not rethrow when delivery itself fails', async () => {
    const agent = passingAgent({ text: 'oops' });
    const runner = buildGoalRunner({
      agent,
      identities: fakeIdentities({ 7: '555' }),
      senderFor: () => ({
        send: async () => {
          throw new Error('tg down');
        },
      }),
    });
    await expect(runner.fire('do thing', 7)).resolves.toBeUndefined();
  });

  it('writes a one-line success summary to stderr', async () => {
    const logs = captureLogs();
    try {
      const agent = passingAgent({ text: 'done' });
      const { senderFor } = makeSenderFactory();
      const runner = buildGoalRunner({
        agent,
        identities: fakeIdentities({ 7: '555' }),
        senderFor,
      });
      await runner.fire('greet the world', 7);
      const messages = logs.spy.mock.calls.map((c) => String(c[0]));
      const summary = messages.find(
        (m) => m.includes('"scope":"goalRunner"') && m.includes('"reply"'),
      );
      expect(summary).toBeDefined();
      expect(summary).toContain('greet the world');
      expect(summary).toContain('done');
    } finally {
      logs.restore();
    }
  });
});
