import { describe, it, expect } from 'vitest';
import {
  generateConfirmBlip,
  generateConfirmOnBlip,
  generateConfirmOffBlip,
  generateListenBlip,
  isAckOnly,
  getAckVariant,
  ACK_MARKER,
  ACK_ON_MARKER,
  ACK_OFF_MARKER,
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

  it('isAckOnly recognises all three markers with whitespace', () => {
    expect(isAckOnly(ACK_MARKER)).toBe(true);
    expect(isAckOnly(ACK_ON_MARKER)).toBe(true);
    expect(isAckOnly(ACK_OFF_MARKER)).toBe(true);
    expect(isAckOnly(`  ${ACK_ON_MARKER}  `)).toBe(true);
    expect(isAckOnly(`${ACK_OFF_MARKER}\n`)).toBe(true);
  });

  it('isAckOnly rejects anything with extra content', () => {
    expect(isAckOnly(`${ACK_MARKER} done`)).toBe(false);
    expect(isAckOnly('Готово')).toBe(false);
    expect(isAckOnly('лампа включена')).toBe(false);
    expect(isAckOnly('')).toBe(false);
  });

  it('getAckVariant returns correct variant for each marker', () => {
    expect(getAckVariant(ACK_ON_MARKER)).toBe('on');
    expect(getAckVariant(ACK_OFF_MARKER)).toBe('off');
    expect(getAckVariant(ACK_MARKER)).toBe('neutral');
    expect(getAckVariant('  ✓+  ')).toBe('on');
    expect(getAckVariant('что-то другое')).toBeNull();
  });

  it('generateListenBlip returns non-empty PCM and starts at low amplitude (attack)', () => {
    const buf = generateListenBlip(24000);
    expect(buf.length).toBeGreaterThan(0);
    expect(Math.abs(buf.readInt16LE(0))).toBeLessThan(2000);
  });
});
