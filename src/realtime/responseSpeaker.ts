import * as fs from 'node:fs';
import { platform } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('response-speaker');
const IS_LINUX = platform() === 'linux';

/**
 * One-shot PCM16 playback for a single Realtime response. Lifecycle:
 *
 *   write(chunk) → write(chunk) → ... → write(chunk) → await done()
 *
 *  - The subprocess (`aplay` on Linux, `sox play` on macOS) is spawned
 *    lazily on the first `write()`.
 *  - `done()` closes stdin, then resolves when the subprocess exits — sox/
 *    aplay drain whatever's buffered before exiting, so the very last
 *    sample is reliably played out.
 *  - `stop()` hard-kills the subprocess (used on shutdown).
 *
 *  Compared to a session-long subprocess, this gives us deterministic
 *  drain at the end of every response: no buffered tail clipped, no leak
 *  into the next utterance.
 */
export class ResponseSpeaker {
  private proc: ChildProcess | null = null;
  private exited: Promise<void> | null = null;
  private dumpStream: fs.WriteStream | null = null;
  private readonly sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  write(chunk: Buffer): void {
    if (!this.proc) {
      this.spawnProc();
    }
    this.dumpStream?.write(chunk);
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed) {
      return;
    }
    stdin.write(chunk);
  }

  /** Close stdin and wait for the subprocess to finish playing. */
  async done(): Promise<void> {
    const proc = this.proc;
    const exited = this.exited;
    this.proc = null;
    this.exited = null;
    if (!proc || !exited) {
      return;
    }
    proc.stdin?.end();
    this.dumpStream?.end();
    this.dumpStream = null;
    await exited;
  }

  /** Hard kill — used on shutdown when we don't want to wait for drain. */
  stop(): void {
    if (!this.proc) {
      return;
    }
    const proc = this.proc;
    this.proc = null;
    this.exited = null;
    try {
      proc.stdin?.destroy();
      proc.kill('SIGTERM');
    } catch {
      // best-effort
    }
  }

  private spawnProc(): void {
    const dumpPath = process.env.REALTIME_AUDIO_DUMP;
    if (dumpPath) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const path = dumpPath.includes('{ts}')
        ? dumpPath.replace('{ts}', ts)
        : `${dumpPath}.${ts}.pcm`;
      this.dumpStream = fs.createWriteStream(path);
      log.info({ path }, 'dumping raw PCM to file');
    }
    // Linux: `aplay` from alsa-utils. macOS: `ffplay` from ffmpeg — sox `play`
    // truncates the tail of streamed PCM (it can exit when its read buffer
    // briefly empties between bursts, before CoreAudio has drained), so we
    // require ffmpeg (`brew install ffmpeg`) on the dev machine.
    const cmd = IS_LINUX ? 'aplay' : 'ffplay';
    const args = IS_LINUX
      ? ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(this.sampleRate), '-c', '1']
      : [
          '-nodisp',
          '-autoexit',
          '-loglevel',
          'quiet',
          '-fflags',
          'nobuffer',
          '-flags',
          'low_delay',
          '-probesize',
          '32',
          '-analyzeduration',
          '0',
          '-f',
          's16le',
          '-ar',
          String(this.sampleRate),
          '-ch_layout',
          'mono',
          '-i',
          '-',
        ];
    const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'inherit'] });
    proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      // EPIPE happens when Node tries to flush a write after the subprocess
      // has already exited — harmless tail at the end of a response.
      if (err.code === 'EPIPE') {
        return;
      }
      log.warn({ err }, 'speaker stdin error');
    });
    proc.on('error', (err) => log.error({ err }, 'speaker subprocess error'));
    this.exited = new Promise<void>((resolve) => {
      proc.on('exit', () => resolve());
    });
    this.proc = proc;
  }
}
