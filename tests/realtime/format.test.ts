import { describe, it, expect } from 'vitest';
import { pcm16ToBase64, base64ToPcm16 } from '../../src/realtime/audio/format.js';

describe('pcm16 helpers', () => {
  it('round-trips a buffer', () => {
    const buf = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80, 0x80]);
    const b64 = pcm16ToBase64(buf);
    expect(base64ToPcm16(b64).equals(buf)).toBe(true);
  });

  it('rejects odd-length pcm', () => {
    expect(() => pcm16ToBase64(Buffer.from([0x00, 0x01, 0x02]))).toThrow();
  });
});
