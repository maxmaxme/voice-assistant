import { describe, it, expect } from 'vitest';
import { flagDefaultOff, flagDefaultOn } from '../../src/settings/flags.ts';

// Semantics must stay bit-identical to the expressions these helpers replaced:
// default-off was `v === '1'`, default-on was `v !== '0'`.
describe('flagDefaultOff', () => {
  it('is false when unset', () => {
    expect(flagDefaultOff(undefined)).toBe(false);
  });

  it('is true only for the literal "1"', () => {
    expect(flagDefaultOff('1')).toBe(true);
    expect(flagDefaultOff('0')).toBe(false);
    expect(flagDefaultOff('')).toBe(false);
    expect(flagDefaultOff('true')).toBe(false);
    expect(flagDefaultOff('yes')).toBe(false);
    expect(flagDefaultOff(' 1')).toBe(false);
    expect(flagDefaultOff('01')).toBe(false);
  });
});

describe('flagDefaultOn', () => {
  it('is true when unset', () => {
    expect(flagDefaultOn(undefined)).toBe(true);
  });

  it('is false only for the literal "0"', () => {
    expect(flagDefaultOn('0')).toBe(false);
    expect(flagDefaultOn('1')).toBe(true);
    expect(flagDefaultOn('')).toBe(true);
    expect(flagDefaultOn('false')).toBe(true);
    expect(flagDefaultOn('no')).toBe(true);
    expect(flagDefaultOn(' 0')).toBe(true);
    expect(flagDefaultOn('00')).toBe(true);
  });
});
