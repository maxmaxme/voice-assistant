export interface MicInput {
  /** Records 16-bit mono PCM at the given sample rate until stop() is called. */
  record(opts: { sampleRate: number }): Promise<{ stop(): Promise<Buffer> }>;
}

export interface SpeakerOutput {
  /** Plays a stream of 16-bit mono PCM chunks at the given sample rate.
   *  Resolves when playback ends (all chunks consumed) or when aborted via
   *  signal / stop(). On abort, resolves cleanly (no AbortError thrown). */
  playStream(
    stream: { chunks: AsyncIterable<Buffer>; sampleRate: number },
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
  /** Synchronous hard-cut. No-op if idle. */
  stop(): void;
}

export interface Stt {
  transcribe(audio: Buffer, opts: { sampleRate: number }): Promise<string>;
}

export interface AudioFileStt {
  transcribeFile(audio: Buffer, opts: { filename: string; contentType: string }): Promise<string>;
}

export interface TtsStream {
  sampleRate: number;
  chunks: AsyncIterable<Buffer>;
}

export interface Tts {
  stream(
    text: string,
    opts?: { voice?: string; instructions?: string; signal?: AbortSignal },
  ): TtsStream;
}
