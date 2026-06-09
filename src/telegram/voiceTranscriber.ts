import { fileLinkResolver, type TelegramFileLinkResolver } from './fileLink.ts';
import type { AudioFileStt } from '../audio/types.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('voice-transcriber');

export interface TelegramVoiceTranscriber {
  /** Resolves a Telegram voice file_id into transcribed text. */
  transcribe(fileId: string): Promise<string>;
}

export interface BotVoiceTranscriberOptions {
  botToken: string;
  fetchImpl?: typeof fetch;
  stt: AudioFileStt;
  /** Override the file-link resolver. Tests inject this so they don't need a
   *  real bot token / network. Production builds one from the bot token. */
  links?: TelegramFileLinkResolver;
}

/** Downloads a Telegram voice message via Bot API and transcribes via OpenAI.
 *  Telegram sends voice as OGG/OPUS, which gpt-4o-transcribe accepts directly. */
export class BotVoiceTranscriber implements TelegramVoiceTranscriber {
  private readonly stt: AudioFileStt;
  private readonly fetchImpl: typeof fetch;
  private readonly links: TelegramFileLinkResolver;

  constructor(opts: BotVoiceTranscriberOptions) {
    this.stt = opts.stt;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.links = opts.links ?? fileLinkResolver(opts.botToken);
  }

  async transcribe(fileId: string): Promise<string> {
    const downloadStartedAt = Date.now();
    const url = await this.links.getFileLink(fileId);
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(`Telegram file download failed: ${res.status} ${res.statusText}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    const downloadMs = Date.now() - downloadStartedAt;
    // Telegram serves voice as `.oga`, which OpenAI's transcribe endpoint
    // rejects ("Unsupported file format oga") even though it is OGG/OPUS.
    // Force the `.ogg` extension so the API picks the right decoder.
    const sttStartedAt = Date.now();
    const text = await this.stt.transcribeFile(audio, {
      filename: 'voice.ogg',
      contentType: 'audio/ogg',
    });
    const sttMs = Date.now() - sttStartedAt;
    log.info(
      { downloadMs, sttMs, bytes: audio.length },
      `voice transcribed (download ${downloadMs}ms, stt ${sttMs}ms)`,
    );
    return text;
  }
}
