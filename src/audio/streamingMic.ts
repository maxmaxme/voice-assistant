import mic from 'mic';

export interface StreamingMicOptions {
  sampleRate: number;
  /** PCM chunk size in 16-bit samples. openWakeWord expects 1280 at 16kHz (80ms). */
  frameLength: number;
}

export class StreamingMic {
  private m: ReturnType<typeof mic> | null = null;
  private listeners = new Set<(frame: Int16Array) => void>();
  private leftover = Buffer.alloc(0);
  private readonly opts: StreamingMicOptions;

  constructor(opts: StreamingMicOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.m) {
      return;
    }
    const m = mic({
      rate: String(this.opts.sampleRate),
      channels: '1',
      bitwidth: '16',
      encoding: 'signed-integer',
      endian: 'little',
    });
    const stream = m.getAudioStream();
    stream.on('data', (chunk: Buffer) => this.onChunk(chunk));
    m.start();
    this.m = m;
  }

  stop(): void {
    this.m?.stop();
    this.m = null;
    this.leftover = Buffer.alloc(0);
  }

  onFrame(cb: (frame: Int16Array) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private onChunk(chunk: Buffer): void {
    const buf = Buffer.concat([this.leftover, chunk]);
    const frameBytes = this.opts.frameLength * 2;
    let offset = 0;
    while (buf.length - offset >= frameBytes) {
      // IMPORTANT: do NOT use `new Int16Array(buf.buffer, buf.byteOffset + offset, ...)`.
      // Node Buffers are slices of a shared 8KB pool; byteOffset is not guaranteed
      // to be 2-byte aligned, which throws RangeError. Copy into a fresh Int16Array.
      const frame = new Int16Array(this.opts.frameLength);
      for (let i = 0; i < this.opts.frameLength; i++) {
        frame[i] = buf.readInt16LE(offset + i * 2);
      }
      for (const l of this.listeners) {
        l(frame);
      }
      offset += frameBytes;
    }
    this.leftover = buf.subarray(offset);
  }
}
