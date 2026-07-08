import WebSocket from 'ws';
import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';
import type {
  RealtimeClientEvent,
  RealtimeServerEvent,
  RealtimeSessionCreateRequest,
} from 'openai/resources/realtime/realtime';
import { createLogger } from '../utils/logger.ts';
import type { RealtimeTool } from './toolAdapter.ts';

const log = createLogger('openai-realtime');

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface RealtimeClientOptions {
  apiKey: string;
  model: string;
  instructions: string;
  tools: RealtimeTool[];
  voice: string;
  reasoningEffort?: ReasoningEffort;
}

export class OpenAiRealtimeClient {
  // We let the SDK build the URL, open the socket, and parse each incoming
  // frame into a typed `RealtimeServerEvent`. Once dispatch is wired we
  // discard the SDK reference and keep only the underlying socket — that's
  // all `send`, `readyState`, and close/error listeners need.
  private ws: WebSocket | null = null;
  private listeners: ((ev: RealtimeServerEvent) => void)[] = [];
  private closeListeners: ((info: { code: number; reason: string }) => void)[] = [];
  private opts: RealtimeClientOptions;
  // Counts append calls that hit a closed WS so we can log a single
  // summary line instead of one per frame (audio is ~50 frames/sec).
  private droppedAudioFrames = 0;

  constructor(opts: RealtimeClientOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const oa = new OpenAI({ apiKey: this.opts.apiKey });
    const sdk = new OpenAIRealtimeWS({ model: this.opts.model }, oa);
    // Attach the SDK-level 'error' sink BEFORE awaiting 'open'. The SDK re-emits
    // a socket error as an rt-level OpenAIRealtimeError; with no listener that's
    // an unhandled rejection that kills the whole process. The dangerous window
    // is the handshake itself: close() during the dial (the device WS dropping
    // mid-connect, or the bridge's connect timeout) aborts the CONNECTING socket
    // and surfaces exactly this error BEFORE 'open' ever fires — so registering
    // the sink after 'open' (as we used to) left that window uncovered.
    //
    // The same server-side errors are ALSO delivered via the 'event' channel
    // below, where the bridge is the authoritative handler (logs real ones at
    // error level, suppresses benign codes, surfaces to the device when
    // warranted). This sink deliberately does nothing else, to avoid logging
    // every error twice.
    sdk.on('error', () => {
      // intentionally no-op — see comment above
    });
    // Track the socket from the start of the dial, not from 'open': close()
    // during the handshake (the bridge's connect timeout) must abort the
    // in-flight socket. Otherwise the hung dial keeps going and, if it opens
    // late, becomes a live untracked session feeding events into whatever
    // session the bridge opens next.
    this.ws = sdk.socket;
    await new Promise<void>((resolve, reject) => {
      sdk.socket.once('open', () => resolve());
      sdk.socket.once('error', reject);
    });
    if (this.ws !== sdk.socket) {
      // close() ran mid-handshake and disowned this socket; a late 'open'
      // slipped past its close(). Tear it down instead of configuring it.
      sdk.socket.close();
      throw new Error('openai realtime connect aborted');
    }
    sdk.on('event', (ev) => {
      for (const l of this.listeners) {
        l(ev);
      }
    });

    // OpenAI Realtime caps each session at 30 minutes — sockets WILL close
    // on us. We don't try to keep them alive; we just make sure the next
    // device wake word comes up cleanly by tearing the device session
    // down (see RealtimeBridge.onClose), so the firmware reconnects fresh.
    this.ws.on('close', (code: number, reason: Buffer) => {
      // Same identity check as the late-open guard above: close() (idle
      // reset / connect-timeout abort) followed by a fresh connect() can
      // leave this stale socket's async 'close' landing after a new session
      // is live — notifying the bridge would wrongly flip it to disconnected
      // and wipe the live session's tool/follow-up state. `this.ws === null`
      // (explicit close with no successor session yet) still notifies: the
      // bridge depends on that to mark itself disconnected after close().
      if (this.ws !== null && this.ws !== sdk.socket) {
        return;
      }
      const info = { code, reason: reason.toString('utf8') };
      log.info(info, 'openai realtime ws closed');
      if (this.droppedAudioFrames > 0) {
        log.warn({ count: this.droppedAudioFrames }, 'audio frames dropped while ws closed');
        this.droppedAudioFrames = 0;
      }
      for (const l of this.closeListeners) {
        l(info);
      }
    });
    this.ws.on('error', (err: Error) => {
      // Log-only, but the same staleness applies: a disowned socket's error
      // is noise once a new session is live.
      if (this.ws !== null && this.ws !== sdk.socket) {
        return;
      }
      log.warn({ err }, 'openai realtime ws error');
    });

    const session: RealtimeSessionCreateRequest = {
      type: 'realtime',
      model: this.opts.model,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          turn_detection: {
            type: 'server_vad',
            // Default silence_duration_ms is 500 — short enough that a
            // natural pause mid-sentence ("Turn off… the living-room light")
            // splits the turn in two. Whisper then hallucinates random
            // text from the silence-only second chunk (we've seen Korean
            // onomatopoeia "뿅!" appear). 900 ms holds the turn open
            // long enough for normal pauses while still feeling responsive.
            silence_duration_ms: 900,
          },
          // Ask the server to transcribe user audio so we can log what was
          // actually heard. Free-ish (whisper-style) and very useful when
          // debugging "the AI did something weird" — we can see the input.
          transcription: { model: 'whisper-1' },
        },
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
          voice: this.opts.voice,
        },
      },
      instructions: this.opts.instructions,
      tools: this.opts.tools,
    };
    if (this.opts.reasoningEffort) {
      session.reasoning = { effort: this.opts.reasoningEffort };
    }
    this.send({ type: 'session.update', session });
  }

  on(listener: (ev: RealtimeServerEvent) => void): void {
    this.listeners.push(listener);
  }

  /** Register a callback fired when the OpenAI WS closes (clean or otherwise).
   * The bridge uses this to also close the device WS so the firmware reconnects
   * and gets a fresh session, rather than streaming audio into a dead socket. */
  onClose(listener: (info: { code: number; reason: string }) => void): void {
    this.closeListeners.push(listener);
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  send(event: RealtimeClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('openai realtime ws not open');
    }
    this.ws.send(JSON.stringify(event));
  }

  /** High-frequency audio fastpath. Unlike {@link send}, this MUST NOT throw
   * if the WS is closed — the device streams ~50 frames/sec and a single
   * unhandled throw inside the device's message handler crashes the
   * process. Drop silently, increment a counter so the next 'close' log
   * records how many frames were lost. */
  appendAudioPcm16Base64(b64: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.droppedAudioFrames++;
      return;
    }
    this.send({ type: 'input_audio_buffer.append', audio: b64 });
  }

  cancelResponse(): void {
    // Like {@link appendAudioPcm16Base64}, this MUST NOT throw on a closed WS.
    // A device `start`/`interrupt` can arrive while the upstream is lazily
    // disconnected (fresh wake after the idle-reset or OpenAI's 30-min cap);
    // there's no response to cancel, and an unhandled throw would abort the
    // bridge's control handler (dropping the listening phase).
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.send({ type: 'response.cancel' });
    this.send({ type: 'input_audio_buffer.clear' });
  }

  /** Submit a function_call_output item. Does NOT trigger a follow-up
   * response — call {@link requestResponse} once, after the last tool in a
   * parallel batch has submitted, to ask the model to continue.
   *
   * Like {@link cancelResponse}, MUST NOT throw on a closed WS: tool batches
   * race the upstream close (30-min cap, network drop), and these run inside
   * the bridge's response.done handler. The result is moot on a dead session
   * anyway; the close handler tears the device WS down for a fresh start. */
  submitToolResult(callId: string, output: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    });
  }

  /** Ask the model to produce a new response. Pairs with
   * {@link submitToolResult} when coalescing parallel tool results.
   * No-op on a closed WS — see {@link submitToolResult}.
   *
   * `instructions` are one-off: they REPLACE the session prompt for this
   * single response (Realtime API semantics), so they must be self-contained
   * — used by the empty-follow-up retry to force a spoken confirmation. */
  requestResponse(instructions?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.send(
      instructions === undefined
        ? { type: 'response.create' }
        : { type: 'response.create', response: { instructions } },
    );
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
