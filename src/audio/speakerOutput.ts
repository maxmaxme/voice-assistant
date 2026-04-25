import Speaker from 'speaker';
import type { SpeakerOutput } from './types.ts';

export class NodeSpeakerOutput implements SpeakerOutput {
  private current: Speaker | null = null;

  async play(buf: Buffer, opts: { sampleRate: number }): Promise<void> {
    // Cut off any prior playback before starting a new one.
    this.stop();
    return new Promise((resolve, reject) => {
      const speaker = new Speaker({
        channels: 1,
        bitDepth: 16,
        sampleRate: opts.sampleRate,
      });
      this.current = speaker;
      speaker.on('close', () => {
        if (this.current === speaker) this.current = null;
        resolve();
      });
      speaker.on('error', (err: Error) => {
        if (this.current === speaker) this.current = null;
        reject(err);
      });
      speaker.write(buf, (err) => {
        if (err) return reject(err);
        speaker.end();
      });
    });
  }

  stop(): void {
    if (!this.current) return;
    const s = this.current;
    this.current = null;
    try {
      // Detach error listener: the close-during-write often surfaces as
      // EPIPE / "write after end", which is expected here.
      s.removeAllListeners('error');
      s.on('error', () => {});
      s.end();
      s.destroy();
    } catch {
      // best-effort
    }
  }
}
