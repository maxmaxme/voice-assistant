import type OpenAI from 'openai';
import type { Tts } from './types.ts';

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

  async synthesize(text: string, opts?: { voice?: string; instructions?: string }) {
    const res = await this.opts.client.audio.speech.create({
      model: this.model,
      voice: opts?.voice ?? this.voice,
      input: text,
      response_format: 'pcm',
      instructions: opts?.instructions,
    } as never);
    const ab = await (res as unknown as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer();
    return { audio: Buffer.from(ab), sampleRate: SAMPLE_RATE };
  }
}
