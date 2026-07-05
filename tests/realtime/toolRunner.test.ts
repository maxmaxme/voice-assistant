import { describe, it, expect, vi } from 'vitest';
import { buildRealtimeToolRunner } from '../../src/realtime/toolRunner.ts';
import { ToolResultCache } from '../../src/realtime/toolCache.ts';
import { buildLocalToolset } from '../../src/agent/localTools.ts';
import type { McpClient } from '../../src/mcp/types.ts';

function fakeMcp(overrides: Partial<McpClient> = {}): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'live context' }],
    }),
    ...overrides,
  };
}

function makeRunner(mcp: McpClient, cache = new ToolResultCache()) {
  return buildRealtimeToolRunner({
    localToolset: buildLocalToolset(),
    mcp,
    cache,
    cacheTtlMs: 5_000,
  });
}

describe('buildRealtimeToolRunner', () => {
  it('executes local-registry tools in-process', async () => {
    const mcp = fakeMcp();
    const run = makeRunner(mcp);
    const out = await run('get_current_time', {});
    expect(JSON.parse(out)).toHaveProperty('iso');
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it('wraps failures as {"error"} JSON instead of throwing', async () => {
    const run = makeRunner(
      fakeMcp({ callTool: vi.fn().mockRejectedValue(new Error('HA unreachable')) }),
    );
    const out = await run('HassTurnOn', { name: 'Lamp' });
    expect(JSON.parse(out)).toEqual({ error: 'HA unreachable' });
  });

  it('tolerates non-object args (the model can emit malformed JSON)', async () => {
    const mcp = fakeMcp();
    const run = makeRunner(mcp);
    await run('HassTurnOn', 'not-json');
    expect(mcp.callTool).toHaveBeenCalledWith('HassTurnOn', {});
  });

  it('caches GetLiveContext within the TTL', async () => {
    const mcp = fakeMcp();
    const run = makeRunner(mcp);
    const first = await run('GetLiveContext', {});
    const second = await run('GetLiveContext', {});
    expect(second).toBe(first);
    expect(mcp.callTool).toHaveBeenCalledTimes(1);
  });

  it('a mutating MCP tool clears the cache; a local tool does not', async () => {
    const mcp = fakeMcp();
    const cache = new ToolResultCache();
    const run = makeRunner(mcp, cache);

    await run('GetLiveContext', {});
    // Local tools can't mutate HA state — the snapshot stays valid.
    await run('get_current_time', {});
    await run('GetLiveContext', {});
    expect(mcp.callTool).toHaveBeenCalledTimes(1);

    // HassTurnOn may have changed what GetLiveContext reports — drop it.
    await run('HassTurnOn', { name: 'Lamp' });
    await run('GetLiveContext', {});
    expect(mcp.callTool).toHaveBeenCalledTimes(3);
  });
});
