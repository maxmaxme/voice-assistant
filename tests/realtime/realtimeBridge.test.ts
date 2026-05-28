import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Capture every fake OpenAI client the bridge constructs so a test can assert
// against connect()/close() without reaching into private fields. Both the
// class and the registry are created via vi.hoisted so they exist when the
// hoisted vi.mock factory runs.
const { fakeClients, FakeOpenAiClient } = vi.hoisted(() => {
  const clients: FakeOpenAiClient[] = [];
  class FakeOpenAiClient {
    connect = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    onClose = vi.fn();
    isOpen = vi.fn().mockReturnValue(true);
    appendAudioPcm16Base64 = vi.fn();
    cancelResponse = vi.fn();
    submitToolResult = vi.fn();
    requestResponse = vi.fn();
    close = vi.fn();

    constructor() {
      clients.push(this);
    }
  }
  return { fakeClients: clients, FakeOpenAiClient };
});

type FakeOpenAiClient = InstanceType<typeof FakeOpenAiClient>;

vi.mock('../../src/realtime/openaiRealtimeClient.ts', () => ({
  OpenAiRealtimeClient: FakeOpenAiClient,
}));

// Imported after the mock is registered (vi.mock is hoisted regardless).
import { RealtimeBridge, type BridgeDeps } from '../../src/realtime/realtimeBridge.ts';

class FakeDeviceWs extends EventEmitter {
  send = vi.fn();
}

const IDLE_RESET_MS = 90_000;

function makeDeps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    apiKey: 'test-key',
    model: 'gpt-realtime-2',
    instructions: 'be brief',
    voice: 'marin',
    tools: [],
    runTool: async () => '',
    idleResetMs: IDLE_RESET_MS,
    ...overrides,
  };
}

// A 16 kHz mono PCM16 frame (160 samples = 10 ms). Content is irrelevant; the
// bridge just resamples and base64-encodes it before handing to the client.
function audioFrame(): Buffer {
  return Buffer.alloc(320);
}

let deviceWs: FakeDeviceWs;
let bridge: RealtimeBridge;

beforeEach(() => {
  fakeClients.length = 0;
  deviceWs = new FakeDeviceWs();
});

afterEach(() => {
  vi.useRealTimers();
});

function currentClient(): FakeOpenAiClient {
  const client = fakeClients.at(-1);
  if (!client) {
    throw new Error('bridge did not construct an OpenAI client');
  }
  return client;
}

// The bridge registers exactly one event listener and one close listener on
// the client in start(); these dig them back out so a test can drive upstream
// events/closures the way the real OpenAI socket would.
function openaiEventListener(client: FakeOpenAiClient): (ev: unknown) => void {
  return client.on.mock.calls[0]![0] as (ev: unknown) => void;
}
function openaiCloseListener(
  client: FakeOpenAiClient,
): (info: { code: number; reason: string }) => void {
  return client.onClose.mock.calls[0]![0] as (info: { code: number; reason: string }) => void;
}

function deviceControl(msg: unknown): void {
  deviceWs.emit('message', Buffer.from(JSON.stringify(msg)), false);
}

describe('RealtimeBridge lazy upstream connect', () => {
  it('does not open the OpenAI session on start()', async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();

    // The whole point of lazy-reconnect: attaching the device WS (e.g. the
    // speaker reconnecting at boot) must NOT spin up an upstream session that
    // would just idle until the reset timer tears it down.
    expect(currentClient().connect).not.toHaveBeenCalled();
    // But the device still gets greeted + parked in idle.
    expect(deviceWs.send).toHaveBeenCalled();
  });

  it('connects on the first device audio frame and drains the buffer', async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    const client = currentClient();

    deviceWs.emit('message', audioFrame(), true);
    // ensureOpenaiConnected is fire-and-forget; let its microtasks settle.
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));

    // The frame that triggered the connect is buffered, then flushed once
    // upstream is ready.
    expect(client.appendAudioPcm16Base64).toHaveBeenCalledTimes(1);
  });

  it('only connects once for a burst of frames before upstream is ready', async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    const client = currentClient();

    for (let i = 0; i < 5; i++) {
      deviceWs.emit('message', audioFrame(), true);
    }
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));
  });
});

describe('RealtimeBridge idle reset', () => {
  it('does not close an upstream that was never connected', async () => {
    vi.useFakeTimers();
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    const client = currentClient();

    // No audio ever arrived, so the upstream is still disconnected. The idle
    // timer must be a no-op rather than calling close() on a dead session.
    await vi.advanceTimersByTimeAsync(IDLE_RESET_MS + 1);

    expect(client.connect).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });

  it('closes the upstream once it is connected and goes idle', async () => {
    vi.useFakeTimers();
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    const client = currentClient();

    deviceWs.emit('message', audioFrame(), true);
    await vi.advanceTimersByTimeAsync(0); // resolve the connect microtask
    expect(client.connect).toHaveBeenCalledTimes(1);

    // The idle timer armed at start() still fires (phase never left idle in
    // this test), and now that the session is connected it tears it down.
    await vi.advanceTimersByTimeAsync(IDLE_RESET_MS + 1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('does not reset while a conversation is active (phase left idle)', async () => {
    vi.useFakeTimers();
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    const client = currentClient();

    deviceWs.emit('message', audioFrame(), true);
    await vi.advanceTimersByTimeAsync(0); // connect resolves → connected
    expect(client.connect).toHaveBeenCalledTimes(1);

    // User starts speaking: phase leaves idle, which must cancel the pending
    // idle-reset timer so a long turn isn't torn down mid-conversation.
    openaiEventListener(client)({ type: 'input_audio_buffer.speech_started' });
    await vi.advanceTimersByTimeAsync(IDLE_RESET_MS + 1);

    expect(client.close).not.toHaveBeenCalled();
  });
});

describe('RealtimeBridge lazy reconnect after upstream close', () => {
  it('reconnects on the next audio frame after the OpenAI session closes', async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    const client = currentClient();

    deviceWs.emit('message', audioFrame(), true);
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));

    // Simulate OpenAI's hard 30-minute cap closing the socket out from under
    // us. The bridge should mark itself disconnected, not tear down the device.
    openaiCloseListener(client)({ code: 1005, reason: '' });

    // Next wake word brings a fresh frame → upstream comes back up.
    deviceWs.emit('message', audioFrame(), true);
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2));
  });
});

describe('RealtimeBridge device control protocol', () => {
  it('replies to ping with pong', async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();

    deviceWs.send.mockClear();
    deviceControl({ type: 'ping' });

    expect(deviceWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));
  });

  it('cancels the in-flight response on interrupt', async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    const client = currentClient();

    deviceControl({ type: 'interrupt' });

    expect(client.cancelResponse).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed control message without crashing', async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();

    expect(() => deviceWs.emit('message', Buffer.from('not json'), false)).not.toThrow();
  });
});

describe('RealtimeBridge device handler resilience', () => {
  it('swallows a throw from the audio fast path instead of crashing the process', async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    const client = currentClient();

    deviceWs.emit('message', audioFrame(), true);
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));

    // A throw inside the ws 'message' handler would otherwise take down the
    // whole Node process (EventEmitter default). The bridge must catch it.
    client.appendAudioPcm16Base64.mockImplementation(() => {
      throw new Error('ws raced a close');
    });
    expect(() => deviceWs.emit('message', audioFrame(), true)).not.toThrow();
  });
});
