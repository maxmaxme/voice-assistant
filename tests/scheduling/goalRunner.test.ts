import { describe, it, expect } from 'vitest';
import { buildGoalRunner } from '../../src/scheduling/goalRunner.ts';
import type { Agent, AgentResponse } from '../../src/agent/types.ts';
import type { TelegramSender } from '../../src/telegram/types.ts';
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

function fakeTelegram(): TelegramSender & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send: async (text: string): Promise<void> => {
      sent.push(text);
    },
  };
}

describe('buildGoalRunner', () => {
  it('fires a goal by calling agent.respond with the goal text', async () => {
    const agent = passingAgent({ toolsUsed: ['send_to_telegram'] });
    const telegram = fakeTelegram();
    const runner = buildGoalRunner({ agent, telegram });
    await expect(runner.fire('do something')).resolves.toBeUndefined();
    expect(agent.calls).toEqual(['do something']);
    expect(telegram.sent).toEqual([]);
  });

  it('rethrows when agent.respond throws, preserving the original message', async () => {
    const telegram = fakeTelegram();
    const runner = buildGoalRunner({
      agent: throwingAgent(new Error('llm boom')),
      telegram,
    });
    await expect(runner.fire('break it')).rejects.toThrow(/llm boom/);
    expect(telegram.sent).toEqual([]);
  });

  it('writes a one-line success summary to stderr', async () => {
    const logs = captureLogs();
    try {
      const agent = passingAgent({ toolsUsed: ['send_to_telegram'] });
      const telegram = fakeTelegram();
      const runner = buildGoalRunner({ agent, telegram });
      await runner.fire('greet the world');
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

  it('forwards the agent reply to Telegram when the goal produced text but did not call send_to_telegram', async () => {
    const agent = passingAgent({
      text: 'я не могу забронировать бассейн напрямую',
      toolsUsed: ['HassGetState'],
    });
    const telegram = fakeTelegram();
    const runner = buildGoalRunner({ agent, telegram });
    await runner.fire('забронировать бассейн');
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]).toContain('забронировать бассейн');
    expect(telegram.sent[0]).toContain('я не могу забронировать бассейн напрямую');
    expect(telegram.sent[0]).toContain('⚠️');
  });

  it('does not duplicate when the goal already called send_to_telegram', async () => {
    const agent = passingAgent({
      text: 'отправил напоминание',
      toolsUsed: ['send_to_telegram'],
    });
    const telegram = fakeTelegram();
    const runner = buildGoalRunner({ agent, telegram });
    await runner.fire('напомни купить молоко');
    expect(telegram.sent).toEqual([]);
  });

  it('does not send to Telegram when the goal completed silently with empty text', async () => {
    const agent = passingAgent({ text: '', toolsUsed: ['HassTurnOn'] });
    const telegram = fakeTelegram();
    const runner = buildGoalRunner({ agent, telegram });
    await runner.fire('включи свет на кухне');
    expect(telegram.sent).toEqual([]);
  });

  it('does not rethrow when the Telegram fallback itself fails', async () => {
    const agent = passingAgent({ text: 'oops', toolsUsed: [] });
    const telegram: TelegramSender = {
      send: async () => {
        throw new Error('tg down');
      },
    };
    const runner = buildGoalRunner({ agent, telegram });
    await expect(runner.fire('do thing')).resolves.toBeUndefined();
  });
});
