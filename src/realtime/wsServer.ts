import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { pino } from 'pino';
import { verifyBearer } from './auth.ts';
import { RealtimeBridge, type BridgeDeps } from './realtimeBridge.ts';

const log = pino({ name: 'realtime-ws-server' });

export interface StartOptions {
  port: number;
  token: string;
  buildBridgeDeps: () => Promise<BridgeDeps>;
}

export interface RealtimeServer {
  port: number;
  close: () => Promise<void>;
}

export async function startRealtimeServer(opts: StartOptions): Promise<RealtimeServer> {
  const http: Server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });

  http.on('upgrade', (req, socket, head) => {
    if (req.url !== '/voice') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!verifyBearer(req.headers.authorization, opts.token)) {
        ws.close(4401, 'unauthorized');
        return;
      }
      void (async () => {
        try {
          const deps = await opts.buildBridgeDeps();
          const bridge = new RealtimeBridge(ws, deps);
          await bridge.start();
        } catch (err) {
          log.error({ err }, 'failed to start bridge');
          ws.close(1011, 'bridge start failed');
        }
      })();
    });
  });

  await new Promise<void>((resolve) => http.listen(opts.port, resolve));
  const addr = http.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
  log.info({ port }, 'realtime ws server listening');

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        http.close(() => resolve());
      }),
  };
}
