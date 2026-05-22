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
      chunks: this.fetchChunks(text, 'pcm', opts),
    };
  }

  streamEncoded(
    text: string,
    opts?: { voice?: string; instructions?: string; signal?: AbortSignal },
  ): { contentType: string; chunks: AsyncIterable<Buffer> } {
    // FLAC chosen because the ESPHome `audio_http` decoder used by the Voice
    // PE media_player pipeline supports it out of the box (the WAV branch
    // is gated on USE_AUDIO_WAV_SUPPORT, which Voice PE's stock build does
    // not enable). FLAC frames stream natively — no `0xFFFFFFFF` length
    // placeholder tricks needed.
    return {
      contentType: 'audio/flac',
      chunks: this.fetchChunks(text, 'flac', opts),
    };
  }

  private async *fetchChunks(
    text: string,
    responseFormat: 'pcm' | 'flac' | 'mp3' | 'opus' | 'aac' | 'wav',
    opts?: { voice?: string; instructions?: string; signal?: AbortSignal },
  ): AsyncGenerator<Buffer> {
    const res = await this.opts.client.audio.speech.create(
      {
        model: this.model,
        voice: opts?.voice ?? this.voice,
        input: text,
        response_format: responseFormat,
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
