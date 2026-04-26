import { describe, it, expect } from 'vitest';
import {
  generateConfirmBlip,
  generateConfirmOnBlip,
  generateConfirmOffBlip,
  generateListenBlip,
} from '../../src/audio/blip.ts';

describe('blip', () => {
  it('generateConfirmBlip returns PCM of expected size at 24kHz', () => {
    const buf = generateConfirmBlip(24000);
    expect(buf.length).toBe(Math.floor((24000 * 220) / 1000) * 2);
  });

  it('generateConfirmBlip envelope decays to near-zero at the end', () => {
    const buf = generateConfirmBlip(24000);
    const lastSample = buf.readInt16LE(buf.length - 2);
    expect(Math.abs(lastSample)).toBeLessThan(1000);
  });

  it('generateConfirmOnBlip and generateConfirmOffBlip return non-empty PCM', () => {
    expect(generateConfirmOnBlip(24000).length).toBeGreaterThan(0);
    expect(generateConfirmOffBlip(24000).length).toBeGreaterThan(0);
  });

  it('generateListenBlip returns non-empty PCM and starts at low amplitude (attack)', () => {
    const buf = generateListenBlip(24000);
    expect(buf.length).toBeGreaterThan(0);
    expect(Math.abs(buf.readInt16LE(0))).toBeLessThan(2000);
  });
});
