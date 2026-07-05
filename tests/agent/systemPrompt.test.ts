import { describe, it, expect } from 'vitest';
import { appendUserContext } from '../../src/agent/systemPrompt.ts';

describe('appendUserContext', () => {
  it('returns the base prompt unchanged when the profile is empty', () => {
    expect(appendUserContext('base prompt', {})).toBe('base prompt');
  });

  it('appends the profile facts as a JSON block', () => {
    const out = appendUserContext('base prompt', { name: 'Max', comfort_temp: '22' });
    expect(out).toBe('base prompt\n\nKnown user profile: {"name":"Max","comfort_temp":"22"}');
  });
});
