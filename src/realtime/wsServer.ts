import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { createLogger } from '../utils/logger.ts';
import { bearerToken } from './auth.ts';
import { RealtimeBridge, type BridgeDeps } from './realtimeBridge.ts';
import type { RealtimeDeviceConfig } from '../settings/realtimeConfig.ts';

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
  /** Poll the DB-backed device-facing realtime config and push changes to
   *  already-connected devices (re-sent as `hello`) so admin edits apply without
   *  a restart. Diffs the whole config object, so new device settings are
   *  carried automatically. Omit to disable polling. */
  watchDeviceConfig?: {
    intervalMs: number;
    read: () => RealtimeDeviceConfig;
  };
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

  // Live bridges, so the config watcher below can push device-facing settings
  // changes to connected speakers. Membership is tied to the ws lifetime.
  const bridges = new Set<RealtimeBridge>();

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
          bridges.add(bridge);
          ws.on('close', () => bridges.delete(bridge));
          await bridge.start();
        } catch (err) {
          log.error({ err }, 'failed to start bridge');
          ws.close(1011, 'bridge start failed');
        }
      })();
    });
  });

  // Poll the DB-backed device config and push changes to connected devices (a
  // re-sent `hello`) — the admin panel only writes the settings, this process
  // owns the WS. JSON-diff so any field carries automatically; baseline from the
  // current value so only later edits push.
  let configWatch: NodeJS.Timeout | null = null;
  if (opts.watchDeviceConfig) {
    const { intervalMs, read } = opts.watchDeviceConfig;
    let last = JSON.stringify(read());
    configWatch = setInterval(() => {
      const cur = read();
      const curStr = JSON.stringify(cur);
      if (curStr === last) {
        return;
      }
      last = curStr;
      log.info({ ...cur, devices: bridges.size }, 'device config changed — pushing to devices');
      for (const bridge of bridges) {
        try {
          bridge.applyDeviceConfig(cur);
        } catch (err) {
          log.debug({ err }, 'failed to push device config (device likely closing)');
        }
      }
    }, intervalMs);
    configWatch.unref?.();
  }

  await new Promise<void>((resolve) => http.listen(opts.port, resolve));
  const addr = http.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
  log.info({ port }, 'realtime ws server listening');

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        if (configWatch) {
          clearInterval(configWatch);
        }
        wss.close();
        http.close(() => resolve());
      }),
  };
}
