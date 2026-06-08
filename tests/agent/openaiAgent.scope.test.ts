import { describe, it, expect } from 'vitest';
import type { OpenAiAgent } from '../../src/agent/openaiAgent.ts';

describe('OpenAiAgent scope option', () => {
  it('respond accepts a per-call ScopedProfile in its options type', () => {
    type RespondArg = Parameters<OpenAiAgent['respond']>[1];
    const opt: RespondArg = {
      profile: {
        recall: () => ({}),
        remember: () => {},
        forget: () => ({ deleted: false }),
      },
    };
    expect(opt?.profile).toBeDefined();
  });
});
