import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
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
  /** Server ping interval for liveness detection. A peer that misses a full
   *  round (no pong between two pings) is terminate()d, so a half-open TCP
   *  connection (speaker power blip) can't leave a zombie bridge holding the
   *  OpenAI session open. Defaults to 30s; 0 disables. */
  heartbeatMs?: number;
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

  // Peers that answered the last heartbeat ping (or just connected). The
  // heartbeat loop below consumes membership each round.
  const alive = new WeakSet<WebSocket>();

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
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
      // buildBridgeDeps does a live MCP round-trip, so there's a real window
      // between the socket opening and the bridge attaching its listeners.
      // Frames arriving in that window (a device that talks immediately) must
      // be buffered and replayed, not silently dropped.
      const preReady: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
      let closedBeforeReady = false;
      const bufferMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
        preReady.push({ data, isBinary });
      };
      const noteClose = (): void => {
        closedBeforeReady = true;
      };
      ws.on('message', bufferMessage);
      ws.once('close', noteClose);
      void (async () => {
        try {
          const deps = await opts.buildBridgeDeps(auth);
          ws.off('message', bufferMessage);
          ws.off('close', noteClose);
          if (closedBeforeReady) {
            log.info('device closed before the bridge was ready — skipping bridge start');
            return;
          }
          const bridge = new RealtimeBridge(ws, deps);
          bridges.add(bridge);
          ws.on('close', () => bridges.delete(bridge));
          await bridge.start();
          for (const { data, isBinary } of preReady) {
            ws.emit('message', data, isBinary);
          }
        } catch (err) {
          log.error({ err }, 'failed to start bridge');
          ws.close(1011, 'bridge start failed');
        }
      })();
    });
  });

  // Liveness: a half-open TCP connection (speaker power/Wi-Fi blip) never
  // sends a FIN, so without pings the dead socket sits in `bridges` forever
  // with its OpenAI session held open. Standard ws heartbeat: ping every
  // round, terminate a peer whose pong from the previous round never came —
  // terminate() fires 'close', which runs the normal bridge cleanup.
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  let heartbeat: NodeJS.Timeout | null = null;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (!alive.has(ws)) {
          log.warn('terminating unresponsive device ws (missed heartbeat round)');
          ws.terminate();
          continue;
        }
        alive.delete(ws);
        ws.ping();
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  }

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
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        // noServer mode: wss.close() does not touch connected clients, so a
        // graceful shutdown must close each device socket itself. 1001 =
        // going away; the per-socket 'close' handlers run the normal bridge
        // cleanup (and http.close() below only resolves once the sockets are
        // actually gone).
        for (const ws of wss.clients) {
          ws.close(1001, 'server shutting down');
        }
        bridges.clear();
        wss.close();
        http.close(() => resolve());
      }),
  };
}
