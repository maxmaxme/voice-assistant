import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegrafReceiver } from '../../src/telegram/telegrafReceiver.ts';

// ---------------------------------------------------------------------------
// Minimal Telegraf mock
// ---------------------------------------------------------------------------
// We capture the 'message' handler registered by TelegrafReceiver so tests
// can fire simulated incoming updates via bot._fire(ctx).
// The mock uses a regular `function` (not arrow) so it can be called with `new`.

type Handler = (ctx: unknown) => void | Promise<void>;

interface FakeBot {
  on: (event: string, handler: Handler) => void;
  launch: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  /** Test helper: simulate an incoming update arriving from Telegram. */
  _fire: (ctx: unknown) => void;
}

let latestBot: FakeBot | null = null;

vi.mock('telegraf', () => {
  // Must be a regular function (not arrow) to work as a `new`-able constructor.
  // Returning an explicit object makes JS use it as the `new` result, which
  // avoids aliasing `this` (banned by @typescript-eslint/no-this-alias).
  const MockTelegraf = vi.fn(function () {
    let messageHandler: Handler | null = null;
    const bot: FakeBot = {
      on: (_event: string, handler: Handler) => {
        messageHandler = handler;
      },
      launch: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      _fire: (ctx: unknown) => {
        messageHandler?.(ctx);
      },
    };
    latestBot = bot;
    return bot;
  });
  return { Telegraf: MockTelegraf };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textCtx(
  updateId: number,
  chatId: number,
  userId: number,
  text: string,
  date = 1700000000,
) {
  return {
    update: {
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: userId, is_bot: false },
        chat: { id: chatId, type: 'private' },
        date,
        text,
      },
    },
  };
}

function voiceCtx(
  updateId: number,
  chatId: number,
  userId: number,
  fileId: string,
  duration: number,
) {
  return {
    update: {
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: userId, is_bot: false },
        chat: { id: chatId, type: 'private' },
        date: 1700000001,
        voice: { file_id: fileId, duration },
      },
    },
  };
}

function photoCtx(updateId: number, chatId: number, userId: number) {
  return {
    update: {
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: userId, is_bot: false },
        chat: { id: chatId, type: 'private' },
        date: 1700000002,
        photo: [{ file_id: 'P', width: 100, height: 100 }],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegrafReceiver', () => {
  beforeEach(() => {
    latestBot = null;
  });

  it('emits a text message', async () => {
    const r = new TelegrafReceiver({ botToken: 'X' });
    const bot = latestBot!;

    const iter = r.messages()[Symbol.asyncIterator]();
    // Fire a message before the consumer awaits — it should be queued.
    bot._fire(textCtx(100, 42, 7, 'hello'));

    const result = await iter.next();
    await r.stop();

    expect(result.done).toBe(false);
    if (result.done) {
      return;
    }
    expect(result.value.kind).toBe('text');
    if (result.value.kind === 'text') {
      expect(result.value.text).toBe('hello');
      expect(result.value.chatId).toBe(42);
      expect(result.value.fromUserId).toBe(7);
      expect(result.value.updateId).toBe(100);
    }
  });

  it('emits a voice message', async () => {
    const r = new TelegrafReceiver({ botToken: 'X' });
    const bot = latestBot!;

    const iter = r.messages()[Symbol.asyncIterator]();
    bot._fire(voiceCtx(200, 42, 7, 'FILE1', 5));

    const result = await iter.next();
    await r.stop();

    expect(result.value?.kind).toBe('voice');
    if (result.value?.kind === 'voice') {
      expect(result.value.fileId).toBe('FILE1');
      expect(result.value.durationSec).toBe(5);
    }
  });

  it('classifies unsupported message types', async () => {
    const r = new TelegrafReceiver({ botToken: 'X' });
    const bot = latestBot!;

    const iter = r.messages()[Symbol.asyncIterator]();
    bot._fire(photoCtx(300, 42, 7));

    const result = await iter.next();
    await r.stop();

    expect(result.value?.kind).toBe('unsupported');
  });

  it('stop() makes the iterator terminate', async () => {
    const r = new TelegrafReceiver({ botToken: 'X' });
    const iter = r.messages()[Symbol.asyncIterator]();
    // No messages fired — consumer will be waiting.
    const pending = iter.next();
    await r.stop();
    const out = await pending;
    expect(out.done).toBe(true);
  });

  it('invokes onStop hook when stop() is called', async () => {
    const stopped = vi.fn();
    const r = new TelegrafReceiver({ botToken: 'X', onStop: stopped });
    const iter = r.messages()[Symbol.asyncIterator]();
    const pending = iter.next();
    await r.stop();
    await pending;
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('calls bot.launch() when messages() is iterated', async () => {
    const r = new TelegrafReceiver({ botToken: 'X' });
    const bot = latestBot!;

    const iter = r.messages()[Symbol.asyncIterator]();
    // kick the generator — it calls bot.launch() at the top of its body
    const pending = iter.next();
    // Give launch a tick to execute
    await new Promise((res) => setTimeout(res, 0));
    expect(bot.launch).toHaveBeenCalledTimes(1);

    await r.stop();
    await pending;
  });

  it('calls bot.stop() when stop() is called', async () => {
    const r = new TelegrafReceiver({ botToken: 'X' });
    const bot = latestBot!;

    const iter = r.messages()[Symbol.asyncIterator]();
    const pending = iter.next();
    await r.stop();
    await pending;

    expect(bot.stop).toHaveBeenCalledTimes(1);
  });

  it('ignores messages with no from field', async () => {
    const r = new TelegrafReceiver({ botToken: 'X' });
    const bot = latestBot!;

    // Channel post — no `from`
    const channelPostCtx = {
      update: {
        update_id: 400,
        message: {
          message_id: 400,
          // no `from` field
          chat: { id: 42, type: 'channel' },
          date: 1700000003,
          text: 'channel msg',
        },
      },
    };

    const iter = r.messages()[Symbol.asyncIterator]();
    bot._fire(channelPostCtx);

    // Now fire a real message so the iterator has something to yield.
    bot._fire(textCtx(401, 42, 7, 'real'));

    const result = await iter.next();
    await r.stop();

    // The first yielded value should be the real message, not the channel post.
    expect(result.value?.kind).toBe('text');
    if (result.value?.kind === 'text') {
      expect(result.value.text).toBe('real');
    }
  });

  it('message fired before messages() starts is queued and delivered', async () => {
    const r = new TelegrafReceiver({ botToken: 'X' });
    const bot = latestBot!;

    // Fire the message before starting iteration.
    bot._fire(textCtx(500, 42, 7, 'queued'));

    const iter = r.messages()[Symbol.asyncIterator]();
    const result = await iter.next();
    await r.stop();

    expect(result.value?.kind).toBe('text');
    if (result.value?.kind === 'text') {
      expect(result.value.text).toBe('queued');
    }
  });
});
