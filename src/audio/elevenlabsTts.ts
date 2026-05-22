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
      chunks: this.fetchChunks(text, opts),
    };
  }

  private async *fetchChunks(
    text: string,
    opts?: { voice?: string; signal?: AbortSignal },
  ): AsyncGenerator<Buffer> {
    const readable = await this.client.textToSpeech.stream(opts?.voice ?? this.voiceId, {
      text,
      outputFormat: 'pcm_24000',
    });

    for await (const chunk of readable) {
      if (chunk && chunk.byteLength > 0) {
        yield Buffer.from(chunk);
      }
    }
  }
}
