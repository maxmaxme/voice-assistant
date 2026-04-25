import type OpenAI from 'openai';
import { toFile } from 'openai';
import type { Stt } from './types.ts';

export interface OpenAiSttOptions {
  client: OpenAI;
  model?: string;
}

export class OpenAiStt implements Stt {
  private readonly model: string;
  private readonly opts: OpenAiSttOptions;
  constructor(opts: OpenAiSttOptions) {
    this.opts = opts;
    this.model = opts.model ?? 'gpt-4o-transcribe';
  }

  async transcribe(audio: Buffer, opts: { sampleRate: number; language?: string }): Promise<string> {
    const wav = pcmToWav(audio, opts.sampleRate);
    const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
    // Only forward `language` when defined — older SDK versions can serialize
    // `undefined` as the literal string "undefined", which the API rejects.
    const res = await this.opts.client.audio.transcriptions.create({
      file,
      model: this.model,
      ...(opts.language ? { language: opts.language } : {}),
    });
    return res.text;
  }
}

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
