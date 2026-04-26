import { describe, it, expect, vi } from 'vitest';
import { buildGoalRunner } from '../../src/scheduling/goalRunner.ts';
import type { Agent, AgentResponse } from '../../src/agent/types.ts';

function passingAgent(): Agent & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    respond: async (text: string): Promise<AgentResponse> => {
      calls.push(text);
      return { text: 'done', direction: null };
    },
  };
}

function throwingAgent(err: Error): Agent {
  return {
    respond: async () => {
      throw err;
    },
  };
}

describe('buildGoalRunner', () => {
  it('fires a goal by calling agent.respond with the goal text', async () => {
    const agent = passingAgent();
    const runner = buildGoalRunner({ agent });
    await expect(runner.fire('do something')).resolves.toBeUndefined();
    expect(agent.calls).toEqual(['do something']);
  });

  it('rethrows when agent.respond throws, preserving the original message', async () => {
    const runner = buildGoalRunner({ agent: throwingAgent(new Error('llm boom')) });
    await expect(runner.fire('break it')).rejects.toThrow(/llm boom/);
  });

  it('writes a one-line success summary to stderr', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const agent = passingAgent();
      const runner = buildGoalRunner({ agent });
      await runner.fire('greet the world');
      const messages = writeSpy.mock.calls.map((c) => String(c[0]));
      const summary = messages.find((m) => m.startsWith('[goalRunner]'));
      expect(summary).toBeDefined();
      expect(summary).toContain('greet the world');
      expect(summary).toContain('done');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
