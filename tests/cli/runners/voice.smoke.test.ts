import { describe, it, expect } from 'vitest';

describe('runners/voice', () => {
  it('exports runVoiceMode as a function', async () => {
    const mod = await import('../../../src/cli/runners/voice.ts');
    expect(typeof mod.runVoiceMode).toBe('function');
  });
});
