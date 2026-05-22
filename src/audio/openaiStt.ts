import type OpenAI from 'openai';
import { toFile } from 'openai';
import type { AudioFileStt } from './types.ts';

export interface OpenAiSttOptions {
  client: OpenAI;
  model?: string;
}

export class OpenAiStt implements AudioFileStt {
  private readonly model: string;
  private readonly opts: OpenAiSttOptions;
  constructor(opts: OpenAiSttOptions) {
    this.opts = opts;
    this.model = opts.model ?? 'gpt-4o-transcribe';
  }

  async transcribeFile(
    audio: Buffer,
    opts: { filename: string; contentType: string },
  ): Promise<string> {
    const file = await toFile(audio, opts.filename, { type: opts.contentType });
    const res = await this.opts.client.audio.transcriptions.create({
      file,
      model: this.model,
    });
    return res.text;
  }
}
