import { describe, it, expect } from 'vitest';
import { targetDay, lastWeekdayOfWindow, isInWindow } from '../src/schedule.ts';

describe('targetDay', () => {
  it('returns 15 when 15th is a Monday', () => {
    // 2026-06-15 is a Monday
    expect(targetDay(2026, 6)).toBe(15);
  });

  it('returns 17 when 15th is a Saturday', () => {
    // 2026-08-15 is a Saturday → first weekday on/after is Mon 2026-08-17
    expect(targetDay(2026, 8)).toBe(17);
  });

  it('returns 16 when 15th is a Sunday', () => {
    // 2026-11-15 is a Sunday → first weekday is Mon 2026-11-16
    expect(targetDay(2026, 11)).toBe(16);
  });

  it('returns 15 when 15th is a Friday', () => {
    // 2026-05-15 is a Friday
    expect(targetDay(2026, 5)).toBe(15);
  });
});

describe('lastWeekdayOfWindow', () => {
  it('is the latest Mon-Fri in [15,21]', () => {
    // 2026-05: 15=Fri, 16=Sat, 17=Sun, 18=Mon..21=Thu → last weekday is 21
    expect(lastWeekdayOfWindow(2026, 5)).toBe(21);
  });

  it('skips back from Sat/Sun on day 21', () => {
    // 2026-02: 15=Sun, 21=Sat → last weekday in window is Fri 2026-02-20
    expect(lastWeekdayOfWindow(2026, 2)).toBe(20);
  });
});

describe('isInWindow', () => {
  it('true on day 15 if weekday and within month', () => {
    expect(isInWindow(2026, 5, 15)).toBe(true);
  });

  it('false on day 14', () => {
    expect(isInWindow(2026, 5, 14)).toBe(false);
  });

  it('false on day 22', () => {
    expect(isInWindow(2026, 5, 22)).toBe(false);
  });

  it('false on a weekend day inside 15-21', () => {
    expect(isInWindow(2026, 5, 16)).toBe(false); // Sat
    expect(isInWindow(2026, 5, 17)).toBe(false); // Sun
  });
});
