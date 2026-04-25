import { platform } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SpeakerOutput, TtsStream } from './types.ts';
import { isAbortError } from './streamHelpers.ts';

/**
 * 16-bit mono PCM playback by piping into a subprocess that owns the audio
 * device. Linux uses `aplay` (alsa-utils); macOS / others use SoX `play`
 * (`brew install sox`). Both have generous internal buffers that keep the
 * audio device fed across network jitter from streaming TTS, and both
 * release the device cleanly under SIGTERM — which the previous `speaker`
 * npm backend on macOS did not, leaving coreaudio in a flaky state on
 * barge-in.
 */

const IS_LINUX = platform() === 'linux';

interface PlayerSpec {
  cmd: string;
  args(sampleRate: number): string[];
}

const APLAY: PlayerSpec = {
  cmd: 'aplay',
  args: (sr) => ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(sr), '-c', '1'],
};

const SOX_PLAY: PlayerSpec = {
  cmd: 'play',
  args: (sr) => [
    '-q',
    '-t', 'raw',
    '-e', 'signed',
    '-b', '16',
    '-c', '1',
    '-r', String(sr),
    '-',
  ],
};

export class NodeSpeakerOutput implements SpeakerOutput {
  private currentProc: ChildProcess | null = null;

  async playStream(stream: TtsStream, opts?: { signal?: AbortSignal }): Promise<void> {
    this.stop();
    const player = IS_LINUX ? APLAY : SOX_PLAY;
    const proc = spawn(player.cmd, player.args(stream.sampleRate), {
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    this.currentProc = proc;

    const onAbort = (): void => this.stop();
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdin?.on('error', () => {
      // EPIPE on stop() — ignore. The for-await loop will exit on the next
      // iteration via the `destroyed` check.
    });

    let procExited = false;
    const exited = new Promise<void>((resolve, reject) => {
      proc.on('exit', () => {
        procExited = true;
        resolve();
      });
      proc.on('error', (err) => reject(err));
    });

    try {
      for await (const chunk of stream.chunks) {
        if (opts?.signal?.aborted) break;
        if (!proc.stdin || proc.stdin.destroyed) break;
        if (procExited) break;
        const ok = proc.stdin.write(chunk);
        if (!ok) {
          await new Promise<void>((resolve) => {
            const cleanup = (): void => {
              proc.stdin!.removeListener('drain', onDrain);
              proc.removeListener('exit', onExit);
              resolve();
            };
            const onDrain = (): void => cleanup();
            const onExit = (): void => cleanup();
            proc.stdin!.once('drain', onDrain);
            proc.once('exit', onExit);
          });
        }
      }
      proc.stdin?.end();
      await exited;
    } catch (err) {
      if (!isAbortError(err)) throw err;
    } finally {
      opts?.signal?.removeEventListener('abort', onAbort);
      if (this.currentProc === proc) this.currentProc = null;
    }
  }

  stop(): void {
    if (this.currentProc) {
      const p = this.currentProc;
      this.currentProc = null;
      try {
        p.stdin?.destroy();
        p.kill('SIGTERM');
      } catch {
        // best-effort
      }
    }
  }
}
