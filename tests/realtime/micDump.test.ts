import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MicDump } from '../../src/realtime/micDump.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'micdump-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe('MicDump', () => {
  it('is off without a dir and writes nothing', () => {
    const dump = new MicDump('s1', undefined);
    expect(dump.enabled).toBe(false);
    dump.push(Buffer.alloc(320));
    dump.flush();
  });

  it('writes a playable WAV with correct sizes per turn', () => {
    const dir = tmp();
    const dump = new MicDump('s1', dir);
    dump.push(Buffer.alloc(320, 1));
    dump.push(Buffer.alloc(160, 2));
    dump.flush();
    dump.flush(); // nothing buffered — no second file
    dump.push(Buffer.alloc(100, 3));
    dump.flush();

    expect(readdirSync(dir).sort()).toEqual(['s1-1.wav', 's1-2.wav']);
    const wav = readFileSync(join(dir, 's1-1.wav'));
    expect(wav.length).toBe(44 + 480);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + 480);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(40)).toBe(480);
  });
});
