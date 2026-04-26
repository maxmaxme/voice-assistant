import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ElevenLabsTts } from '../../src/audio/elevenlabsTts.ts';

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

// Shared stream mock — reset per test
const streamMock = vi.fn();

vi.mock('@elevenlabs/elevenlabs-js', () => ({
  ElevenLabsClient: class {
    textToSpeech = { stream: streamMock };
  },
}));

beforeEach(() => {
  streamMock.mockReset();
  streamMock.mockResolvedValue(makeReadableStream([]));
});

describe('ElevenLabsTts', () => {
  it('returns a 24kHz stream', () => {
    const tts = new ElevenLabsTts({ apiKey: 'test-key' });
    expect(tts.stream('привет').sampleRate).toBe(24000);
  });

  it('yields PCM chunks from the ElevenLabs stream', async () => {
    const chunks = [new Uint8Array([10, 20, 30]), new Uint8Array([40, 50])];
    streamMock.mockResolvedValue(makeReadableStream(chunks));

    const tts = new ElevenLabsTts({ apiKey: 'test-key' });
    const got: Buffer[] = [];
    for await (const chunk of tts.stream('текст').chunks) {
      got.push(chunk);
    }

    expect(got).toHaveLength(2);
    expect(got[0].equals(Buffer.from(chunks[0]))).toBe(true);
    expect(got[1].equals(Buffer.from(chunks[1]))).toBe(true);
  });

  it('requests pcm_24000 outputFormat', async () => {
    const tts = new ElevenLabsTts({ apiKey: 'k', voiceId: 'voice-123' });
    for await (const _ of tts.stream('hi').chunks) {
      void _;
    }

    expect(streamMock).toHaveBeenCalledWith('voice-123', {
      text: 'hi',
      outputFormat: 'pcm_24000',
    });
  });

  it('uses opts.voice instead of the default voiceId', async () => {
    const tts = new ElevenLabsTts({ apiKey: 'k', voiceId: 'default-voice' });
    for await (const _ of tts.stream('text', { voice: 'override-voice' }).chunks) {
      void _;
    }

    expect(streamMock.mock.calls[0][0]).toBe('override-voice');
  });
});
