import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startRealtimeServer, type RealtimeServer } from '../../src/realtime/index.ts';

let realtimeServer: RealtimeServer | null = null;

afterEach(async () => {
  await realtimeServer?.close();
  realtimeServer = null;
});

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
});
