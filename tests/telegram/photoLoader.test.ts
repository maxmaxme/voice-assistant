import { describe, it, expect, vi } from 'vitest';
import { BotPhotoLoader } from '../../src/telegram/photoLoader.ts';
import { captureLogs } from '../helpers/captureLogs.ts';

const BOT_TOKEN = '123456:SECRET-BOT-TOKEN';

function fakeFetch(contentType: string | null = null): typeof fetch {
  return vi.fn(async () => {
    return new Response(Buffer.from([1, 2, 3]), {
      status: 200,
      headers: contentType ? { 'content-type': contentType } : {},
    });
  }) as unknown as typeof fetch;
}

function loader(fetchImpl: typeof fetch): BotPhotoLoader {
  return new BotPhotoLoader({
    botToken: BOT_TOKEN,
    fetchImpl,
    links: {
      getFileLink: async (fileId: string) =>
        `https://api.telegram.org/file/bot${BOT_TOKEN}/photos/${fileId}.jpg`,
    },
  });
}

describe('BotPhotoLoader', () => {
  it('downloads the photo and derives the mime type from the URL', async () => {
    const photo = await loader(fakeFetch()).load('file_1');
    expect(photo.mimeType).toBe('image/jpeg');
    expect(photo.data.length).toBe(3);
  });

  it('never writes the bot token to logs', async () => {
    const logs = captureLogs();
    try {
      await loader(fakeFetch()).load('file_1');
      expect(logs.text()).not.toContain(BOT_TOKEN);
      expect(logs.text()).not.toContain('SECRET-BOT-TOKEN');
    } finally {
      logs.restore();
    }
  });
});
