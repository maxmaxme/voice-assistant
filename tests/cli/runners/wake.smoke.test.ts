import { describe, it, expect } from 'vitest';

describe('runners/wake', () => {
  it('exports runWakeMode as a function', async () => {
    const mod = await import('../../../src/cli/runners/wake.ts');
    expect(typeof mod.runWakeMode).toBe('function');
  });
});
