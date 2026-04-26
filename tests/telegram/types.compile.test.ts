import { describe, it, expect } from 'vitest';
import type { TelegramReceiver, TelegramMessage } from '../../src/telegram/types.ts';

describe('telegram types', () => {
  it('TelegramMessage shape', () => {
    const msg: TelegramMessage = {
      updateId: 1,
      chatId: 42,
      fromUserId: 7,
      kind: 'text',
      text: 'hi',
      receivedAt: Date.now(),
    };
    expect(msg.kind).toBe('text');
  });

  it('TelegramReceiver is implementable', () => {
    const stub: TelegramReceiver = {
      async *messages() {
        // empty
      },
      async stop() {},
    };
    expect(stub).toBeDefined();
  });
});
