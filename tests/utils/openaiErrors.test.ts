import { describe, expect, it } from 'vitest';
import { isPreviousResponseGoneError } from '../../src/utils/openaiErrors.ts';

describe('isPreviousResponseGoneError', () => {
  it('matches an APIError-shaped object with status 404', () => {
    const err = {
      status: 404,
      message: 'Previous response with id resp_123 not found',
    };
    expect(isPreviousResponseGoneError(err)).toBe(true);
  });

  it('matches a generic Error whose message mentions the same', () => {
    const err = new Error('Previous response with id resp_xyz not found');
    expect(isPreviousResponseGoneError(err)).toBe(true);
  });

  it('matches case-insensitively', () => {
    const err = new Error('previous RESPONSE foobar NOT found');
    expect(isPreviousResponseGoneError(err)).toBe(true);
  });

  it('rejects non-404 statuses even when the message matches', () => {
    expect(
      isPreviousResponseGoneError({
        status: 500,
        message: 'Previous response with id x not found',
      }),
    ).toBe(false);
  });

  it('rejects unrelated error messages', () => {
    expect(isPreviousResponseGoneError(new Error('rate limited'))).toBe(false);
    expect(isPreviousResponseGoneError(new Error('previous response is stale'))).toBe(false);
    expect(isPreviousResponseGoneError(new Error('user not found'))).toBe(false);
  });

  it('rejects null, undefined, and primitives', () => {
    expect(isPreviousResponseGoneError(null)).toBe(false);
    expect(isPreviousResponseGoneError(undefined)).toBe(false);
    expect(isPreviousResponseGoneError('Previous response not found')).toBe(false);
    expect(isPreviousResponseGoneError(404)).toBe(false);
  });

  it('rejects objects without a string message', () => {
    expect(isPreviousResponseGoneError({})).toBe(false);
    expect(isPreviousResponseGoneError({ message: 42 })).toBe(false);
  });
});
