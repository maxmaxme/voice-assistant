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
    dump.setSpeaker('Living Room');
    dump.push(Buffer.alloc(320, 1));
    dump.push(Buffer.alloc(160, 2));
    dump.flush();
    dump.flush(); // nothing buffered — no second file
    dump.push(Buffer.alloc(100, 3));
    dump.flush();

    const names = readdirSync(dir).sort();
    // Both turns land in the same second, so the second one gets the collision
    // suffix; either way the name carries the timestamp and the speaker.
    expect(names).toHaveLength(2);
    for (const n of names) {
      expect(n).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-living-room(-s1\d+)?\.wav$/);
    }
    const wav = names.map((n) => readFileSync(join(dir, n))).find((b) => b.length > 44 + 200)!;
    expect(wav.length).toBe(44 + 480);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + 480);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(40)).toBe(480);
  });

  it('keeps only the newest 20 dumps', () => {
    const dir = tmp();
    const dump = new MicDump('s1', dir);
    for (let i = 0; i < 25; i++) {
      dump.push(Buffer.alloc(32, i));
      dump.flush();
    }
    expect(readdirSync(dir)).toHaveLength(20);
  });
});
