import { describe, it, expect } from 'vitest';
import { resamplePcm16 } from '../../src/realtime/audio/resample.ts';

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

  // Reference linear resampler (the original per-sample readInt16LE
  // algorithm, with a floored sample count). The production implementation
  // is optimized with an Int16Array view; it must stay bit-identical to this.
  function resampleRef(src: Buffer, fromRate: number, toRate: number): Buffer {
    if (fromRate === toRate) {
      return Buffer.from(src);
    }
    const srcSamples = Math.floor(src.length / 2);
    const ratio = toRate / fromRate;
    const dstSamples = Math.round(srcSamples * ratio);
    const dst = Buffer.alloc(dstSamples * 2);
    for (let i = 0; i < dstSamples; i++) {
      const srcPos = i / ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, srcSamples - 1);
      const frac = srcPos - i0;
      const s0 = src.readInt16LE(i0 * 2);
      const s1 = src.readInt16LE(i1 * 2);
      dst.writeInt16LE(Math.round(s0 * (1 - frac) + s1 * frac), i * 2);
    }
    return dst;
  }

  it('is bit-identical to the reference linear resampler', () => {
    for (const [from, to] of [
      [16000, 24000],
      [24000, 16000],
    ] as const) {
      const src = makeTone(440, from, 50);
      expect(resamplePcm16(src, from, to).equals(resampleRef(src, from, to))).toBe(true);
    }
  });

  it('handles odd-length input without throwing (drops the trailing byte)', () => {
    const even = makeTone(440, 16000, 50);
    const odd = Buffer.concat([even, Buffer.from([0x7f])]); // odd length
    expect(() => resamplePcm16(odd, 16000, 24000)).not.toThrow();
    // The stray byte is ignored, so the result matches the even prefix.
    expect(resamplePcm16(odd, 16000, 24000).equals(resamplePcm16(even, 16000, 24000))).toBe(true);
  });

  it('produces the same output regardless of source byteOffset', () => {
    const tone = makeTone(440, 16000, 50);
    // A subarray at offset 1 gives an odd byteOffset, which Int16Array can't
    // view directly — exercises the realign-copy path.
    const padded = Buffer.concat([Buffer.from([0x00]), tone]);
    const offsetView = padded.subarray(1);
    expect(offsetView.byteOffset % 2).toBe(1);
    expect(resamplePcm16(offsetView, 16000, 24000).equals(resamplePcm16(tone, 16000, 24000))).toBe(
      true,
    );
  });
});
