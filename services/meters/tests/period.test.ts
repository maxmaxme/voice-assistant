import { describe, it, expect } from 'vitest';
import { currentPeriod } from '../src/period.ts';

describe('currentPeriod', () => {
  it('returns YYYY-MM in Europe/Moscow', () => {
    // 2026-05-16 00:30 UTC is 2026-05-16 03:30 MSK → period 2026-05
    expect(currentPeriod(new Date('2026-05-16T00:30:00Z'))).toBe('2026-05');
  });

  it('rolls over by Moscow midnight, not UTC midnight', () => {
    // 2026-05-31 22:00 UTC is 2026-06-01 01:00 MSK → period 2026-06
    expect(currentPeriod(new Date('2026-05-31T22:00:00Z'))).toBe('2026-06');
  });

  it('zero-pads single-digit months', () => {
    expect(currentPeriod(new Date('2026-01-15T10:00:00Z'))).toBe('2026-01');
  });
});
