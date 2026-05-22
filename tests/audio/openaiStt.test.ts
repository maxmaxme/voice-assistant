import { describe, it, expect, vi } from 'vitest';
import { OpenAiStt } from '../../src/audio/openaiStt.ts';

describe('OpenAiStt', () => {
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
