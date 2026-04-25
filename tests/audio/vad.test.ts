import { describe, it, expect } from 'vitest';
import { RmsVad } from '../../src/audio/vad.ts';

function frame(value: number, n = 512): Int16Array {
  const a = new Int16Array(n);
  a.fill(value);
  return a;
}

describe('RmsVad', () => {
  it('detects speech then silence', () => {
    const vad = new RmsVad({
      sampleRate: 16000,
      frameLength: 512,
      threshold: 1000,
      silenceMs: 500,
    });
    const events: string[] = [];
    vad.onSpeech(() => events.push('speech'));
    vad.onSilence(() => events.push('silence'));

    // Loud frames trigger speech once
    for (let i = 0; i < 5; i++) vad.feed(frame(5000));
    expect(events).toContain('speech');

    // Then silent frames; need 500ms = ~16 frames at 32ms/frame.
    for (let i = 0; i < 20; i++) vad.feed(frame(0));
    expect(events).toContain('silence');
  });

  it('does not emit silence without prior speech', () => {
    const vad = new RmsVad({ sampleRate: 16000, frameLength: 512, threshold: 1000, silenceMs: 200 });
    const events: string[] = [];
    vad.onSilence(() => events.push('silence'));
    for (let i = 0; i < 50; i++) vad.feed(frame(0));
    expect(events).toHaveLength(0);
  });
});
