import { describe, it, expect, afterEach } from 'vitest';
import { getServerTimezone, toLocalIso, parseLocalWallClock } from '../../src/utils/time.ts';

describe('time utils', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  describe('getServerTimezone', () => {
    it('returns the IANA name driven by process.env.TZ', () => {
      process.env.TZ = 'Europe/Madrid';
      expect(getServerTimezone()).toBe('Europe/Madrid');
      process.env.TZ = 'America/Los_Angeles';
      expect(getServerTimezone()).toBe('America/Los_Angeles');
    });
  });

  describe('toLocalIso', () => {
    it('formats a UTC instant in the server timezone with the offset suffix', () => {
      // 2026-04-26T15:13:41Z = 17:13:41 in Europe/Madrid (CEST = UTC+2)
      process.env.TZ = 'Europe/Madrid';
      const ms = Date.UTC(2026, 3, 26, 15, 13, 41);
      const out = toLocalIso(ms);
      expect(out).toContain('2026-04-26 17:13:41');
      expect(out).toContain('GMT+02:00');
    });

    it('produces different strings for the same instant under different TZs', () => {
      const ms = Date.UTC(2030, 0, 1, 12, 30, 0);
      process.env.TZ = 'Europe/Moscow'; // UTC+3 in winter
      const moscow = toLocalIso(ms);
      process.env.TZ = 'America/Los_Angeles'; // UTC-8 in winter
      const la = toLocalIso(ms);
      expect(moscow).toContain('15:30');
      expect(la).toContain('04:30');
      expect(moscow).not.toBe(la);
    });

    it('renders UTC instants verbatim when TZ=UTC', () => {
      process.env.TZ = 'UTC';
      const ms = Date.UTC(2026, 5, 15, 9, 0, 0);
      const out = toLocalIso(ms);
      expect(out).toContain('2026-06-15 09:00:00');
      expect(out).toContain('GMT');
    });
  });

  describe('parseLocalWallClock', () => {
    it('parses YYYY-MM-DD HH:mm:ss as wall-clock in process.env.TZ', () => {
      process.env.TZ = 'Europe/Madrid'; // CEST = UTC+2 in June
      const ms = parseLocalWallClock('2099-06-15 09:00:00');
      expect(ms).toBe(Date.UTC(2099, 5, 15, 7, 0, 0));
    });

    it('accepts the HH:mm form (seconds optional)', () => {
      process.env.TZ = 'Europe/Madrid';
      const ms = parseLocalWallClock('2099-06-15 09:00');
      expect(ms).toBe(Date.UTC(2099, 5, 15, 7, 0, 0));
    });

    it('accepts T as the date/time separator', () => {
      process.env.TZ = 'Europe/Madrid';
      const ms = parseLocalWallClock('2099-06-15T09:00:00');
      expect(ms).toBe(Date.UTC(2099, 5, 15, 7, 0, 0));
    });

    it('respects the server TZ — same wall-clock string in different TZs maps to different instants', () => {
      process.env.TZ = 'Europe/Madrid';
      const madrid = parseLocalWallClock('2099-06-15 09:00');
      process.env.TZ = 'America/Los_Angeles';
      const la = parseLocalWallClock('2099-06-15 09:00');
      expect(madrid).not.toBe(la);
      // LA (UTC-7 in summer) is 9 hours behind Madrid (UTC+2)
      expect(la - madrid).toBe(9 * 3600 * 1000);
    });

    it('rejects malformed strings', () => {
      expect(() => parseLocalWallClock('tomorrow at 9am')).toThrow(/invalid wall-clock/);
      expect(() => parseLocalWallClock('2099-06-15')).toThrow(/invalid wall-clock/);
      expect(() => parseLocalWallClock('2099/06/15 09:00')).toThrow(/invalid wall-clock/);
      expect(() => parseLocalWallClock('2099-06-15 09:00 +02:00')).toThrow(/invalid wall-clock/);
    });

    it('round-trips via toLocalIso', () => {
      process.env.TZ = 'Europe/Madrid';
      const original = '2099-06-15 09:00:00';
      const ms = parseLocalWallClock(original);
      const formatted = toLocalIso(ms);
      // The formatted output starts with the same wall-clock prefix (offset suffix differs).
      expect(formatted.startsWith(original)).toBe(true);
    });
  });
});
