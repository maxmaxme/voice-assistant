import { platform } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SpeakerOutput, TtsStream } from './types.ts';
import { isAbortError } from './streamHelpers.ts';

const IS_LINUX = platform() === 'linux';

interface SpeakerLike {
  on(event: string, cb: (arg?: unknown) => void): unknown;
  removeAllListeners(event: string): unknown;
  write(buf: Buffer, cb: (err?: Error) => void): boolean;
  end(): unknown;
  destroy(): unknown;
}

interface SpeakerCtor {
  new (opts: { channels: number; bitDepth: number; sampleRate: number }): SpeakerLike;
}

let speakerCtorCache: SpeakerCtor | null | undefined;

async function loadSpeakerCtor(): Promise<SpeakerCtor | null> {
  if (speakerCtorCache !== undefined) return speakerCtorCache;
  try {
    const mod = (await import('speaker')) as unknown as { default: SpeakerCtor };
    speakerCtorCache = mod.default;
  } catch {
    speakerCtorCache = null;
  }
  return speakerCtorCache;
}

export class NodeSpeakerOutput implements SpeakerOutput {
  private currentProc: ChildProcess | null = null;
  private currentSpeaker: SpeakerLike | null = null;

  async playStream(stream: TtsStream, opts?: { signal?: AbortSignal }): Promise<void> {
    this.stop();
    if (IS_LINUX) return this.playStreamViaAplay(stream, opts);
    return this.playStreamViaSpeakerNpm(stream, opts);
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
    if (this.currentSpeaker) {
      const s = this.currentSpeaker;
      this.currentSpeaker = null;
      try {
        s.removeAllListeners('error');
        s.on('error', () => {});
        s.end();
        s.destroy();
      } catch {
        // best-effort
      }
    }
  }

  private async playStreamViaAplay(
    stream: TtsStream,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const proc = spawn(
      'aplay',
      ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(stream.sampleRate), '-c', '1'],
      { stdio: ['pipe', 'ignore', 'inherit'] },
    );
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
      // AbortError from the upstream TTS iterator is normal cancellation.
      if (!isAbortError(err)) throw err;
    } finally {
      opts?.signal?.removeEventListener('abort', onAbort);
      if (this.currentProc === proc) this.currentProc = null;
    }
  }

  private async playStreamViaSpeakerNpm(
    _stream: TtsStream,
    _opts?: { signal?: AbortSignal },
  ): Promise<void> {
    // Implemented in Task 5.
    throw new Error('macOS speaker path not yet implemented');
  }
}
