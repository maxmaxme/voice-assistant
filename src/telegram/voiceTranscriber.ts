import type OpenAI from 'openai';
import { toFile } from 'openai';
import { Telegram } from 'telegraf';

export interface TelegramVoiceTranscriber {
  /** Resolves a Telegram voice file_id into transcribed text. */
  transcribe(fileId: string, opts?: { language?: string }): Promise<string>;
}

export interface BotVoiceTranscriberOptions {
  botToken: string;
  client: OpenAI;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Override the telegraf API client. Tests inject this so they don't need a
   *  real bot token / network. Production uses the bundled telegraf instance. */
  telegram?: Pick<Telegram, 'getFileLink'>;
}

/** Downloads a Telegram voice message via Bot API and transcribes via OpenAI.
 *  Telegram sends voice as OGG/OPUS, which gpt-4o-transcribe accepts directly. */
export class BotVoiceTranscriber implements TelegramVoiceTranscriber {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly telegram: Pick<Telegram, 'getFileLink'>;

  constructor(opts: BotVoiceTranscriberOptions) {
    this.client = opts.client;
    this.model = opts.model ?? 'gpt-4o-transcribe';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.telegram = opts.telegram ?? new Telegram(opts.botToken);
  }

  async transcribe(fileId: string, opts?: { language?: string }): Promise<string> {
    const url = await this.telegram.getFileLink(fileId);
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(`Telegram file download failed: ${res.status} ${res.statusText}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    const file = await toFile(audio, fileNameFor(url), { type: 'audio/ogg' });
    const transcription = await this.client.audio.transcriptions.create({
      file,
      model: this.model,
      ...(opts?.language ? { language: opts.language } : {}),
    });
    return transcription.text;
  }
}

function fileNameFor(url: string | URL): string {
  const path = typeof url === 'string' ? url : url.pathname;
  const base = path.split('/').pop();
  return base && base.length > 0 ? base : 'voice.ogg';
}
