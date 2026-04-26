import { describe, expect, it } from 'vitest';
import { isValidContent } from '../../src/utils/mcpContent.ts';

describe('isValidContent', () => {
  it('accepts an empty array', () => {
    expect(isValidContent([])).toBe(true);
  });

  it('accepts text parts', () => {
    expect(isValidContent([{ type: 'text', text: 'hello' }])).toBe(true);
  });

  it('accepts mixed parts as long as type is a string', () => {
    expect(
      isValidContent([
        { type: 'text', text: 'a' },
        { type: 'image', url: 'https://example.com/x.png' },
        { type: 'resource' },
      ]),
    ).toBe(true);
  });

  it('accepts a part where text is omitted', () => {
    expect(isValidContent([{ type: 'image' }])).toBe(true);
  });

  it('rejects non-array values', () => {
    expect(isValidContent(null)).toBe(false);
    expect(isValidContent(undefined)).toBe(false);
    expect(isValidContent('text')).toBe(false);
    expect(isValidContent({ type: 'text', text: 'x' })).toBe(false);
    expect(isValidContent(42)).toBe(false);
  });

  it('rejects null or non-object parts', () => {
    expect(isValidContent([null])).toBe(false);
    expect(isValidContent(['text'])).toBe(false);
    expect(isValidContent([42])).toBe(false);
  });

  it('rejects parts missing `type`', () => {
    expect(isValidContent([{ text: 'hello' }])).toBe(false);
  });

  it('rejects parts where `type` is not a string', () => {
    expect(isValidContent([{ type: 1 }])).toBe(false);
    expect(isValidContent([{ type: null }])).toBe(false);
  });

  it('rejects parts where `text` is present but not a string', () => {
    expect(isValidContent([{ type: 'text', text: 42 }])).toBe(false);
    expect(isValidContent([{ type: 'text', text: null }])).toBe(false);
  });

  it('treats explicit text: undefined as valid (key present, value undefined)', () => {
    expect(isValidContent([{ type: 'text', text: undefined }])).toBe(true);
  });
});
