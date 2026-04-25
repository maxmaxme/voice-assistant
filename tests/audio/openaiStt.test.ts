import { describe, it, expect, vi } from 'vitest';
import { OpenAiStt } from '../../src/audio/openaiStt.js';

describe('OpenAiStt', () => {
  it('sends a WAV file to the audio.transcriptions endpoint and returns text', async () => {
    const create = vi.fn().mockResolvedValue({ text: 'привет дом' });
    const fakeClient = {
      audio: { transcriptions: { create } },
    } as never;
    const stt = new OpenAiStt({ client: fakeClient, model: 'gpt-4o-transcribe' });
    const pcm = Buffer.alloc(16000 * 2); // 1 second of silence
    const result = await stt.transcribe(pcm, { sampleRate: 16000, language: 'ru' });
    expect(result).toBe('привет дом');
    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0][0];
    expect(call.model).toBe('gpt-4o-transcribe');
    expect(call.language).toBe('ru');
  });
});
