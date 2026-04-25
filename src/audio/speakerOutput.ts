import { platform } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SpeakerOutput } from './types.ts';

/**
 * Platform-conditional speaker:
 * - Linux (Pi / Docker container): spawn `aplay` from alsa-utils. Avoids the
 *   `speaker` npm package's bundled-mpg123 build issues on modern Node.
 * - macOS / others: use the `speaker` npm package via dynamic import. It
 *   ships prebuilds for darwin/arm64 + darwin/x64 so dev install just works.
 *
 * The `speaker` npm dep is in optionalDependencies so a failed compile in
 * the Linux container doesn't fail the whole install — we never load it
 * there anyway.
 */

const IS_LINUX = platform() === 'linux';

interface SpeakerLike {
  on(event: string, cb: (arg?: unknown) => void): unknown;
  removeAllListeners(event: string): unknown;
  write(buf: Buffer, cb: (err?: Error) => void): unknown;
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

  async play(buf: Buffer, opts: { sampleRate: number }): Promise<void> {
    this.stop();
    if (IS_LINUX) return this.playViaAplay(buf, opts.sampleRate);
    return this.playViaSpeakerNpm(buf, opts.sampleRate);
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

  private async playViaAplay(buf: Buffer, sampleRate: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // -q quiet, -t raw (PCM), S16_LE matches our generated buffers and
      // openai-tts pcm output, -c 1 mono.
      const proc = spawn(
        'aplay',
        ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(sampleRate), '-c', '1'],
        { stdio: ['pipe', 'ignore', 'inherit'] },
      );
      this.currentProc = proc;
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (this.currentProc === proc) this.currentProc = null;
        if (err) reject(err);
        else resolve();
      };
      proc.on('exit', () => finish());
      proc.on('error', (err) => finish(err));
      proc.stdin?.on('error', () => {
        // ignore EPIPE on stop()
      });
      proc.stdin?.write(buf);
      proc.stdin?.end();
    });
  }

  private async playViaSpeakerNpm(buf: Buffer, sampleRate: number): Promise<void> {
    const Ctor = await loadSpeakerCtor();
    if (!Ctor) {
      throw new Error(
        "Audio playback unavailable: 'speaker' npm package failed to load and " +
          "this is not a Linux host (no `aplay` fallback). Install `sox` or " +
          'rebuild speaker for your platform.',
      );
    }
    return new Promise((resolve, reject) => {
      const speaker = new Ctor({ channels: 1, bitDepth: 16, sampleRate });
      this.currentSpeaker = speaker;
      speaker.on('close', () => {
        if (this.currentSpeaker === speaker) this.currentSpeaker = null;
        resolve();
      });
      speaker.on('error', (err) => {
        if (this.currentSpeaker === speaker) this.currentSpeaker = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      speaker.write(buf, (err?: Error) => {
        if (err) return reject(err);
        speaker.end();
      });
    });
  }
}
