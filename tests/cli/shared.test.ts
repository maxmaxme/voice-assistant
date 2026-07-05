import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSystemPromptFor, withCachedToolList } from '../../src/cli/shared.ts';
import type { McpClient, McpTool } from '../../src/mcp/types.ts';

describe('buildSystemPromptFor', () => {
  it('telegram and http produce the same prompt (both plain text channels)', () => {
    expect(buildSystemPromptFor('telegram')).toBe(buildSystemPromptFor('http'));
  });

  it('does NOT include any structured-output format addendum (plain text replies)', () => {
    expect(buildSystemPromptFor('telegram')).not.toContain('OUTPUT FORMAT');
    expect(buildSystemPromptFor('assist')).not.toContain('OUTPUT FORMAT');
  });

  it('assist channel includes the voice addendum (TTS-friendly output)', () => {
    const prompt = buildSystemPromptFor('assist');
    expect(prompt).toContain('Voice channel');
    expect(prompt).toContain('HARD RULE — TTS-safe output');
  });

  it('telegram/http do NOT include the voice addendum', () => {
    expect(buildSystemPromptFor('telegram')).not.toContain('Voice channel');
    expect(buildSystemPromptFor('http')).not.toContain('Voice channel');
  });
});

describe('withCachedToolList', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeMcp(): McpClient & { listCalls: number; callCalls: number } {
    const tools: McpTool[] = [{ name: 'HassTurnOn', inputSchema: { type: 'object' } }];
    const client = {
      listCalls: 0,
      callCalls: 0,
      connect: async () => {},
      disconnect: async () => {},
      listTools: async (): Promise<McpTool[]> => {
        client.listCalls++;
        return tools;
      },
      callTool: async () => {
        client.callCalls++;
        return {};
      },
    };
    return client;
  }

  it('caches listTools within the TTL', async () => {
    const inner = fakeMcp();
    const cached = withCachedToolList(inner, 60_000);
    const first = await cached.listTools();
    const second = await cached.listTools();
    expect(inner.listCalls).toBe(1);
    expect(second).toEqual(first);
  });

  it('refetches listTools after the TTL expires', async () => {
    const inner = fakeMcp();
    const cached = withCachedToolList(inner, 60_000);
    await cached.listTools();
    vi.setSystemTime(Date.now() + 60_001);
    await cached.listTools();
    expect(inner.listCalls).toBe(2);
  });

  it('passes callTool through fresh every time', async () => {
    const inner = fakeMcp();
    const cached = withCachedToolList(inner, 60_000);
    await cached.callTool('HassTurnOn', {});
    await cached.callTool('HassTurnOn', {});
    expect(inner.callCalls).toBe(2);
  });
});
