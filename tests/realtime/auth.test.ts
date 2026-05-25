import { describe, it, expect } from 'vitest';
import { verifyBearer } from '../../src/realtime/auth.js';

describe('verifyBearer', () => {
  it('accepts correct token', () => {
    expect(verifyBearer('Bearer abc123', 'abc123')).toBe(true);
  });

  it('rejects wrong token', () => {
    expect(verifyBearer('Bearer wrong', 'abc123')).toBe(false);
  });

  it('rejects missing header', () => {
    expect(verifyBearer(undefined, 'abc123')).toBe(false);
  });

  it('rejects non-Bearer scheme', () => {
    expect(verifyBearer('Basic abc123', 'abc123')).toBe(false);
  });

  it('rejects empty expected token', () => {
    expect(verifyBearer('Bearer abc123', '')).toBe(false);
  });
});
