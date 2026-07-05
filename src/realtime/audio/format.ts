// PCM16 mono @ 24 kHz — the OpenAI Realtime API's output audio rate. Shared
// by the output pacer (frame sizing) and the delivery diagnostics (rate math).
export const REALTIME_BYTES_PER_SEC = 48_000;

export function pcm16ToBase64(pcm: Buffer): string {
  if (pcm.length % 2 !== 0) {
    throw new Error(`pcm16 buffer must have even length, got ${pcm.length}`);
  }
  return pcm.toString('base64');
}

export function base64ToPcm16(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}
