import Speaker from 'speaker';
import type { SpeakerOutput } from './types.js';

export class NodeSpeakerOutput implements SpeakerOutput {
  async play(buf: Buffer, opts: { sampleRate: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      const speaker = new Speaker({
        channels: 1,
        bitDepth: 16,
        sampleRate: opts.sampleRate,
      });
      speaker.on('close', () => resolve());
      speaker.on('error', (err: Error) => reject(err));
      speaker.write(buf, (err) => {
        if (err) return reject(err);
        speaker.end();
      });
    });
  }
}
