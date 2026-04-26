import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PollingTelegramReceiver } from '../../src/telegram/pollingReceiver.ts';
import type { OffsetStore } from '../../src/telegram/offsetStore.ts';

function memOffset(initial = 0): OffsetStore {
  let v = initial;
  return {
    read: () => v,
    write: (x) => {
      if (x > v) v = x;
    },
  };
}

function fetchSequence(responses: unknown[]): typeof fetch {
  let i = 0;
  return (async () => {
    const body = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('PollingTelegramReceiver', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('emits a single text message and advances offset', async () => {
    const store = memOffset(0);
    const fetchImpl = fetchSequence([
      {
        ok: true,
        result: [
          {
            update_id: 100,
            message: {
              message_id: 1,
              from: { id: 7, is_bot: false },
              chat: { id: 42, type: 'private' },
              date: 1700000000,
              text: 'hi',
            },
          },
        ],
      },
      { ok: true, result: [] },
    ]);
    const r = new PollingTelegramReceiver({
      botToken: 'X',
      offsetStore: store,
      fetchImpl,
      pollTimeoutSec: 0,
    });

    const iter = r.messages()[Symbol.asyncIterator]();
    const first = await iter.next();
    await r.stop();
    expect(first.done).toBe(false);
    if (first.done) return;
    expect(first.value.kind).toBe('text');
    if (first.value.kind === 'text') {
      expect(first.value.text).toBe('hi');
      expect(first.value.chatId).toBe(42);
      expect(first.value.fromUserId).toBe(7);
      expect(first.value.updateId).toBe(100);
    }
    expect(store.read()).toBe(101);
  });

  it('classifies voice messages without crashing', async () => {
    const store = memOffset(0);
    const fetchImpl = fetchSequence([
      {
        ok: true,
        result: [
          {
            update_id: 200,
            message: {
              message_id: 2,
              from: { id: 7, is_bot: false },
              chat: { id: 42, type: 'private' },
              date: 1700000001,
              voice: { file_id: 'F1', duration: 4 },
            },
          },
        ],
      },
      { ok: true, result: [] },
    ]);
    const r = new PollingTelegramReceiver({
      botToken: 'X',
      offsetStore: store,
      fetchImpl,
      pollTimeoutSec: 0,
    });
    const iter = r.messages()[Symbol.asyncIterator]();
    const first = await iter.next();
    await r.stop();
    expect(first.value?.kind).toBe('voice');
    if (first.value?.kind === 'voice') {
      expect(first.value.fileId).toBe('F1');
      expect(first.value.durationSec).toBe(4);
    }
  });

  it('classifies unsupported updates as "unsupported"', async () => {
    const store = memOffset(0);
    const fetchImpl = fetchSequence([
      {
        ok: true,
        result: [
          {
            update_id: 300,
            message: {
              message_id: 3,
              from: { id: 7, is_bot: false },
              chat: { id: 42, type: 'private' },
              date: 1700000002,
              photo: [{ file_id: 'P', width: 100, height: 100 }],
            },
          },
        ],
      },
      { ok: true, result: [] },
    ]);
    const r = new PollingTelegramReceiver({
      botToken: 'X',
      offsetStore: store,
      fetchImpl,
      pollTimeoutSec: 0,
    });
    const iter = r.messages()[Symbol.asyncIterator]();
    const first = await iter.next();
    await r.stop();
    expect(first.value?.kind).toBe('unsupported');
  });

  it('starts from the persisted offset (next-to-fetch)', async () => {
    // Store holds last_seen+1, so memOffset(100) means "we already processed up to 99".
    const store = memOffset(100);
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = new PollingTelegramReceiver({
      botToken: 'X',
      offsetStore: store,
      fetchImpl,
      pollTimeoutSec: 0,
    });
    const iter = r.messages()[Symbol.asyncIterator]();
    // kick one poll
    const p = iter.next();
    await new Promise((res) => setTimeout(res, 5));
    await r.stop();
    await p.catch(() => {}); // it'll resolve after stop()
    expect(calls[0]).toContain('offset=100');
  });

  it('treats response.ok=false as a transient error and retries', async () => {
    const store = memOffset(0);
    let i = 0;
    const fetchImpl = (async () => {
      i++;
      if (i === 1)
        return new Response(JSON.stringify({ ok: false, description: 'flood' }), { status: 200 });
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 500,
              message: {
                message_id: 9,
                from: { id: 7, is_bot: false },
                chat: { id: 42, type: 'private' },
                date: 1700000003,
                text: 'recovered',
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = new PollingTelegramReceiver({
      botToken: 'X',
      offsetStore: store,
      fetchImpl,
      pollTimeoutSec: 0,
      retryDelayMs: 1,
    });
    const iter = r.messages()[Symbol.asyncIterator]();
    const got = await iter.next();
    await r.stop();
    expect(got.value?.kind).toBe('text');
  });

  it('stop() makes the iterator terminate', async () => {
    const store = memOffset(0);
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const r = new PollingTelegramReceiver({
      botToken: 'X',
      offsetStore: store,
      fetchImpl,
      pollTimeoutSec: 0,
    });
    const iter = r.messages()[Symbol.asyncIterator]();
    const p = iter.next();
    await r.stop();
    const out = await p;
    expect(out.done).toBe(true);
  });

  it('invokes onStop hook when stop() is called', async () => {
    const stopped = vi.fn();
    const r = new PollingTelegramReceiver({
      botToken: 'X',
      offsetStore: memOffset(0),
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: true, result: [] }), {
          status: 200,
        })) as unknown as typeof fetch,
      pollTimeoutSec: 0,
      onStop: stopped,
    });
    const iter = r.messages()[Symbol.asyncIterator]();
    const p = iter.next();
    await r.stop();
    await p;
    expect(stopped).toHaveBeenCalledTimes(1);
  });
});
