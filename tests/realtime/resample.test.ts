import { describe, it, expect } from 'vitest';
import { resamplePcm16 } from '../../src/realtime/audio/resample.js';

function makeTone(freq: number, sampleRate: number, durationMs: number): Buffer {
  const n = Math.round((sampleRate * durationMs) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 16000);
    buf.writeInt16LE(s, i * 2);
  }
  return buf;
}

describe('resamplePcm16', () => {
  it('upsamples 16k → 24k preserves duration ±1 sample', () => {
    const src = makeTone(440, 16000, 100); // 1600 samples
    const out = resamplePcm16(src, 16000, 24000);
    expect(out.length / 2).toBeGreaterThanOrEqual(2399);
    expect(out.length / 2).toBeLessThanOrEqual(2401);
  });

  it('downsamples 24k → 16k', () => {
    const src = makeTone(440, 24000, 100); // 2400 samples
    const out = resamplePcm16(src, 24000, 16000);
    expect(out.length / 2).toBeGreaterThanOrEqual(1599);
    expect(out.length / 2).toBeLessThanOrEqual(1601);
  });

  it('passthrough when rates equal', () => {
    const src = makeTone(440, 16000, 100);
    const out = resamplePcm16(src, 16000, 16000);
    expect(out.equals(src)).toBe(true);
  });
});
