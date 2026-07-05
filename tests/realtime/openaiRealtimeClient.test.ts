import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake the SDK wrapper so connect() can be driven without a network: each
// constructed OpenAIRealtimeWS exposes a controllable socket whose 'open' /
// 'error' events the test fires by hand. (vi.hoisted runs before module
// imports, so the socket uses a hand-rolled emitter instead of node:events.)
const { fakeSockets, FakeRealtimeWS } = vi.hoisted(() => {
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
    on = vi.fn();
    constructor() {
      sockets.push(this.socket);
    }
  }
  return { fakeSockets: sockets, FakeRealtimeWS };
});

vi.mock('openai/realtime/ws', () => ({ OpenAIRealtimeWS: FakeRealtimeWS }));

import { OpenAiRealtimeClient } from '../../src/realtime/openaiRealtimeClient.ts';

beforeEach(() => {
  fakeSockets.length = 0;
});

function makeClient(): OpenAiRealtimeClient {
  return new OpenAiRealtimeClient({
    apiKey: 'test-key',
    model: 'gpt-realtime-2',
    instructions: 'be brief',
    voice: 'marin',
    tools: [],
  });
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
