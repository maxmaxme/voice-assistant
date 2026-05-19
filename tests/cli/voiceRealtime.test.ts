import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runVoiceRealtimeMode } from '../../src/cli/runners/voiceRealtime.ts';
import type { RealtimeSocket, MicLike, SpeakerLike } from '../../src/cli/runners/voiceRealtime.ts';
import type { McpClient } from '../../src/mcp/types.ts';
import type { MemoryStore, ScheduledActionsAdapter } from '../../src/memory/types.ts';
import type { TelegramSender } from '../../src/telegram/types.ts';

class FakeWs extends EventEmitter implements RealtimeSocket {
  sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.emit('close');
  }
  // EventEmitter already provides `on`; the typed overloads on RealtimeSocket
  // are structurally satisfied by its untyped one.
}

class FakeMic implements MicLike {
  started = false;
  stopped = false;
  listener: ((f: Int16Array) => void) | null = null;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  onFrame(cb: (f: Int16Array) => void): () => void {
    this.listener = cb;
    return () => {
      this.listener = null;
    };
  }
}

class FakeSpeaker implements SpeakerLike {
  chunks: Buffer[] = [];
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  write(c: Buffer): void {
    this.chunks.push(c);
  }
  stop(): void {
    this.stopped = true;
  }
}

function makeMcp(): McpClient {
  return {
    listTools: vi.fn(async () => [
      { name: 'HassTurnOn', description: 'Turns on a device', inputSchema: { type: 'object' } },
    ]),
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => ({
      content: [{ type: 'text', text: `called ${name} with ${JSON.stringify(args)}` }],
      isError: false,
    })),
  } as unknown as McpClient;
}

function makeMemory(): MemoryStore {
  const noop: ScheduledActionsAdapter = {
    add: () => {
      throw new Error('not used');
    },
    listActive: () => [],
    listDue: () => [],
    markFired: () => {},
    markError: () => {},
    cancel: () => false,
    get: () => null,
  };
  return {
    profile: { remember: () => {}, recall: () => ({}), forget: () => {}, close: () => {} },
    scheduledActions: noop,
    telegramSessions: { get: () => null, save: () => {}, delete: () => {} },
    close: () => {},
  };
}

describe('runVoiceRealtimeMode', () => {
  it('opens ws, sends session.update with tools, and shuts down on close', async () => {
    const ws = new FakeWs();
    const mic = new FakeMic();
    const speaker = new FakeSpeaker();
    let promptCount = 0;
    const promptResolvers: Array<() => void> = [];
    const promptRejecters: Array<(err: Error) => void> = [];

    const runP = runVoiceRealtimeMode({
      apiKey: 'sk-test',
      model: 'gpt-realtime',
      systemPrompt: 'be brief',
      mcp: makeMcp(),
      memory: makeMemory(),
      telegram: {} as TelegramSender,
      wsFactory: () => ws,
      micFactory: () => mic,
      speakerFactory: () => speaker,
      prompt: () =>
        new Promise<void>((resolve, reject) => {
          promptCount++;
          promptResolvers.push(resolve);
          promptRejecters.push(reject);
        }),
    });

    // WS is opened lazily on first Enter, so emit `open` after we press Enter.
    await waitFor(() => promptCount === 1);
    promptResolvers[0]!();
    setImmediate(() => ws.emit('open'));
    await waitFor(() => mic.started);
    expect(mic.listener).toBeTruthy();

    // session.update should have been sent on first connect.
    const sessionUpdate = ws.sent.find((s) => JSON.parse(s).type === 'session.update');
    expect(sessionUpdate).toBeDefined();
    const parsed = JSON.parse(sessionUpdate!);
    expect(parsed.session.instructions).toBe('be brief');
    expect(parsed.session.tools.length).toBeGreaterThan(0);
    const toolNames = parsed.session.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('HassTurnOn');
    expect(toolNames).toContain('remember');

    // Server VAD configured — no manual commit/response.create from client.
    expect(parsed.session.audio.input.turn_detection.type).toBe('server_vad');

    // Push one mic frame; expect an append event.
    const frame = new Int16Array([1, -1, 2, -2]);
    mic.listener!(frame);
    const appends = ws.sent.filter((s) => JSON.parse(s).type === 'input_audio_buffer.append');
    expect(appends.length).toBe(1);

    // Server VAD signals end of speech → runner stops the mic, then awaits
    // response.done before re-prompting.
    ws.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    await waitFor(() => mic.stopped);
    ws.emit('message', JSON.stringify({ type: 'response.done' }));

    // Now we should be back at the prompt for the next turn.
    await waitFor(() => promptCount === 2);
    // Tear the runner down by rejecting the pending prompt.
    promptRejecters[1]!(new Error('test-done'));
    await runP.catch(() => {});
    expect(speaker.stopped).toBe(true);
  });

  it('dispatches a tool call on response.done and replies with function_call_output', async () => {
    const ws = new FakeWs();
    const mic = new FakeMic();
    const speaker = new FakeSpeaker();
    const mcp = makeMcp();
    let promptCount = 0;
    const promptResolvers: Array<() => void> = [];
    const promptRejecters: Array<(err: Error) => void> = [];

    const runP = runVoiceRealtimeMode({
      apiKey: 'sk-test',
      model: 'gpt-realtime',
      systemPrompt: 'x',
      mcp,
      memory: makeMemory(),
      telegram: {} as TelegramSender,
      wsFactory: () => ws,
      micFactory: () => mic,
      speakerFactory: () => speaker,
      prompt: () =>
        new Promise<void>((resolve, reject) => {
          promptCount++;
          promptResolvers.push(resolve);
          promptRejecters.push(reject);
        }),
    });

    await waitFor(() => promptCount === 1);
    promptResolvers[0]!();
    setImmediate(() => ws.emit('open'));
    await waitFor(() => mic.started);

    // Server emits a function-call output item, then response.done.
    ws.emit(
      'message',
      JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'c1',
          name: 'HassTurnOn',
          arguments: '{"name":"Kitchen"}',
        },
      }),
    );
    ws.emit('message', JSON.stringify({ type: 'response.done' }));

    await waitFor(() =>
      ws.sent.some((s) => {
        const ev = JSON.parse(s);
        return ev.type === 'conversation.item.create' && ev.item?.call_id === 'c1';
      }),
    );

    const outEvent = ws.sent
      .map((s) => JSON.parse(s))
      .find(
        (ev) => ev.type === 'conversation.item.create' && ev.item?.type === 'function_call_output',
      );
    expect(outEvent.item.output).toContain('called HassTurnOn');
    // After the tool reply, a fresh response.create should follow.
    const afterIndex = ws.sent.findIndex(
      (s) =>
        JSON.parse(s).type === 'conversation.item.create' && JSON.parse(s).item?.call_id === 'c1',
    );
    const next = ws.sent
      .slice(afterIndex + 1)
      .map((s) => JSON.parse(s))
      .find((ev) => ev.type === 'response.create');
    expect(next).toBeDefined();

    // Unblock the runner: signal end of speech + a final empty response.
    ws.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    ws.emit('message', JSON.stringify({ type: 'response.done' }));
    await waitFor(() => promptCount === 2);
    promptRejecters[1]!(new Error('test-done'));
    await runP.catch(() => {});
  });

  it('decodes response.output_audio.delta into speaker chunks', async () => {
    const ws = new FakeWs();
    const mic = new FakeMic();
    const speaker = new FakeSpeaker();
    let promptCount = 0;
    const promptResolvers: Array<() => void> = [];
    const promptRejecters: Array<(err: Error) => void> = [];

    const runP = runVoiceRealtimeMode({
      apiKey: 'sk-test',
      model: 'gpt-realtime',
      systemPrompt: 'x',
      mcp: makeMcp(),
      memory: makeMemory(),
      telegram: {} as TelegramSender,
      wsFactory: () => ws,
      micFactory: () => mic,
      speakerFactory: () => speaker,
      prompt: () =>
        new Promise<void>((resolve, reject) => {
          promptCount++;
          promptResolvers.push(resolve);
          promptRejecters.push(reject);
        }),
    });

    await waitFor(() => promptCount === 1);
    promptResolvers[0]!();
    setImmediate(() => ws.emit('open'));
    await waitFor(() => mic.started);

    const pcm = Buffer.from([0x10, 0x20, 0x30, 0x40]);
    ws.emit(
      'message',
      JSON.stringify({ type: 'response.output_audio.delta', delta: pcm.toString('base64') }),
    );

    await waitFor(() => speaker.chunks.length === 1);
    expect(speaker.chunks[0]!.equals(pcm)).toBe(true);

    ws.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    ws.emit('message', JSON.stringify({ type: 'response.done' }));
    await waitFor(() => promptCount === 2);
    promptRejecters[1]!(new Error('test-done'));
    await runP.catch(() => {});
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timeout waiting for condition');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
