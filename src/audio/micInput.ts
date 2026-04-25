import mic from 'mic';
import type { MicInput } from './types.js';

const STOP_FALLBACK_MS = 1500;

export class NodeMicInput implements MicInput {
  async record(opts: { sampleRate: number }): Promise<{ stop(): Promise<Buffer> }> {
    const m = mic({
      rate: String(opts.sampleRate),
      channels: '1',
      bitwidth: '16',
      encoding: 'signed-integer',
      endian: 'little',
    });
    const stream = m.getAudioStream();
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
    };
    stream.on('data', onData);
    m.start();

    return {
      stop: () =>
        new Promise<Buffer>((resolve, reject) => {
          let settled = false;
          const finish = (err?: Error): void => {
            if (settled) return;
            settled = true;
            stream.off('data', onData);
            clearTimeout(timer);
            if (err) reject(err);
            else resolve(Buffer.concat(chunks));
          };
          stream.once('end', () => finish());
          stream.once('error', (err: Error) => finish(err));
          // Fallback: some platforms swallow the 'end' event after stop().
          // Wait long enough for the audio buffer to flush before giving up.
          const timer = setTimeout(() => finish(), STOP_FALLBACK_MS);
          m.stop();
        }),
    };
  }
}
