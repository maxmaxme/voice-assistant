import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('realtime:micdump');

const SAMPLE_RATE = 16000;
const MAX_BYTES = SAMPLE_RATE * 2 * 60;
// Debug tap left on for days would otherwise fill the Pi's disk.
const KEEP_FILES = 20;

function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/**
 * Debug tap on the device→bridge mic stream: buffers one turn's raw PCM16 and
 * writes it out as a WAV so the exact audio OpenAI heard can be listened to.
 * Off unless MIC_DUMP_DIR is set.
 */
export class MicDump {
  private readonly dir: string | undefined;
  private readonly sessionId: string;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private turn = 0;

  constructor(sessionId: string, dir = process.env.MIC_DUMP_DIR) {
    this.sessionId = sessionId;
    this.dir = dir || undefined;
  }

  get enabled(): boolean {
    return this.dir !== undefined;
  }

  push(pcm16: Buffer): void {
    if (this.dir === undefined || this.bytes >= MAX_BYTES) {
      return;
    }
    this.chunks.push(pcm16);
    this.bytes += pcm16.length;
  }

  /** Write the buffered turn to `<dir>/<sessionId>-<n>.wav`, then reset. */
  flush(): void {
    const dir = this.dir;
    if (dir === undefined || this.bytes === 0) {
      return;
    }
    const data = Buffer.concat(this.chunks);
    this.chunks = [];
    this.bytes = 0;
    const file = join(dir, `${this.sessionId}-${++this.turn}.wav`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, Buffer.concat([wavHeader(data.length), data]));
      log.info(
        { sessionId: this.sessionId, file, ms: Math.round((data.length / 2 / SAMPLE_RATE) * 1000) },
        'mic dump written',
      );
      prune(dir);
    } catch (err) {
      log.warn({ err, file }, 'mic dump failed');
    }
  }
}

/** Keep only the newest {@link KEEP_FILES} dumps — mtime order, not name
 * order: session ids aren't chronological. */
function prune(dir: string): void {
  const wavs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.wav'))
    .map((e) => ({ path: join(dir, e.name), mtime: statSync(join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of wavs.slice(KEEP_FILES)) {
    unlinkSync(stale.path);
  }
}
