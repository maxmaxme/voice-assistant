import WebSocket from 'ws';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('realtime-session');

/** Minimal WS contract so tests can inject a fake. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: Buffer | string) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  once(event: 'open', cb: () => void): void;
  once(event: 'close', cb: () => void): void;
  once(event: 'error', cb: (err: Error) => void): void;
}

export type WsFactory = (url: string, apiKey: string) => RealtimeSocket;

export interface RealtimeSessionOptions {
  url: string;
  apiKey: string;
  /** Built lazily so a fresh session.update is sent on every (re)connect. */
  sessionUpdate: () => Record<string, unknown>;
  /** Dispatched for every parsed server event. The synthetic event
   *  `{ type: '__opened' }` fires after each successful open so the caller
   *  can reset per-turn state if needed. */
  onEvent: (ev: Record<string, unknown>) => void;
  wsFactory?: WsFactory;
}

/** Lazy OpenAI Realtime WS connection. The caller invokes `ensureOpen()`
 *  before each turn — if the previous WS died (server closed after the
 *  30-minute cap, network blip, etc.), a fresh one is created on demand.
 *  No background reconnect loop. */
export class RealtimeSession {
  private ws: RealtimeSocket | null = null;
  private closed = false;
  private connecting: Promise<void> | null = null;
  private readonly opts: RealtimeSessionOptions;

  constructor(opts: RealtimeSessionOptions) {
    this.opts = opts;
  }

  /** Open the WS if not already alive. Safe to call repeatedly; concurrent
   *  callers share the same in-flight connect promise. */
  ensureOpen(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('session closed'));
    }
    if (this.ws) {
      return Promise.resolve();
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Send a client event. No-op if not connected. */
  send(payload: Record<string, unknown>): void {
    if (!this.ws) {
      return;
    }
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      log.warn({ err }, 'ws.send failed');
    }
  }

  /** Permanent shutdown. */
  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  private async connect(): Promise<void> {
    const factory = this.opts.wsFactory ?? defaultWsFactory;
    const ws = factory(this.opts.url, this.opts.apiKey);

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });

    ws.send(JSON.stringify({ type: 'session.update', session: this.opts.sessionUpdate() }));

    ws.on('message', (data) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
      } catch (err) {
        log.warn({ err }, 'unparseable ws message');
        return;
      }
      this.opts.onEvent(parsed);
    });

    ws.on('error', (err) => log.error({ err }, 'ws error'));

    ws.on('close', () => {
      log.info('ws closed; will reopen on next turn');
      if (this.ws === ws) {
        this.ws = null;
      }
    });

    this.ws = ws;
    this.opts.onEvent({ type: '__opened' });
  }
}

function defaultWsFactory(url: string, apiKey: string): RealtimeSocket {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    on: (event, cb) => {
      ws.on(event, cb);
    },
    once: (event, cb) => {
      ws.once(event, cb);
    },
  };
}
