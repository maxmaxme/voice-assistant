import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startRealtimeServer, type RealtimeServer } from '../../src/realtime/index.ts';

let realtimeServer: RealtimeServer | null = null;

afterEach(async () => {
  await realtimeServer?.close();
  realtimeServer = null;
});

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
});
