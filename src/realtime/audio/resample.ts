export function resamplePcm16(src: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) {
    return Buffer.from(src);
  }
  // Floor: a torn/odd-length frame must not make srcSamples fractional, or the
  // last interpolation reads one byte past the buffer (RangeError). The trailing
  // odd byte is dropped, matching the firmware's `pairs * 2` framing.
  const srcSamples = src.length >> 1;
  // Index the input as int16 directly instead of one readInt16LE() method call
  // (endianness + bounds check) per sample — ~50 frames/s on the Pi. Hosts are
  // little-endian, so the view matches PCM16 LE. Buffers from Buffer.concat /
  // Buffer.from(arrayBuffer) can have an odd byteOffset, which Int16Array's
  // 2-byte alignment rejects; copy into a fresh aligned buffer in that rare case.
  let inView: Int16Array;
  if ((src.byteOffset & 1) === 0) {
    inView = new Int16Array(src.buffer, src.byteOffset, srcSamples);
  } else {
    const aligned = new Uint8Array(srcSamples * 2);
    aligned.set(src.subarray(0, srcSamples * 2));
    inView = new Int16Array(aligned.buffer);
  }
  const ratio = toRate / fromRate;
  const dstSamples = Math.round(srcSamples * ratio);
  const out = new Int16Array(dstSamples);
  for (let i = 0; i < dstSamples; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, srcSamples - 1);
    const frac = srcPos - i0;
    const s0 = inView[i0];
    const s1 = inView[i1];
    out[i] = Math.round(s0 * (1 - frac) + s1 * frac);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}
