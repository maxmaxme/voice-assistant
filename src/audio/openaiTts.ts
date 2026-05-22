import type OpenAI from 'openai';
import type { Tts, TtsStream } from './types.ts';

export interface OpenAiTtsOptions {
  client: OpenAI;
  model?: string;
  voice?: string;
}

const SAMPLE_RATE = 24000;

export class OpenAiTts implements Tts {
  private readonly model: string;
  private readonly voice: string;
  private readonly opts: OpenAiTtsOptions;

  constructor(opts: OpenAiTtsOptions) {
    this.opts = opts;
    this.model = opts.model ?? 'gpt-4o-mini-tts';
    this.voice = opts.voice ?? 'alloy';
  }

  stream(
    text: string,
    opts?: { voice?: string; instructions?: string; signal?: AbortSignal },
  ): TtsStream {
    return {
      sampleRate: SAMPLE_RATE,
      chunks: this.fetchChunks(text, opts),
    };
  }

  private async *fetchChunks(
    text: string,
    opts?: { voice?: string; instructions?: string; signal?: AbortSignal },
  ): AsyncGenerator<Buffer> {
    const res = await this.opts.client.audio.speech.create(
      {
        model: this.model,
        voice: opts?.voice ?? this.voice,
        input: text,
        response_format: 'pcm',
        instructions: opts?.instructions,
      },
      { signal: opts?.signal },
    );

    const body = res.body;
    if (!body) {
      return;
    }

    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (value && value.byteLength > 0) {
          yield Buffer.from(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // releaseLock throws if the reader is already errored — safe to ignore
      }
    }
  }
}
