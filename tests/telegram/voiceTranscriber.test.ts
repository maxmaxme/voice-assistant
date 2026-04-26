import { describe, it, expect, vi } from 'vitest';
import { BotVoiceTranscriber } from '../../src/telegram/voiceTranscriber.ts';

describe('BotVoiceTranscriber', () => {
  it('downloads Telegram voice audio and delegates transcription to AudioFileStt', async () => {
    const audio = Buffer.from('ogg-bytes');
    const transcribeFile = vi.fn(async () => 'включи свет');
    const fetchImpl = vi.fn(async () => new Response(audio));
    const telegram = {
      getFileLink: vi.fn(async () => new URL('https://example.test/voice.oga')),
    };
    const transcriber = new BotVoiceTranscriber({
      botToken: 'token',
      fetchImpl,
      telegram,
      stt: { transcribeFile },
    });

    const result = await transcriber.transcribe('file-id');

    expect(result).toBe('включи свет');
    expect(telegram.getFileLink).toHaveBeenCalledWith('file-id');
    expect(fetchImpl).toHaveBeenCalledWith(new URL('https://example.test/voice.oga'));
    expect(transcribeFile).toHaveBeenCalledWith(audio, {
      filename: 'voice.ogg',
      contentType: 'audio/ogg',
    });
  });

  it('throws when Telegram file download fails', async () => {
    const transcribeFile = vi.fn();
    const transcriber = new BotVoiceTranscriber({
      botToken: 'token',
      fetchImpl: vi.fn(async () => new Response(null, { status: 503, statusText: 'nope' })),
      telegram: {
        getFileLink: vi.fn(async () => new URL('https://example.test/voice.oga')),
      },
      stt: { transcribeFile },
    });

    await expect(transcriber.transcribe('file-id')).rejects.toThrow(
      'Telegram file download failed: 503 nope',
    );
    expect(transcribeFile).not.toHaveBeenCalled();
  });
});
