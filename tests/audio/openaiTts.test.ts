import { describe, it, expect, vi } from 'vitest';
import { OpenAiTts } from '../../src/audio/openaiTts.ts';

function makeReadableStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

describe('OpenAiTts', () => {
  it('streams PCM chunks from OpenAI as a 24kHz async iterable', async () => {
    const c1 = new Uint8Array([1, 2, 3, 4]);
    const c2 = new Uint8Array([5, 6, 7, 8]);
    const create = vi.fn().mockResolvedValue({ body: makeReadableStream([c1, c2]) });
    const fakeClient = { audio: { speech: { create } } } as never;

    const tts = new OpenAiTts({ client: fakeClient, model: 'gpt-4o-mini-tts', voice: 'alloy' });
    const stream = tts.stream('привет');
    expect(stream.sampleRate).toBe(24000);

    const got: Buffer[] = [];
    for await (const chunk of stream.chunks) {
      got.push(chunk);
    }

    expect(got).toHaveLength(2);
    expect(got[0].equals(Buffer.from(c1))).toBe(true);
    expect(got[1].equals(Buffer.from(c2))).toBe(true);

    const callArgs = create.mock.calls[0][0];
    expect(callArgs.response_format).toBe('pcm');
    expect(callArgs.input).toBe('привет');
    expect(callArgs.model).toBe('gpt-4o-mini-tts');
  });

  it('passes AbortSignal as a request option to the SDK', async () => {
    const create = vi.fn().mockResolvedValue({ body: makeReadableStream([]) });
    const fakeClient = { audio: { speech: { create } } } as never;
    const tts = new OpenAiTts({ client: fakeClient });
    const ctrl = new AbortController();

    const stream = tts.stream('hi', { signal: ctrl.signal });
    // drain so the SDK call actually fires
    for await (const _ of stream.chunks) {
      void _;
    }

    const requestOpts = create.mock.calls[0][1];
    expect(requestOpts.signal).toBe(ctrl.signal);
  });
});
