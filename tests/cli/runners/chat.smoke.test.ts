import { describe, it, expect } from 'vitest';

describe('runners/chat', () => {
  it('exports runChatMode as a function', async () => {
    const mod = await import('../../../src/cli/runners/chat.ts');
    expect(typeof mod.runChatMode).toBe('function');
  });
});
