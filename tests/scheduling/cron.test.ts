import { afterEach, describe, expect, it } from 'vitest';
import { nextFireAt, validateSchedule } from '../../src/scheduling/cron.ts';
import type { Schedule } from '../../src/scheduling/types.ts';

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

function setTz(tz: string): void {
  process.env.TZ = tz;
}

describe('nextFireAt — once', () => {
  it('returns s.at verbatim regardless of now', () => {
    const s: Schedule = { kind: 'once', at: 1_777_220_268_296 };
    expect(nextFireAt(s, 0)).toBe(1_777_220_268_296);
    expect(nextFireAt(s, Date.now())).toBe(1_777_220_268_296);
    expect(nextFireAt(s, 9_999_999_999_999)).toBe(1_777_220_268_296);
  });
});

describe('nextFireAt — cron in Europe/Madrid (CEST)', () => {
  it('"0 8 * * *" from noon Madrid local resolves to next-day 08:00 Madrid', () => {
    setTz('Europe/Madrid');
    // 2026-04-26 12:00 Madrid (CEST = UTC+2) → 10:00 UTC
    const now = Date.UTC(2026, 3, 26, 10, 0, 0);
    const next = nextFireAt({ kind: 'cron', expr: '0 8 * * *' }, now);
    // Expect 2026-04-27 08:00 Madrid → 06:00 UTC
    expect(next).toBe(Date.UTC(2026, 3, 27, 6, 0, 0));
  });

  it('advances by 24h from one fire to the next', () => {
    setTz('Europe/Madrid');
    const expr: Schedule = { kind: 'cron', expr: '0 8 * * *' };
    const start = Date.UTC(2026, 3, 26, 10, 0, 0);
    const first = nextFireAt(expr, start);
    const second = nextFireAt(expr, first);
    expect(second - first).toBe(24 * 60 * 60 * 1000);
  });

  it('successive nextFireAt calls are strictly monotonic', () => {
    setTz('Europe/Madrid');
    const expr: Schedule = { kind: 'cron', expr: '*/15 * * * *' };
    let cursor = Date.UTC(2026, 3, 26, 10, 0, 0);
    const fires: number[] = [];
    for (let i = 0; i < 5; i++) {
      cursor = nextFireAt(expr, cursor);
      fires.push(cursor);
    }
    for (let i = 1; i < fires.length; i++) {
      expect(fires[i]).toBeGreaterThan(fires[i - 1]);
    }
  });
});

describe('nextFireAt — DST edge in America/New_York', () => {
  it('does not crash on the spring-forward day for "0 2 * * *"', () => {
    setTz('America/New_York');
    // 2030-03-09 23:00 New York (EST = UTC-5) → 04:00 UTC on 2030-03-10
    const now = Date.UTC(2030, 2, 10, 4, 0, 0);
    const next = nextFireAt({ kind: 'cron', expr: '0 2 * * *' }, now);
    expect(Number.isFinite(next)).toBe(true);
    expect(next).toBeGreaterThan(now);
  });
});

describe('validateSchedule', () => {
  it('is a no-op for once', () => {
    expect(() => validateSchedule({ kind: 'once', at: 1_777_220_268_296 })).not.toThrow();
  });

  it('throws on garbage cron expressions, mentioning the expression', () => {
    let caught: unknown;
    try {
      validateSchedule({ kind: 'cron', expr: 'not a cron' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message.toLowerCase();
    expect(msg).toContain('cron');
    expect((caught as Error).message).toContain('not a cron');
  });

  it('accepts a valid 5-field cron', () => {
    expect(() => validateSchedule({ kind: 'cron', expr: '0 8 * * *' })).not.toThrow();
  });
});

describe('nextFireAt — invalid cron', () => {
  it('throws for invalid expressions', () => {
    expect(() => nextFireAt({ kind: 'cron', expr: 'totally bogus' }, Date.now())).toThrow(/cron/i);
  });
});
