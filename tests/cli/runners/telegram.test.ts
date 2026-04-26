import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({ exec: vi.fn() }));
import { exec } from 'child_process';
import { runTelegramMode } from '../../../src/cli/runners/telegram.ts';
import type {
  TelegramMessage,
  TelegramReceiver,
  TelegramSender,
} from '../../../src/telegram/types.ts';
import type { OpenAiAgent } from '../../../src/agent/openaiAgent.ts';
import type { Session } from '../../../src/agent/session.ts';
import type { MemoryStore } from '../../../src/memory/types.ts';

function fakeMemory(recallFn?: () => Record<string, unknown>): MemoryStore {
  return {
    profile: {
      remember: () => {},
      recall: recallFn ?? (() => ({})),
      forget: () => {},
      close: () => {},
    },
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

function recvFromMessages(items: TelegramMessage[]): TelegramReceiver {
  return {
    async *messages() {
      for (const m of items) yield m;
    },
    async stop() {},
  };
}

const captureSender = (): { sender: TelegramSender; sent: string[] } => {
  const sent: string[] = [];
  return {
    sent,
    sender: {
      async send(text: string) {
        sent.push(text);
      },
    },
  };
};

describe('runTelegramMode', () => {
  beforeEach(() => vi.clearAllMocks());
  it('forwards a text message to the agent and replies', async () => {
    const respond = vi.fn(async (text: string) => ({ text: `echo:${text}` }));
    const session = { reset: vi.fn() } as unknown as Session;
    const memory = fakeMemory();
    const cap = captureSender();

    await runTelegramMode({
      receiver: recvFromMessages([
        { updateId: 1, chatId: 42, fromUserId: 7, kind: 'text', text: 'hi', receivedAt: 0 },
      ]),
      sender: cap.sender,
      agent: { respond } as unknown as OpenAiAgent,
      session,
      memory,
      allowedChatIds: [42],
    });

    expect(respond).toHaveBeenCalledWith('hi');
    expect(cap.sent).toEqual(['echo:hi']);
  });

  it('rejects messages from non-allowlisted chats with no agent call', async () => {
    const respond = vi.fn();
    const cap = captureSender();
    await runTelegramMode({
      receiver: recvFromMessages([
        { updateId: 1, chatId: 999, fromUserId: 7, kind: 'text', text: 'sneak', receivedAt: 0 },
      ]),
      sender: cap.sender,
      agent: { respond } as unknown as OpenAiAgent,
      session: { reset: vi.fn() } as unknown as Session,
      memory: fakeMemory(),
      allowedChatIds: [42],
    });
    expect(respond).not.toHaveBeenCalled();
    expect(cap.sent).toEqual([]);
  });

  it('handles /reset locally', async () => {
    const respond = vi.fn();
    const session = { reset: vi.fn() } as unknown as Session;
    const cap = captureSender();
    await runTelegramMode({
      receiver: recvFromMessages([
        { updateId: 1, chatId: 42, fromUserId: 7, kind: 'text', text: '/reset', receivedAt: 0 },
      ]),
      sender: cap.sender,
      agent: { respond } as unknown as OpenAiAgent,
      session,
      memory: fakeMemory(),
      allowedChatIds: [42],
    });
    expect(session.reset).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalled();
    expect(cap.sent[0]).toMatch(/context cleared/i);
  });

  it('handles /profile locally', async () => {
    const respond = vi.fn();
    const recall = vi.fn(() => ({ name: 'Maxim' }));
    const cap = captureSender();
    await runTelegramMode({
      receiver: recvFromMessages([
        { updateId: 1, chatId: 42, fromUserId: 7, kind: 'text', text: '/profile', receivedAt: 0 },
      ]),
      sender: cap.sender,
      agent: { respond } as unknown as OpenAiAgent,
      session: { reset: vi.fn() } as unknown as Session,
      memory: fakeMemory(recall),
      allowedChatIds: [42],
    });
    expect(recall).toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(cap.sent[0]).toContain('Maxim');
  });

  it('handles /start with a help message', async () => {
    const respond = vi.fn();
    const cap = captureSender();
    await runTelegramMode({
      receiver: recvFromMessages([
        { updateId: 1, chatId: 42, fromUserId: 7, kind: 'text', text: '/start', receivedAt: 0 },
      ]),
      sender: cap.sender,
      agent: { respond } as unknown as OpenAiAgent,
      session: { reset: vi.fn() } as unknown as Session,
      memory: fakeMemory(),
      allowedChatIds: [42],
    });
    expect(respond).not.toHaveBeenCalled();
    expect(cap.sent[0]).toMatch(/help|команд|hi/i);
  });

  it('replies to voice messages with a "not yet supported" notice', async () => {
    const respond = vi.fn();
    const cap = captureSender();
    await runTelegramMode({
      receiver: recvFromMessages([
        {
          updateId: 1,
          chatId: 42,
          fromUserId: 7,
          kind: 'voice',
          fileId: 'F',
          durationSec: 3,
          receivedAt: 0,
        },
      ]),
      sender: cap.sender,
      agent: { respond } as unknown as OpenAiAgent,
      session: { reset: vi.fn() } as unknown as Session,
      memory: fakeMemory(),
      allowedChatIds: [42],
    });
    expect(respond).not.toHaveBeenCalled();
    expect(cap.sent[0]).toMatch(/voice|голос/i);
  });

  it('reports agent errors back to the user instead of crashing', async () => {
    const respond = vi.fn(async () => {
      throw new Error('boom');
    });
    const cap = captureSender();
    await runTelegramMode({
      receiver: recvFromMessages([
        { updateId: 1, chatId: 42, fromUserId: 7, kind: 'text', text: 'go', receivedAt: 0 },
      ]),
      sender: cap.sender,
      agent: { respond } as unknown as OpenAiAgent,
      session: { reset: vi.fn() } as unknown as Session,
      memory: fakeMemory(),
      allowedChatIds: [42],
    });
    expect(cap.sent[0]).toMatch(/error|ошибк/i);
  });

  it('handles /update by writing to the FIFO and sending a start notification', async () => {
    const respond = vi.fn();
    const cap = captureSender();
    await runTelegramMode({
      receiver: recvFromMessages([
        { updateId: 1, chatId: 42, fromUserId: 7, kind: 'text', text: '/update', receivedAt: 0 },
      ]),
      sender: cap.sender,
      agent: { respond } as unknown as OpenAiAgent,
      session: { reset: vi.fn() } as unknown as Session,
      memory: fakeMemory(),
      allowedChatIds: [42],
    });
    expect(respond).not.toHaveBeenCalled();
    expect(cap.sent[0]).toMatch(/starting.*update|🔄/i);
    expect(exec).toHaveBeenCalledWith('echo trigger > /tmp/va-update');
  });
});
