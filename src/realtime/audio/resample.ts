export function resamplePcm16(src: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) {
    return Buffer.from(src);
  }
  const srcSamples = src.length / 2;
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
    const s = Math.round(s0 * (1 - frac) + s1 * frac);
    dst.writeInt16LE(s, i * 2);
  }
  return dst;
}
