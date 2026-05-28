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
    await new Promise<void>((resolve, reject) => {
      sdk.socket.once('open', () => resolve());
      sdk.socket.once('error', reject);
    });
    sdk.on('event', (ev) => {
      for (const l of this.listeners) {
        l(ev);
      }
    });
    // SDK emits 'error' as OpenAIRealtimeError. Server-side error events
    // are also delivered to our listeners via the 'event' channel above;
    // this listener exists only to swallow the unhandled-rejection path
    // the SDK takes when no 'error' listener is attached.
    sdk.on('error', (err) => {
      log.debug({ err }, 'sdk emitter error (also delivered via event stream)');
    });
    this.ws = sdk.socket;

    // OpenAI Realtime caps each session at 30 minutes — sockets WILL close
    // on us. We don't try to keep them alive; we just make sure the next
    // device wake word comes up cleanly by tearing the device session
    // down (see RealtimeBridge.onClose), so the firmware reconnects fresh.
    this.ws.on('close', (code: number, reason: Buffer) => {
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
            // natural pause mid-sentence ("Выключи… свет в гостиной")
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
    this.send({ type: 'response.cancel' });
    this.send({ type: 'input_audio_buffer.clear' });
  }

  /** Submit a function_call_output item. Does NOT trigger a follow-up
   * response — call {@link requestResponse} once, after the last tool in a
   * parallel batch has submitted, to ask the model to continue. */
  submitToolResult(callId: string, output: string): void {
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
   * {@link submitToolResult} when coalescing parallel tool results. */
  requestResponse(): void {
    this.send({ type: 'response.create' });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
