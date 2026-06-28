import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { createLogger } from '../utils/logger.ts';
import { bearerToken } from './auth.ts';
import { RealtimeBridge, type BridgeDeps } from './realtimeBridge.ts';

const log = createLogger('realtime-ws-server');

/** A device that authenticated against the registered `voice` identities. */
export interface SpeakerAuth {
  userId: number;
}

export interface StartOptions {
  port: number;
  /** Resolve a device's bearer token to its owning principal (hash lookup
   *  against the `voice` identities), or null to reject the handshake (4401). */
  authorize: (token: string) => SpeakerAuth | null;
  buildBridgeDeps: (auth: SpeakerAuth) => Promise<BridgeDeps>;
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
      const token = bearerToken(req.headers.authorization);
      const auth = token ? opts.authorize(token) : null;
      if (!auth) {
        ws.close(4401, 'unauthorized');
        return;
      }
      void (async () => {
        try {
          const deps = await opts.buildBridgeDeps(auth);
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
