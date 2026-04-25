import { describe, it, expect } from 'vitest';
import { generateConfirmBlip, isAckOnly, ACK_MARKER } from '../../src/audio/blip.js';

describe('blip', () => {
  it('generateConfirmBlip returns PCM of expected size at 24kHz', () => {
    const buf = generateConfirmBlip(24000);
    expect(buf.length).toBe(Math.floor((24000 * 220) / 1000) * 2);
  });

  it('generateConfirmBlip envelope decays to near-zero at the end', () => {
    const buf = generateConfirmBlip(24000);
    // Last sample should be tiny (envelope ~e^(-2.6) at t=0.22s).
    const lastSample = buf.readInt16LE(buf.length - 2);
    expect(Math.abs(lastSample)).toBeLessThan(1000);
  });

  it('isAckOnly recognises the marker with whitespace', () => {
    expect(isAckOnly(ACK_MARKER)).toBe(true);
    expect(isAckOnly(`  ${ACK_MARKER}  `)).toBe(true);
    expect(isAckOnly(`${ACK_MARKER}\n`)).toBe(true);
  });

  it('isAckOnly rejects anything with extra content', () => {
    expect(isAckOnly(`${ACK_MARKER} done`)).toBe(false);
    expect(isAckOnly('Готово')).toBe(false);
    expect(isAckOnly('лампа включена')).toBe(false);
    expect(isAckOnly('')).toBe(false);
  });
});
