export interface RmsVadOptions {
  sampleRate: number;
  frameLength: number;
  threshold: number;
  silenceMs: number;
}

export class RmsVad {
  private inSpeech = false;
  private silentFrames = 0;
  private readonly silenceFramesNeeded: number;
  private speechCb: () => void = () => {};
  private silenceCb: () => void = () => {};
  private readonly opts: RmsVadOptions;

  constructor(opts: RmsVadOptions) {
    this.opts = opts;
    const frameMs = (opts.frameLength / opts.sampleRate) * 1000;
    this.silenceFramesNeeded = Math.ceil(opts.silenceMs / frameMs);
  }

  onSpeech(cb: () => void): void { this.speechCb = cb; }
  onSilence(cb: () => void): void { this.silenceCb = cb; }

  feed(frame: Int16Array): void {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);

    if (rms >= this.opts.threshold) {
      if (!this.inSpeech) {
        this.inSpeech = true;
        this.silentFrames = 0;
        this.speechCb();
      } else {
        this.silentFrames = 0;
      }
    } else if (this.inSpeech) {
      this.silentFrames++;
      if (this.silentFrames >= this.silenceFramesNeeded) {
        this.inSpeech = false;
        this.silentFrames = 0;
        this.silenceCb();
      }
    }
  }

  reset(): void {
    this.inSpeech = false;
    this.silentFrames = 0;
  }
}
