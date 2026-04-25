declare module 'mic' {
  import { Readable } from 'node:stream';

  interface MicOptions {
    rate?: string;
    channels?: string;
    bitwidth?: string;
    encoding?: string;
    endian?: string;
    device?: string;
    fileType?: string;
    debug?: boolean;
    exitOnSilence?: number;
  }

  interface MicInstance {
    start(): void;
    stop(): void;
    pause(): void;
    resume(): void;
    getAudioStream(): Readable;
  }

  function mic(opts?: MicOptions): MicInstance;
  export default mic;
}
