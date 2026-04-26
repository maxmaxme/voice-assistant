import { Telegram } from 'telegraf';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('telegram.photoLoader');

export interface LoadedPhoto {
  data: Buffer;
  mimeType: string;
}

export interface TelegramPhotoLoader {
  /** Resolves a Telegram photo file_id into raw bytes + mime type. */
  load(fileId: string): Promise<LoadedPhoto>;
}

export interface BotPhotoLoaderOptions {
  botToken: string;
  fetchImpl?: typeof fetch;
  /** Override the telegraf API client. Tests inject this so they don't need a
   *  real bot token / network. Production uses the bundled telegraf instance. */
  telegram?: Pick<Telegram, 'getFileLink'>;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

function mimeFromUrl(url: string): string | null {
  const path = url.split('?')[0];
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? null;
}

/** Downloads a Telegram photo via Bot API. */
export class BotPhotoLoader implements TelegramPhotoLoader {
  private readonly fetchImpl: typeof fetch;
  private readonly telegram: Pick<Telegram, 'getFileLink'>;

  constructor(opts: BotPhotoLoaderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.telegram = opts.telegram ?? new Telegram(opts.botToken);
  }

  async load(fileId: string): Promise<LoadedPhoto> {
    const link = await this.telegram.getFileLink(fileId);
    const url = typeof link === 'string' ? link : link.toString();
    log.debug({ fileId, url }, 'resolved Telegram file URL');
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(`Telegram photo download failed: ${res.status} ${res.statusText}`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    // Telegram's CDN sets Content-Type: application/octet-stream for photos,
    // which OpenAI rejects. Derive from URL extension first; fall back to the
    // header only when it's a real image/* type, then to image/jpeg.
    const fromUrl = mimeFromUrl(url);
    const fromHeader = res.headers.get('content-type');
    const mimeType =
      fromUrl ?? (fromHeader && fromHeader.startsWith('image/') ? fromHeader : 'image/jpeg');
    return { data, mimeType };
  }
}
