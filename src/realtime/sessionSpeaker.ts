import { platform } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('realtime-speaker');
const IS_LINUX = platform() === 'linux';

/**
 * Long-lived PCM16 playback subprocess for a Realtime session. Spawned once
 * on `start()`, fed via `write()` as audio.delta chunks arrive, killed on
 * `stop()`. Surviving the entire session (across many responses) avoids the
 * mid-response cutoff seen when spawning a fresh `sox play` per response —
 * macOS CoreAudio takes ~tens of ms to open, and short overlapping starts
 * leave the device in a flaky state.
 */
export class SessionSpeaker {
  private proc: ChildProcess | null = null;
  private readonly sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  start(): void {
    if (this.proc) {
      return;
    }
    const args = IS_LINUX
      ? ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(this.sampleRate), '-c', '1']
      : [
          '-q',
          '-t',
          'raw',
          '-e',
          'signed',
          '-b',
          '16',
          '-c',
          '1',
          '-r',
          String(this.sampleRate),
          '-',
        ];
    const cmd = IS_LINUX ? 'aplay' : 'play';
    const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'inherit'] });
    proc.stdin?.on('error', (err) => {
      log.warn({ err }, 'speaker stdin error');
    });
    proc.on('exit', (code, signal) => {
      log.warn({ code, signal }, 'speaker subprocess exited');
      if (this.proc === proc) {
        this.proc = null;
      }
    });
    proc.on('error', (err) => {
      log.error({ err }, 'speaker subprocess error');
    });
    this.proc = proc;
  }

  write(chunk: Buffer): void {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      return;
    }
    this.proc.stdin.write(chunk);
  }

  stop(): void {
    if (!this.proc) {
      return;
    }
    const p = this.proc;
    this.proc = null;
    try {
      p.stdin?.end();
      p.kill('SIGTERM');
    } catch {
      // best-effort
    }
  }
}
