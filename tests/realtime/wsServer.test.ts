import { describe, it, expect, afterEach } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { startRealtimeServer, type RealtimeServer } from '../../src/realtime/index.ts';

let realtimeServer: RealtimeServer | null = null;
let mockOpenAi: WebSocketServer | null = null;

afterEach(async () => {
  await realtimeServer?.close();
  realtimeServer = null;
  mockOpenAi?.close();
  mockOpenAi = null;
  delete process.env.OPENAI_REALTIME_URL_OVERRIDE;
});

function startMockOpenAi(): Promise<{
  port: number;
  events: unknown[];
  sendEvent: (ev: unknown) => void;
}> {
  return new Promise((resolve) => {
    const events: unknown[] = [];
    let clientWs: WebSocket | null = null;
    const wss = new WebSocketServer({ port: 0 });
    mockOpenAi = wss;
    wss.on('connection', (ws) => {
      clientWs = ws;
      ws.on('message', (data) => events.push(JSON.parse(data.toString())));
    });
    wss.on('listening', () => {
      const addr = wss.address() as AddressInfo;
      resolve({
        port: addr.port,
        events,
        sendEvent: (ev) => clientWs?.send(JSON.stringify(ev)),
      });
    });
  });
}

describe('startRealtimeServer', () => {
  it('rejects unauthorized connections', async () => {
    realtimeServer = await startRealtimeServer({
      port: 0,
      token: 'secret',
      buildBridgeDeps: async () => {
        throw new Error('should not be called for unauth');
      },
    });
    const ws = new WebSocket(`ws://127.0.0.1:${realtimeServer.port}/voice`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {
        /* socket may error before close; rely on close */
      });
    });
    expect(closeCode).toBe(4401);
  });

  it('accepts authorized connection and forwards audio to OpenAI', async () => {
    const mock = await startMockOpenAi();
    process.env.OPENAI_REALTIME_URL_OVERRIDE = `ws://127.0.0.1:${mock.port}`;
    realtimeServer = await startRealtimeServer({
      port: 0,
      token: 'secret',
      buildBridgeDeps: async () => ({
        apiKey: 'sk-fake',
        model: 'gpt-realtime',
        instructions: 'be brief',
        voice: 'alloy',
        tools: [],
        runTool: async () => 'ok',
      }),
    });
    const ws = new WebSocket(`ws://127.0.0.1:${realtimeServer.port}/voice`, {
      headers: { Authorization: 'Bearer secret' },
    });
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    // Wait for the bridge to send its `hello` control message, which means
    // it has finished connecting to OpenAI and wired up the message handler.
    await new Promise<void>((resolve) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          return;
        }
        try {
          const parsed = JSON.parse(data.toString());
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'type' in parsed &&
            (parsed as { type: unknown }).type === 'hello'
          ) {
            resolve();
          }
        } catch {
          /* ignore */
        }
      });
    });
    const pcm = Buffer.alloc(320, 0);
    ws.send(pcm, { binary: true });
    await new Promise((r) => setTimeout(r, 150));
    const hasAppend = mock.events.some(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        'type' in e &&
        (e as { type: unknown }).type === 'input_audio_buffer.append',
    );
    expect(hasAppend).toBe(true);
    ws.close();
  });
});
