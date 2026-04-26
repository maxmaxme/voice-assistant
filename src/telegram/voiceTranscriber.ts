import { Telegram } from 'telegraf';
import type { AudioFileStt } from '../audio/types.ts';

export interface TelegramVoiceTranscriber {
  /** Resolves a Telegram voice file_id into transcribed text. */
  transcribe(fileId: string): Promise<string>;
}

export interface BotVoiceTranscriberOptions {
  botToken: string;
  fetchImpl?: typeof fetch;
  stt: AudioFileStt;
  /** Override the telegraf API client. Tests inject this so they don't need a
   *  real bot token / network. Production uses the bundled telegraf instance. */
  telegram?: Pick<Telegram, 'getFileLink'>;
}

/** Downloads a Telegram voice message via Bot API and transcribes via OpenAI.
 *  Telegram sends voice as OGG/OPUS, which gpt-4o-transcribe accepts directly. */
export class BotVoiceTranscriber implements TelegramVoiceTranscriber {
  private readonly stt: AudioFileStt;
  private readonly fetchImpl: typeof fetch;
  private readonly telegram: Pick<Telegram, 'getFileLink'>;

  constructor(opts: BotVoiceTranscriberOptions) {
    this.stt = opts.stt;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.telegram = opts.telegram ?? new Telegram(opts.botToken);
  }

  async transcribe(fileId: string): Promise<string> {
    const url = await this.telegram.getFileLink(fileId);
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(`Telegram file download failed: ${res.status} ${res.statusText}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    // Telegram serves voice as `.oga`, which OpenAI's transcribe endpoint
    // rejects ("Unsupported file format oga") even though it is OGG/OPUS.
    // Force the `.ogg` extension so the API picks the right decoder.
    return this.stt.transcribeFile(audio, {
      filename: 'voice.ogg',
      contentType: 'audio/ogg',
    });
  }
}
