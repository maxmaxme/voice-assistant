import { describe, it, expect } from 'vitest';
import { appendLanguage, appendUserContext } from '../../src/agent/systemPrompt.ts';

describe('appendUserContext', () => {
  it('returns the base prompt unchanged when the profile is empty', () => {
    expect(appendUserContext('base prompt', {})).toBe('base prompt');
  });

  it('appends the profile facts as a JSON block', () => {
    const out = appendUserContext('base prompt', { name: 'Max', comfort_temp: '22' });
    expect(out).toBe('base prompt\n\nKnown user profile: {"name":"Max","comfort_temp":"22"}');
  });
});

describe('appendLanguage', () => {
  it('returns the base prompt unchanged when no language is pinned', () => {
    expect(appendLanguage('base prompt', '')).toBe('base prompt');
  });

  it('names the language in English so the model gets a word, not a code', () => {
    expect(appendLanguage('base prompt', 'ru')).toContain('The user speaks Russian.');
  });

  it('falls back to the raw code for an unknown one', () => {
    expect(appendLanguage('base prompt', 'zz')).toContain('The user speaks zz.');
  });
});
