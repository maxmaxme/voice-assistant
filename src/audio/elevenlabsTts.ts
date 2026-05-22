import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import type { Tts, TtsStream } from './types.ts';

export interface ElevenLabsTtsOptions {
  apiKey: string;
  voiceId?: string;
}

const SAMPLE_RATE = 24000;
// Rachel — neutral English voice; override with ELEVENLABS_VOICE_ID
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

export class ElevenLabsTts implements Tts {
  private readonly client: ElevenLabsClient;
  private readonly voiceId: string;

  constructor(opts: ElevenLabsTtsOptions) {
    this.client = new ElevenLabsClient({ apiKey: opts.apiKey });
    this.voiceId = opts.voiceId ?? DEFAULT_VOICE_ID;
  }

  stream(text: string, opts?: { voice?: string; signal?: AbortSignal }): TtsStream {
    return {
      sampleRate: SAMPLE_RATE,
      chunks: this.fetchChunks(text, 'pcm_24000', opts),
    };
  }

  streamEncoded(
    text: string,
    opts?: { voice?: string; signal?: AbortSignal },
  ): { contentType: string; chunks: AsyncIterable<Buffer> } {
    // ElevenLabs doesn't offer FLAC, so we go with MP3 — which the Voice PE
    // audio_http decoder also supports (USE_AUDIO_MP3_SUPPORT is enabled
    // because their `audio_file:` references already include .mp3 assets
    // like easter_egg_tick.mp3).
    return {
      contentType: 'audio/mpeg',
      chunks: this.fetchChunks(text, 'mp3_44100_128', opts),
    };
  }

  private async *fetchChunks(
    text: string,
    outputFormat: 'pcm_24000' | 'mp3_44100_128' | 'mp3_44100_64' | 'mp3_44100_32',
    opts?: { voice?: string; signal?: AbortSignal },
  ): AsyncGenerator<Buffer> {
    const readable = await this.client.textToSpeech.stream(opts?.voice ?? this.voiceId, {
      text,
      outputFormat,
    });

    for await (const chunk of readable) {
      if (chunk && chunk.byteLength > 0) {
        yield Buffer.from(chunk);
      }
    }
  }
}
