import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { startRealtimeServer, type RealtimeServer } from '../../src/realtime/index.ts';
import type { BridgeDeps } from '../../src/realtime/realtimeBridge.ts';

let realtimeServer: RealtimeServer | null = null;

afterEach(async () => {
  await realtimeServer?.close();
  realtimeServer = null;
});

function makeDeps(): BridgeDeps {
  return {
    apiKey: 'test-key',
    model: 'gpt-realtime-2',
    instructions: 'be brief',
    voice: 'marin',
    tools: [],
    runTool: async () => '',
  };
}

function connect(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/voice`, {
    headers: { Authorization: 'Bearer good-tok' },
  });
}

describe('startRealtimeServer', () => {
  it('rejects connections whose token resolves to no voice identity', async () => {
    realtimeServer = await startRealtimeServer({
      port: 0,
      authorize: () => null,
      buildBridgeDeps: async () => {
        throw new Error('should not be called for unauth');
      },
    });
    const ws = new WebSocket(`ws://127.0.0.1:${realtimeServer.port}/voice`, {
      headers: { Authorization: 'Bearer whatever' },
    });
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {
        /* socket may error before close; rely on close */
      });
    });
    expect(closeCode).toBe(4401);
  });

  it('authorizes by token and reaches buildBridgeDeps with the resolved speaker', async () => {
    let seen: number | null = null;
    realtimeServer = await startRealtimeServer({
      port: 0,
      authorize: (token) => (token === 'good-tok' ? { userId: 7 } : null),
      buildBridgeDeps: async (auth) => {
        seen = auth.userId;
        // We only assert the auth plumbing; fail the bridge build so we don't
        // need a real OpenAI session.
        throw new Error('bridge build short-circuited');
      },
    });
    const ws = new WebSocket(`ws://127.0.0.1:${realtimeServer.port}/voice`, {
      headers: { Authorization: 'Bearer good-tok' },
    });
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
    });
    expect(seen).toBe(7);
    expect(closeCode).toBe(1011); // bridge start failed
  });

  it('replays device messages that arrive before the bridge is ready', async () => {
    // buildBridgeDeps does a live MCP round-trip per connection; a device that
    // starts talking right after the WS opens must not have those frames
    // silently dropped while deps are still resolving.
    let resolveDeps!: (deps: BridgeDeps) => void;
    realtimeServer = await startRealtimeServer({
      port: 0,
      authorize: () => ({ userId: 1 }),
      buildBridgeDeps: () => new Promise<BridgeDeps>((r) => (resolveDeps = r)),
    });
    const ws = connect(realtimeServer.port);
    const received: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => {
      try {
        received.push(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch {
        // binary frames irrelevant here
      }
    });
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.send(JSON.stringify({ type: 'ping' }));
    // Let the frame reach the server while the bridge is still not ready.
    await new Promise((r) => setTimeout(r, 50));
    resolveDeps(makeDeps());

    await vi.waitFor(() => expect(received.some((m) => m.type === 'pong')).toBe(true));
    ws.close();
  });
});

describe('startRealtimeServer config watcher', () => {
  it('re-sends hello to connected devices when the polled config changes, and only then', async () => {
    // The admin panel only writes the settings row; this process owns the WS.
    // The watcher polls read(), JSON-diffs, and pushes a fresh `hello` so the
    // device picks up e.g. a wakeChime flip without a restart.
    let config = { wakeChime: true };
    realtimeServer = await startRealtimeServer({
      port: 0,
      authorize: () => ({ userId: 1 }),
      buildBridgeDeps: async () => ({ ...makeDeps(), wakeChime: config.wakeChime }),
      watchDeviceConfig: { intervalMs: 30, read: () => ({ ...config }) },
    });
    const ws = connect(realtimeServer.port);
    const hellos: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.type === 'hello') {
        hellos.push(msg);
      }
    });
    await new Promise<void>((r) => ws.on('open', () => r()));

    // Bridge start sends the initial hello with the current config.
    await vi.waitFor(() => expect(hellos).toHaveLength(1));
    expect(hellos[0]).toMatchObject({ wakeChime: true });

    // Several poll rounds with an unchanged config: no re-send.
    await new Promise((r) => setTimeout(r, 120));
    expect(hellos).toHaveLength(1);

    config = { wakeChime: false };
    await vi.waitFor(() => expect(hellos).toHaveLength(2));
    expect(hellos[1]).toMatchObject({ wakeChime: false });

    // The push is a one-off per change, not a re-send every round.
    await new Promise((r) => setTimeout(r, 120));
    expect(hellos).toHaveLength(2);
    ws.close();
  });
});

describe('startRealtimeServer close', () => {
  it('sends a going-away close (1001) to connected devices and resolves', async () => {
    realtimeServer = await startRealtimeServer({
      port: 0,
      authorize: () => ({ userId: 1 }),
      buildBridgeDeps: async () => makeDeps(),
    });
    const ws = connect(realtimeServer.port);
    await new Promise<void>((r) => ws.on('open', () => r()));
    const closeCode = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
    });

    await realtimeServer.close();
    realtimeServer = null;
    expect(await closeCode).toBe(1001);
  });
});

describe('startRealtimeServer heartbeat', () => {
  it('terminates a silent peer that misses a heartbeat round', async () => {
    realtimeServer = await startRealtimeServer({
      port: 0,
      authorize: () => ({ userId: 1 }),
      buildBridgeDeps: async () => makeDeps(),
      heartbeatMs: 40,
    });
    const ws = connect(realtimeServer.port);
    // Half-open connection (speaker power blip): the peer stops answering at
    // the protocol level. `ws` auto-pongs on ping, so suppress it.
    (ws as unknown as { pong: () => void }).pong = () => {};
    await new Promise<void>((r) => ws.on('open', () => r()));

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
    });
    expect(closeCode).toBe(1006); // terminated, not a clean close
  });

  it('keeps a responsive peer connected across heartbeat rounds', async () => {
    realtimeServer = await startRealtimeServer({
      port: 0,
      authorize: () => ({ userId: 1 }),
      buildBridgeDeps: async () => makeDeps(),
      heartbeatMs: 30,
    });
    const ws = connect(realtimeServer.port);
    await new Promise<void>((r) => ws.on('open', () => r()));

    // Several heartbeat rounds with the client's auto-pong intact.
    await new Promise((r) => setTimeout(r, 150));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
