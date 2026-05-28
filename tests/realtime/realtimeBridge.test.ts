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

// Feed an OpenAI Realtime server event through the listener the bridge wired
// up in start(), then let any async work it kicks off settle.
async function feedOpenAi(client: FakeOpenAiClient, ev: unknown): Promise<void> {
  openaiEventListener(client)(ev);
  await new Promise((r) => setTimeout(r, 0));
}

// Decode the JSON control messages the bridge pushed to the device.
function serverMessages(): Array<Record<string, unknown>> {
  return deviceWs.send.mock.calls
    .map((c) => c[0])
    .filter((a): a is string => typeof a === 'string')
    .map((s) => {
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((m): m is Record<string, unknown> => m !== null);
}

function phasesSent(): string[] {
  return serverMessages()
    .filter((m) => m.type === 'phase')
    .map((m) => m.value as string);
}

// Count the binary PCM frames forwarded to the device (audio out).
function audioFramesSent(): number {
  return deviceWs.send.mock.calls.filter((c) => Buffer.isBuffer(c[0])).length;
}

// A base64-encoded PCM16 chunk, the shape response.output_audio.delta carries.
function audioDelta(): string {
  return Buffer.alloc(8).toString('base64');
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

  it('returns to idle and re-arms the idle-reset timer when a turn aborts via interrupt', async () => {
    vi.useFakeTimers();
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    const client = currentClient();

    // Wake fires: the device opens a turn (leaves idle → listening, which
    // clears the idle-reset timer) and mic frames (silence) flow, so the
    // upstream connects.
    deviceControl({ type: 'start' });
    deviceWs.emit('message', audioFrame(), true);
    await vi.advanceTimersByTimeAsync(0); // resolve the connect microtask
    expect(client.connect).toHaveBeenCalledTimes(1);

    // No speech: the device's 7 s watchdog aborts with `interrupt` and goes
    // idle locally. The bridge must mirror that — phase back to idle, idle-reset
    // re-armed — otherwise it stays stuck in listening and the upstream session
    // leaks open forever.
    deviceWs.send.mockClear();
    deviceControl({ type: 'interrupt' });
    expect(phasesSent()).toEqual(['idle']);

    await vi.advanceTimersByTimeAsync(IDLE_RESET_MS + 1);
    expect(client.close).toHaveBeenCalledTimes(1);
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

  it('enters listening as soon as the device sends start (wake word)', async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    deviceWs.send.mockClear(); // drop hello + initial idle

    // The device sends `start` the moment the wake word fires — before any
    // audio, well before OpenAI's server VAD emits speech_started. The bridge
    // must reflect "listening" immediately, not lag until speech is detected.
    deviceControl({ type: 'start' });

    expect(phasesSent()).toEqual(['listening']);
  });

  it('treats a barge-in wake (single start mid-reply) as a fresh listening turn', async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    const client = currentClient();
    // Drive the bridge into replying, like a reply is playing out.
    await feedOpenAi(client, { type: 'response.output_audio.delta', delta: audioDelta() });
    deviceWs.send.mockClear();

    // Barge-in: the device sends a single `start` (it no longer pairs it with a
    // separate interrupt). `start` alone must cut the residual reply and move
    // straight to listening — no idle blip in between.
    deviceControl({ type: 'start' });

    expect(phasesSent()).toEqual(['listening']);
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

// The phase the device shows on its LED ring tracks the conversation state.
// These walk the happy-path turn: listening → thinking → replying → idle.
describe('RealtimeBridge phase / status machine', () => {
  let client: FakeOpenAiClient;

  beforeEach(async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    client = currentClient();
    deviceWs.send.mockClear(); // drop the initial hello + idle from start()
  });

  it('enters listening when the user starts speaking', async () => {
    await feedOpenAi(client, { type: 'input_audio_buffer.speech_started' });
    expect(phasesSent()).toEqual(['listening']);
  });

  it('enters thinking when the user stops speaking', async () => {
    await feedOpenAi(client, { type: 'input_audio_buffer.speech_stopped' });
    expect(phasesSent()).toEqual(['thinking']);
  });

  it('forwards reply audio to the device and shows the replying phase', async () => {
    await feedOpenAi(client, { type: 'response.output_audio.delta', delta: audioDelta() });
    expect(audioFramesSent()).toBe(1);
    expect(phasesSent()).toContain('replying');
  });

  it('does not re-emit the phase for every audio delta (dedup)', async () => {
    await feedOpenAi(client, { type: 'response.output_audio.delta', delta: audioDelta() });
    await feedOpenAi(client, { type: 'response.output_audio.delta', delta: audioDelta() });
    await feedOpenAi(client, { type: 'response.output_audio.delta', delta: audioDelta() });
    expect(audioFramesSent()).toBe(3);
    expect(phasesSent().filter((p) => p === 'replying')).toHaveLength(1);
  });

  it('returns to idle after a plain text response finishes', async () => {
    await feedOpenAi(client, { type: 'input_audio_buffer.speech_stopped' }); // → thinking
    await feedOpenAi(client, {
      type: 'response.done',
      response: { id: 'r1', output: [{ type: 'message' }] },
    });
    expect(phasesSent()).toEqual(['thinking', 'idle']);
  });
});

// Barge-in: the user says a wake/stop word while the assistant is talking.
// OpenAI keeps flushing queued audio for the cancelled response after we ask
// it to stop; the bridge must drop that tail so the device doesn't replay it.
describe('RealtimeBridge barge-in / interruption', () => {
  let client: FakeOpenAiClient;

  beforeEach(async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    client = currentClient();
    deviceWs.send.mockClear();
  });

  it('cancels the upstream response on a device interrupt', async () => {
    deviceControl({ type: 'interrupt' });
    expect(client.cancelResponse).toHaveBeenCalledTimes(1);
  });

  it('drops queued reply audio after an interrupt until a new response starts', async () => {
    // Assistant is mid-reply.
    await feedOpenAi(client, { type: 'response.output_audio.delta', delta: audioDelta() });
    expect(audioFramesSent()).toBe(1);

    // User barges in.
    deviceControl({ type: 'interrupt' });

    // Tail deltas of the cancelled response keep arriving — they must NOT be
    // forwarded, or the device replays audio the user already talked over.
    await feedOpenAi(client, { type: 'response.output_audio.delta', delta: audioDelta() });
    await feedOpenAi(client, { type: 'response.output_audio.delta', delta: audioDelta() });
    expect(audioFramesSent()).toBe(1);

    // A genuinely new response begins → audio flows to the device again.
    await feedOpenAi(client, { type: 'response.created', response: { id: 'r2' } });
    await feedOpenAi(client, { type: 'response.output_audio.delta', delta: audioDelta() });
    expect(audioFramesSent()).toBe(2);
  });

  it('cancels the residual reply and drops its queued audio when start arrives mid-reply', async () => {
    // Assistant is mid-reply when the user barges in with a fresh wake word.
    await feedOpenAi(client, { type: 'response.output_audio.delta', delta: audioDelta() });
    expect(audioFramesSent()).toBe(1);
    deviceWs.send.mockClear();

    // A single `start` (no separate interrupt) must cancel the in-flight reply
    // upstream and move to listening.
    deviceControl({ type: 'start' });
    expect(client.cancelResponse).toHaveBeenCalledTimes(1);
    expect(phasesSent()).toEqual(['listening']);

    // Tail deltas of the cancelled reply must not reach the device.
    await feedOpenAi(client, { type: 'response.output_audio.delta', delta: audioDelta() });
    expect(audioFramesSent()).toBe(0);

    // The new turn's response clears the drop flag → audio flows again.
    await feedOpenAi(client, { type: 'response.created', response: { id: 'r2' } });
    await feedOpenAi(client, { type: 'response.output_audio.delta', delta: audioDelta() });
    expect(audioFramesSent()).toBe(1);
  });
});

// Whisper transcribes the input in parallel with the model generating a reply.
// On silence/noise it hallucinates ("...", "뿅!"), so the bridge cancels the
// spurious turn rather than letting the assistant say "I didn't catch that".
describe('RealtimeBridge noise-transcript guard', () => {
  let client: FakeOpenAiClient;

  beforeEach(async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    client = currentClient();
  });

  it('cancels the in-flight response on an empty transcript', async () => {
    await feedOpenAi(client, {
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '   ',
    });
    expect(client.cancelResponse).toHaveBeenCalledTimes(1);
  });

  it('cancels when the transcript has no letters or digits', async () => {
    await feedOpenAi(client, {
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '...',
    });
    expect(client.cancelResponse).toHaveBeenCalledTimes(1);
  });

  it('lets a real transcript through without cancelling', async () => {
    await feedOpenAi(client, {
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'turn off the kitchen light',
    });
    expect(client.cancelResponse).not.toHaveBeenCalled();
  });
});

// Tool calls flow through the same runTool the agent core uses. The tricky
// part is the follow-up gate: real tools must trigger exactly one follow-up
// response after the whole batch; the built-in flow-control tools must not.
describe('RealtimeBridge tool dispatch', () => {
  let client: FakeOpenAiClient;
  let runTool: ReturnType<typeof vi.fn<(name: string, args: unknown) => Promise<string>>>;

  async function callTool(callId: string, name: string, args: string): Promise<void> {
    await feedOpenAi(client, {
      type: 'response.function_call_arguments.done',
      call_id: callId,
      name,
      arguments: args,
    });
  }
  async function finishResponse(id: string, names: string[]): Promise<void> {
    await feedOpenAi(client, {
      type: 'response.done',
      response: { id, output: names.map((name) => ({ type: 'function_call', name })) },
    });
  }

  beforeEach(async () => {
    runTool = vi.fn<(name: string, args: unknown) => Promise<string>>().mockResolvedValue('done');
    bridge = new RealtimeBridge(deviceWs as never, makeDeps({ runTool }));
    await bridge.start();
    client = currentClient();
    deviceWs.send.mockClear();
  });

  it('runs a real tool, submits its result, and requests one follow-up response', async () => {
    await callTool('c1', 'HassTurnOff', '{"name":"Kitchen Light"}');
    expect(runTool).toHaveBeenCalledWith('HassTurnOff', { name: 'Kitchen Light' });
    expect(client.submitToolResult).toHaveBeenCalledWith('c1', 'done');

    await finishResponse('r1', ['HassTurnOff']);
    expect(client.requestResponse).toHaveBeenCalledTimes(1);
  });

  it('stays in thinking (not idle) across a tool call so the mic does not reopen', async () => {
    await feedOpenAi(client, { type: 'input_audio_buffer.speech_stopped' }); // → thinking
    await callTool('c1', 'HassTurnOff', '{}');
    await finishResponse('r1', ['HassTurnOff']);
    // Never dropped back to idle — a pure tool-call response must keep the
    // device in thinking until the follow-up reply arrives.
    expect(phasesSent()).toEqual(['thinking']);
  });

  it('still requests the follow-up when the tool throws', async () => {
    runTool.mockRejectedValueOnce(new Error('HA unreachable'));
    await callTool('c1', 'HassTurnOff', '{}');
    expect(client.submitToolResult).toHaveBeenCalledWith(
      'c1',
      JSON.stringify({ error: 'HA unreachable' }),
    );

    await finishResponse('r1', ['HassTurnOff']);
    expect(client.requestResponse).toHaveBeenCalledTimes(1);
  });

  it('fires exactly one follow-up for a parallel tool batch', async () => {
    await callTool('c1', 'HassTurnOff', '{}');
    await callTool('c2', 'HassTurnOn', '{}');
    await finishResponse('r1', ['HassTurnOff', 'HassTurnOn']);
    expect(client.requestResponse).toHaveBeenCalledTimes(1);
  });

  it('wait_for_user stays silent: no follow-up, drops to idle', async () => {
    await feedOpenAi(client, { type: 'input_audio_buffer.speech_stopped' }); // → thinking
    await callTool('c1', 'wait_for_user', '{}');
    expect(client.submitToolResult).toHaveBeenCalledWith('c1', '{}');
    await finishResponse('r1', ['wait_for_user']);
    expect(client.requestResponse).not.toHaveBeenCalled();
    expect(phasesSent()).toContain('idle');
    expect(runTool).not.toHaveBeenCalled();
  });

  it('request_follow_up opens the device mic window without a model follow-up', async () => {
    await callTool('c1', 'request_follow_up', '{}');
    expect(serverMessages().some((m) => m.type === 'request_follow_up')).toBe(true);
    await finishResponse('r1', ['request_follow_up']);
    expect(client.requestResponse).not.toHaveBeenCalled();
  });
});

// Some upstream "errors" are normal lifecycle events. Surfacing them would
// fire the device's error chime + red LED for no reason.
describe('RealtimeBridge upstream error handling', () => {
  let client: FakeOpenAiClient;

  beforeEach(async () => {
    bridge = new RealtimeBridge(deviceWs as never, makeDeps());
    await bridge.start();
    client = currentClient();
    deviceWs.send.mockClear();
  });

  it('suppresses benign session_expired errors', async () => {
    await feedOpenAi(client, { type: 'error', error: { code: 'session_expired' } });
    expect(serverMessages().some((m) => m.type === 'error')).toBe(false);
  });

  it('suppresses benign response_cancel_not_active errors', async () => {
    await feedOpenAi(client, { type: 'error', error: { code: 'response_cancel_not_active' } });
    expect(serverMessages().some((m) => m.type === 'error')).toBe(false);
  });

  it('forwards genuine errors to the device', async () => {
    await feedOpenAi(client, {
      type: 'error',
      error: { code: 'server_error', message: 'upstream blew up' },
    });
    expect(serverMessages()).toContainEqual({ type: 'error', message: 'upstream blew up' });
  });
});
