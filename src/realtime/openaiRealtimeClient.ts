import WebSocket from 'ws';
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

export type RealtimeEvent =
  | { type: 'session.created'; session: unknown }
  | { type: 'session.updated'; session: unknown }
  | { type: 'input_audio_buffer.speech_started' }
  | { type: 'input_audio_buffer.speech_stopped' }
  | { type: 'response.created'; response: { id: string } }
  | { type: 'response.output_audio.delta'; delta: string; response_id: string }
  | { type: 'response.output_audio.done'; response_id: string }
  | { type: 'response.done'; response: { id: string; output: unknown[] } }
  | {
      type: 'response.function_call_arguments.done';
      call_id: string;
      name: string;
      arguments: string;
    }
  | { type: 'error'; error: { message: string } }
  | Record<string, unknown>;

function parseRealtimeEvent(data: unknown): data is RealtimeEvent {
  return (
    typeof data === 'object' && data !== null && 'type' in data && typeof data.type === 'string'
  );
}

export class OpenAiRealtimeClient {
  private ws: WebSocket | null = null;
  private listeners: ((ev: RealtimeEvent) => void)[] = [];
  private closeListeners: ((info: { code: number; reason: string }) => void)[] = [];
  private opts: RealtimeClientOptions;
  // Counts append calls that hit a closed WS so we can log a single
  // summary line instead of one per frame (audio is ~50 frames/sec).
  private droppedAudioFrames = 0;

  constructor(opts: RealtimeClientOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const base = process.env.OPENAI_REALTIME_URL_OVERRIDE ?? 'wss://api.openai.com/v1/realtime';
    const url = `${base}?model=${encodeURIComponent(this.opts.model)}`;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
    });
    await new Promise<void>((resolve, reject) => {
      this.ws!.once('open', () => resolve());
      this.ws!.once('error', reject);
    });
    this.ws!.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parseRealtimeEvent(parsed)) {
          for (const l of this.listeners) {
            l(parsed);
          }
        }
      } catch (err) {
        log.warn({ err }, 'failed to parse realtime event');
      }
    });
    // Surface unexpected closes so the bridge can tear down the device WS
    // (instead of the device streaming audio into a dead OpenAI socket and
    // crashing the process with "ws not open" on every frame).
    // OpenAI Realtime caps each session at 30 minutes — sockets WILL close
    // on us. We don't try to keep them alive; we just make sure the next
    // device wake word comes up cleanly by tearing the device session
    // down (see RealtimeBridge.onClose), so the firmware reconnects fresh.
    this.ws!.on('close', (code: number, reason: Buffer) => {
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
    this.ws!.on('error', (err: Error) => {
      log.warn({ err }, 'openai realtime ws error');
    });
    const session: Record<string, unknown> = {
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

  on(listener: (ev: RealtimeEvent) => void): void {
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

  send(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('openai realtime ws not open');
    }
    this.ws.send(JSON.stringify(msg));
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
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
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
