import { describe, it, expect } from 'vitest';
import { constantTimeEquals, verifyBearerToken } from '../../src/utils/apiKeyAuth.ts';

describe('constantTimeEquals', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeEquals('hunter2', 'hunter2')).toBe(true);
  });

  it('returns false for different strings of equal length', () => {
    expect(constantTimeEquals('aaaaaaa', 'bbbbbbb')).toBe(false);
  });

  it('returns false for different lengths without throwing', () => {
    expect(constantTimeEquals('short', 'much-longer-string')).toBe(false);
    expect(constantTimeEquals('', 'x')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('handles non-ASCII characters byte-wise', () => {
    expect(constantTimeEquals('пароль', 'пароль')).toBe(true);
    expect(constantTimeEquals('пароль', 'парол!')).toBe(false);
  });
});

describe('verifyBearerToken', () => {
  it('accepts a Bearer token in the allow-list', () => {
    expect(verifyBearerToken('Bearer abc123', ['abc123'])).toBe(true);
  });

  it('accepts when the matching key is not first', () => {
    expect(verifyBearerToken('Bearer key-2', ['key-1', 'key-2', 'key-3'])).toBe(true);
  });

  it('rejects an unknown token', () => {
    expect(verifyBearerToken('Bearer nope', ['abc123'])).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyBearerToken(undefined, ['abc123'])).toBe(false);
    expect(verifyBearerToken('', ['abc123'])).toBe(false);
  });

  it('rejects a non-Bearer scheme', () => {
    expect(verifyBearerToken('Basic abc123', ['abc123'])).toBe(false);
    expect(verifyBearerToken('abc123', ['abc123'])).toBe(false);
  });

  it('rejects an empty token after Bearer', () => {
    expect(verifyBearerToken('Bearer ', ['abc123'])).toBe(false);
  });

  it('rejects when the allow-list is empty', () => {
    expect(verifyBearerToken('Bearer abc123', [])).toBe(false);
  });

  it('is case-sensitive on the scheme name', () => {
    // Conventional Bearer tokens are spelled exactly "Bearer".
    expect(verifyBearerToken('bearer abc123', ['abc123'])).toBe(false);
  });

  it('does not short-circuit — still rejects after a non-match prefix', () => {
    // Same prefix as the allowed key but different: must still be rejected.
    expect(verifyBearerToken('Bearer abc124', ['abc123'])).toBe(false);
  });
});
