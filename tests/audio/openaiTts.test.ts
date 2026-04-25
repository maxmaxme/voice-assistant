import { describe, it, expect, vi } from 'vitest';
import { OpenAiTts } from '../../src/audio/openaiTts.ts';

describe('OpenAiTts', () => {
  it('returns 16-bit PCM audio at 24kHz', async () => {
    const fakePcm = Buffer.alloc(2400 * 2);
    const create = vi.fn().mockResolvedValue({
      arrayBuffer: async () => fakePcm.buffer.slice(fakePcm.byteOffset, fakePcm.byteOffset + fakePcm.byteLength),
    });
    const fakeClient = { audio: { speech: { create } } } as never;
    const tts = new OpenAiTts({ client: fakeClient, model: 'gpt-4o-mini-tts', voice: 'alloy' });
    const out = await tts.synthesize('привет');
    expect(out.audio.length).toBe(fakePcm.length);
    expect(out.sampleRate).toBe(24000);
    const call = create.mock.calls[0][0];
    expect(call.response_format).toBe('pcm');
  });
});
