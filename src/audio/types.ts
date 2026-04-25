export interface MicInput {
  /** Records 16-bit mono PCM at the given sample rate until stop() is called. */
  record(opts: { sampleRate: number }): Promise<{ stop(): Promise<Buffer> }>;
}

export interface SpeakerOutput {
  /** Plays 16-bit mono PCM at the given sample rate. Resolves when playback ends or
   *  when stop() is called from outside. */
  play(buf: Buffer, opts: { sampleRate: number }): Promise<void>;
  /** Aborts the in-flight play() (if any), cutting audio mid-buffer. No-op if idle. */
  stop(): void;
}

export interface Stt {
  transcribe(audio: Buffer, opts: { sampleRate: number; language?: string }): Promise<string>;
}

export interface Tts {
  synthesize(text: string, opts?: { voice?: string; instructions?: string }): Promise<{
    audio: Buffer;
    sampleRate: number;
  }>;
}
