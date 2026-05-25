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
  private opts: RealtimeClientOptions;

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

  send(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('openai realtime ws not open');
    }
    this.ws.send(JSON.stringify(msg));
  }

  appendAudioPcm16Base64(b64: string): void {
    this.send({ type: 'input_audio_buffer.append', audio: b64 });
  }

  cancelResponse(): void {
    this.send({ type: 'response.cancel' });
    this.send({ type: 'input_audio_buffer.clear' });
  }

  submitToolResult(callId: string, output: string, triggerResponse = true): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    });
    if (triggerResponse) {
      this.send({ type: 'response.create' });
    }
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
