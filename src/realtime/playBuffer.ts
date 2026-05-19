import { platform } from 'node:os';
import { spawn } from 'node:child_process';

const IS_LINUX = platform() === 'linux';

/**
 * One-shot PCM16 playback: spawns ffplay/aplay, writes the buffer, closes
 * stdin, and resolves when the subprocess exits. Used for short chimes
 * (wake-blip, etc.). Same player choice as ResponseSpeaker for consistency.
 */
export async function playBuffer(pcm: Buffer, sampleRate: number): Promise<void> {
  const cmd = IS_LINUX ? 'aplay' : 'ffplay';
  const args = IS_LINUX
    ? ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(sampleRate), '-c', '1']
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
        String(sampleRate),
        '-ch_layout',
        'mono',
        '-i',
        '-',
      ];
  const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'inherit'] });
  proc.stdin?.on('error', () => {
    // EPIPE if the subprocess exits before we finish writing — ignore.
  });
  await new Promise<void>((resolve) => {
    proc.on('exit', () => resolve());
    proc.on('error', () => resolve());
    proc.stdin?.write(pcm);
    proc.stdin?.end();
  });
}
