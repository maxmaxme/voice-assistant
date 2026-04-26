import { describe, it, expect, vi } from 'vitest';
import { OpenAiStt } from '../../src/audio/openaiStt.ts';

describe('OpenAiStt', () => {
  it('sends a WAV file to the audio.transcriptions endpoint and returns text', async () => {
    const create = vi.fn().mockResolvedValue({ text: 'hello home' });
    const fakeClient = {
      audio: { transcriptions: { create } },
    } as never;
    const stt = new OpenAiStt({ client: fakeClient, model: 'gpt-4o-transcribe' });
    const pcm = Buffer.alloc(16000 * 2); // 1 second of silence
    const result = await stt.transcribe(pcm, { sampleRate: 16000 });
    expect(result).toBe('hello home');
    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0][0];
    expect(call.model).toBe('gpt-4o-transcribe');
    expect(call.language).toBeUndefined();
  });

  it('transcribes an already encoded audio file', async () => {
    const create = vi.fn().mockResolvedValue({ text: 'answer' });
    const fakeClient = {
      audio: { transcriptions: { create } },
    } as never;
    const stt = new OpenAiStt({ client: fakeClient, model: 'gpt-4o-transcribe' });
    const result = await stt.transcribeFile(Buffer.from('ogg'), {
      filename: 'voice.ogg',
      contentType: 'audio/ogg',
    });

    expect(result).toBe('answer');
    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0][0];
    expect(call.model).toBe('gpt-4o-transcribe');
    expect(call.language).toBeUndefined();
  });
});
