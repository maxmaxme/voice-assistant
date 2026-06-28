import { describe, it, expect } from 'vitest';
import { bearerToken } from '../../src/realtime/auth.ts';

describe('bearerToken', () => {
  it('extracts the token from a Bearer header', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
  });

  it('returns null for a non-Bearer scheme', () => {
    expect(bearerToken('Basic abc123')).toBeNull();
  });

  it('returns null when the header is missing', () => {
    expect(bearerToken(undefined)).toBeNull();
  });

  it('returns null for an empty token', () => {
    expect(bearerToken('Bearer ')).toBeNull();
  });
});
