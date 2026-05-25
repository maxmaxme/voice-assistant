import WebSocket from 'ws';
import { pino } from 'pino';
import type { RealtimeTool } from './toolAdapter.js';

const log = pino({ name: 'openai-realtime' });

export interface RealtimeClientOptions {
  apiKey: string;
  model: string;
  instructions: string;
  tools: RealtimeTool[];
  voice: string;
}

export type RealtimeEvent =
  | { type: 'session.created'; session: unknown }
  | { type: 'input_audio_buffer.speech_started' }
  | { type: 'input_audio_buffer.speech_stopped' }
  | { type: 'response.created'; response: { id: string } }
  | { type: 'response.audio.delta'; delta: string; response_id: string }
  | { type: 'response.audio.done'; response_id: string }
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

  constructor(private opts: RealtimeClientOptions) {}

  async connect(): Promise<void> {
    const base = process.env.OPENAI_REALTIME_URL_OVERRIDE ?? 'wss://api.openai.com/v1/realtime';
    const url = `${base}?model=${encodeURIComponent(this.opts.model)}`;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
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
    this.send({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: this.opts.instructions,
        voice: this.opts.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: { type: 'server_vad' },
        tools: this.opts.tools,
      },
    });
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

  submitToolResult(callId: string, output: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    });
    this.send({ type: 'response.create' });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
