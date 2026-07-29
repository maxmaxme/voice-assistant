import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake the SDK wrapper so connect() can be driven without a network: each
// constructed OpenAIRealtimeWS exposes a controllable socket whose 'open' /
// 'error' events the test fires by hand. (vi.hoisted runs before module
// imports, so the socket uses a hand-rolled emitter instead of node:events.)
const { fakeSockets, fakeSdks, FakeRealtimeWS } = vi.hoisted(() => {
  class FakeSocket {
    readyState = 0; // CONNECTING
    close = vi.fn();
    send = vi.fn();
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    on(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }

    once(event: string, fn: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]): void => {
        this.off(event, wrapped);
        fn(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      this.handlers.set(
        event,
        list.filter((f) => f !== fn),
      );
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const fn of [...(this.handlers.get(event) ?? [])]) {
        fn(...args);
      }
    }
  }
  const sockets: InstanceType<typeof FakeSocket>[] = [];
  class FakeRealtimeWS {
    socket = new FakeSocket();
    errorHandlers: Array<(...args: unknown[]) => void> = [];
    on = vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      if (event === 'error') {
        this.errorHandlers.push(fn);
      }
      return this;
    });
    constructor() {
      sockets.push(this.socket);
      instances.push(this);
      // Mirror the real OpenAIRealtimeWS: a socket-level 'error' is re-surfaced
      // as an rt-level 'error'. Node's EventEmitter throws on an 'error' with no
      // listener — that's the unhandled rejection that kills the process. Model
      // exactly that so a test can prove the sink is attached in time.
      this.socket.on('error', (err) => {
        if (this.errorHandlers.length === 0) {
          throw err instanceof Error ? err : new Error('OpenAIRealtimeError');
        }
        for (const fn of this.errorHandlers) {
          fn(err);
        }
      });
    }
  }
  const instances: InstanceType<typeof FakeRealtimeWS>[] = [];
  return { fakeSockets: sockets, fakeSdks: instances, FakeRealtimeWS };
});

vi.mock('openai/realtime/ws', () => ({ OpenAIRealtimeWS: FakeRealtimeWS }));

import {
  OpenAiRealtimeClient,
  type RealtimeClientOptions,
} from '../../src/realtime/openaiRealtimeClient.ts';
import { captureLogs } from '../helpers/captureLogs.ts';

beforeEach(() => {
  fakeSockets.length = 0;
  fakeSdks.length = 0;
});

function makeClient(overrides: Partial<RealtimeClientOptions> = {}): OpenAiRealtimeClient {
  return new OpenAiRealtimeClient({
    apiKey: 'test-key',
    model: 'gpt-realtime-2',
    instructions: 'be brief',
    voice: 'marin',
    tools: [],
    ...overrides,
  });
}

/** Drive a connect() to completion: fire 'open' on the freshly dialed socket. */
async function connectClient(client: OpenAiRealtimeClient): Promise<void> {
  const pending = client.connect();
  const socket = fakeSockets.at(-1)!;
  socket.readyState = 1; // OPEN
  socket.emit('open');
  await pending;
}

describe('OpenAiRealtimeClient.connect abort', () => {
  it('close() during the handshake aborts the in-flight socket', async () => {
    const client = makeClient();
    const pending = client.connect();
    const socket = fakeSockets.at(-1)!;

    // The bridge's connect-timeout path: give up on a handshake that never
    // completes. This must tear down the dialing socket, not orphan it.
    client.close();
    expect(socket.close).toHaveBeenCalled();

    // A late 'open' on the abandoned socket must not revive it: no session
    // config goes out and the client stays closed — otherwise a stray live
    // session feeds its events into whatever session comes next.
    socket.readyState = 1; // OPEN
    socket.emit('open');
    await expect(pending).rejects.toThrow(/abort/i);
    expect(client.isOpen()).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('survives a socket error during the handshake (before open) without crashing the process', () => {
    const client = makeClient();
    // Mid-handshake: 'open' has NOT fired yet. This is the window a device WS
    // dropping mid-dial hits — deviceWs 'close' → bridge calls openai.close(),
    // which aborts the CONNECTING socket and makes the SDK emit an rt-level
    // error. Before the fix the error sink was attached only AFTER 'open', so
    // this became an unhandled OpenAIRealtimeError and took the whole process
    // down (observed as restarts=1 + "realtime ws server listening" again).
    const pending = client.connect();
    pending.catch(() => {}); // the connect promise rejects via socket 'error' — expected
    const socket = fakeSockets.at(-1)!;
    expect(() =>
      socket.emit('error', new Error('WebSocket was closed before the connection was established')),
    ).not.toThrow();
  });
});

describe('OpenAiRealtimeClient stale socket close', () => {
  it("a previous socket's late close does not fire closeListeners for the live session", async () => {
    const client = makeClient();
    const onClose = vi.fn();
    client.onClose(onClose);

    // Session A: connect + open.
    const pendingA = client.connect();
    const socketA = fakeSockets.at(-1)!;
    socketA.readyState = 1; // OPEN
    socketA.emit('open');
    await pendingA;

    // Idle reset closes A, then the next wake word connects session B.
    client.close();
    const pendingB = client.connect();
    const socketB = fakeSockets.at(-1)!;
    socketB.readyState = 1; // OPEN
    socketB.emit('open');
    await pendingB;

    // Socket A's TCP close lands late (close() is async at the OS level).
    // It belongs to the dead session — the bridge must not be flipped to
    // disconnected / have its tool + follow-up state wiped for socket B.
    socketA.emit('close', 1000, Buffer.from(''));
    expect(onClose).not.toHaveBeenCalled();

    // The live socket's close still notifies as usual.
    socketB.emit('close', 1006, Buffer.from(''));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an explicit close() with no successor session still notifies closeListeners', async () => {
    const client = makeClient();
    const onClose = vi.fn();
    client.onClose(onClose);

    const pending = client.connect();
    const socket = fakeSockets.at(-1)!;
    socket.readyState = 1; // OPEN
    socket.emit('open');
    await pending;

    // Idle reset: the bridge calls close() and relies on the resulting close
    // notification to flip itself to disconnected.
    client.close();
    socket.emit('close', 1000, Buffer.from(''));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAiRealtimeClient.cancelResponse', () => {
  it('is a no-op when the ws is not open (lazy-disconnected session)', () => {
    const client = makeClient();
    // Never connected → ws is null. A device `start`/`interrupt` can legitimately
    // arrive while the upstream is lazily disconnected (fresh wake after the
    // idle-reset or OpenAI's 30-min cap). There is no response to cancel, and
    // throwing here used to abort the bridge's control handler — dropping the
    // listening phase and logging "bad device control message".
    expect(() => client.cancelResponse()).not.toThrow();
  });
});

describe('OpenAiRealtimeClient tool-result paths on a closed ws', () => {
  // The OpenAI ws can race a close (30-min cap, network drop) while a tool
  // batch is in flight. These are called from the bridge's response.done
  // handler — a throw there would strand the device in the thinking phase
  // until its own timeout. Like cancelResponse, they must degrade to no-ops.
  it('submitToolResult is a no-op when the ws is not open', () => {
    const client = makeClient();
    expect(() => client.submitToolResult('call_1', '{}')).not.toThrow();
  });

  it('requestResponse is a no-op when the ws is not open', () => {
    const client = makeClient();
    expect(() => client.requestResponse()).not.toThrow();
  });
});

describe('OpenAiRealtimeClient.requestResponse', () => {
  it('sends a bare response.create when no instructions are given', async () => {
    const client = makeClient();
    await connectClient(client);
    const socket = fakeSockets.at(-1)!;
    socket.send.mockClear();
    client.requestResponse();
    expect(socket.send).toHaveBeenCalledTimes(1);
    const ev = JSON.parse(String(socket.send.mock.calls[0][0]));
    expect(ev).toEqual({ type: 'response.create' });
  });

  it('sends response.create with one-off instructions when provided', async () => {
    const client = makeClient();
    await connectClient(client);
    const socket = fakeSockets.at(-1)!;
    socket.send.mockClear();
    client.requestResponse('speak up');
    expect(socket.send).toHaveBeenCalledTimes(1);
    const ev = JSON.parse(String(socket.send.mock.calls[0][0]));
    expect(ev).toEqual({ type: 'response.create', response: { instructions: 'speak up' } });
  });
});

describe('OpenAiRealtimeClient.connect session configuration', () => {
  function sentSession(socket: (typeof fakeSockets)[number]): Record<string, unknown> {
    expect(socket.send).toHaveBeenCalledTimes(1);
    const event = JSON.parse(socket.send.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(event.type).toBe('session.update');
    return event.session as Record<string, unknown>;
  }

  it('sends a session.update carrying the full session payload after open', async () => {
    const tool = {
      type: 'function' as const,
      name: 'do_thing',
      description: 'does the thing',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    const client = makeClient({ tools: [tool] });
    await connectClient(client);

    const session = sentSession(fakeSockets.at(-1)!);
    expect(session).toMatchObject({
      type: 'realtime',
      model: 'gpt-realtime-2',
      output_modalities: ['audio'],
      instructions: 'be brief',
      tools: [tool],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          // Filters the hiss of an across-the-room mic before VAD sees it.
          noise_reduction: { type: 'far_field' },
          // 900ms (not the 500ms default): a natural mid-sentence pause must
          // not split the turn — see the comment in openaiRealtimeClient.ts.
          turn_detection: { type: 'server_vad', silence_duration_ms: 900 },
          transcription: { model: 'whisper-1' },
        },
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
          voice: 'marin',
        },
      },
    });
    // No reasoningEffort configured → the field must be absent entirely, not
    // sent as undefined/null (the API rejects unexpected shapes).
    expect(session).not.toHaveProperty('reasoning');
  });

  it('includes reasoning only when reasoningEffort is configured', async () => {
    const client = makeClient({ reasoningEffort: 'low' });
    await connectClient(client);

    const session = sentSession(fakeSockets.at(-1)!);
    expect(session.reasoning).toEqual({ effort: 'low' });
  });
});

describe('OpenAiRealtimeClient event and close wiring', () => {
  it("fans the sdk's 'event' out to every on() listener", async () => {
    const client = makeClient();
    const first = vi.fn();
    const second = vi.fn();
    client.on(first);
    client.on(second);
    await connectClient(client);

    const sdk = fakeSdks.at(-1)!;
    const eventHandler = sdk.on.mock.calls.find(([name]) => name === 'event')?.[1] as (
      ev: unknown,
    ) => void;
    expect(eventHandler).toBeDefined();

    const ev = { type: 'response.created' };
    eventHandler(ev);
    expect(first).toHaveBeenCalledWith(ev);
    expect(second).toHaveBeenCalledWith(ev);
  });

  it("the live socket's close fires onClose listeners with code and reason", async () => {
    const client = makeClient();
    const onClose = vi.fn();
    client.onClose(onClose);
    await connectClient(client);

    fakeSockets.at(-1)!.emit('close', 1006, Buffer.from('abnormal'));
    expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: 'abnormal' });
  });
});

describe('OpenAiRealtimeClient send and audio fastpath', () => {
  it('send() throws when never connected', () => {
    const client = makeClient();
    expect(() => client.send({ type: 'response.create' })).toThrow(/not open/);
  });

  it('appendAudioPcm16Base64 drops silently on a closed ws and the close log carries the count', async () => {
    const client = makeClient();
    await connectClient(client);
    const socket = fakeSockets.at(-1)!;

    // OpenAI's 30-min cap closes the socket under us mid-stream; the device
    // keeps sending ~50 frames/sec until the bridge tears the session down.
    socket.readyState = 3; // CLOSED
    expect(() => client.appendAudioPcm16Base64('AAAA')).not.toThrow();
    client.appendAudioPcm16Base64('AAAA');
    client.appendAudioPcm16Base64('AAAA');

    const logs = captureLogs();
    try {
      socket.emit('close', 1000, Buffer.from(''));
      expect(logs.text()).toMatch(/audio frames dropped/);
      expect(logs.text()).toMatch(/"count":3/);
    } finally {
      logs.restore();
    }
  });
});
