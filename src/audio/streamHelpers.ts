import type { TtsStream } from './types.ts';

export function bufferToStream(buf: Buffer, sampleRate: number): TtsStream {
  return {
    sampleRate,
    chunks: (async function* () {
      yield buf;
    })(),
  };
}

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError';
}
