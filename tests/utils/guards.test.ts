import { describe, it, expect } from 'vitest';
import { isNumberArray, isRecord, isStringArray } from '../../src/utils/guards.ts';

describe('guards', () => {
  it('isRecord accepts plain objects and rejects null / arrays / primitives', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('isStringArray / isNumberArray require every element to match', () => {
    expect(isStringArray(['a', 'b'])).toBe(true);
    expect(isStringArray(['a', 1])).toBe(false);
    expect(isNumberArray([1, 2])).toBe(true);
    expect(isNumberArray([1, '2'])).toBe(false);
    expect(isStringArray([])).toBe(true);
    expect(isStringArray('ab')).toBe(false);
  });
});
