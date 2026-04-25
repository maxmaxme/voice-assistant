import { describe, it, expect } from 'vitest';
import { bufferToStream, isAbortError } from '../../src/audio/streamHelpers.ts';

describe('bufferToStream', () => {
  it('wraps a buffer as a single-chunk async iterable', async () => {
    const buf = Buffer.from([1, 2, 3, 4]);
    const stream = bufferToStream(buf, 24000);
    expect(stream.sampleRate).toBe(24000);
    const chunks: Buffer[] = [];
    for await (const c of stream.chunks) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].equals(buf)).toBe(true);
  });
});

describe('isAbortError', () => {
  it('returns true for AbortError DOMException', () => {
    const err = new DOMException('aborted', 'AbortError');
    expect(isAbortError(err)).toBe(true);
  });
  it('returns true for errors with name === "AbortError"', () => {
    const err = Object.assign(new Error('x'), { name: 'AbortError' });
    expect(isAbortError(err)).toBe(true);
  });
  it('returns false for other errors', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError('string')).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
