import { describe, it, expect, vi } from 'vitest';
import { executeRoutedTool } from '../../src/agent/toolExecutor.ts';
import { buildLocalToolset } from '../../src/agent/localTools.ts';
import type { McpClient } from '../../src/mcp/types.ts';

function fakeMcp(overrides: Partial<McpClient> = {}): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'ha says ok' }],
    }),
    ...overrides,
  };
}

describe('executeRoutedTool', () => {
  it('routes a local-registry tool to the toolset, never MCP', async () => {
    const toolset = buildLocalToolset(); // registry with the always-on tools
    const mcp = fakeMcp();
    const res = await executeRoutedTool(toolset, mcp, 'get_current_time', {});
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toHaveProperty('iso');
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it('reports a local tool throw as isError with the message as text', async () => {
    const toolset = buildLocalToolset();
    const boom = {
      ...toolset,
      execute: vi.fn().mockRejectedValue(new Error('adapter down')),
    };
    const res = await executeRoutedTool(boom, fakeMcp(), 'get_current_time', {});
    expect(res).toEqual({ text: 'adapter down', isError: true });
  });

  it('routes unknown names to MCP and extracts the text content', async () => {
    const toolset = buildLocalToolset();
    const mcp = fakeMcp();
    const res = await executeRoutedTool(toolset, mcp, 'HassTurnOn', { name: 'Lamp' });
    expect(mcp.callTool).toHaveBeenCalledWith('HassTurnOn', { name: 'Lamp' });
    expect(res).toEqual({ text: 'ha says ok', isError: false });
  });

  it('propagates the MCP isError flag', async () => {
    const mcp = fakeMcp({
      callTool: vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'MatchFailedError' }],
      }),
    });
    const res = await executeRoutedTool(buildLocalToolset(), mcp, 'HassTurnOn', {});
    expect(res).toEqual({ text: 'MatchFailedError', isError: true });
  });

  it('turns an MCP throw or invalid content into isError', async () => {
    const thrown = await executeRoutedTool(
      buildLocalToolset(),
      fakeMcp({ callTool: vi.fn().mockRejectedValue(new Error('HA unreachable')) }),
      'HassTurnOn',
      {},
    );
    expect(thrown).toEqual({ text: 'HA unreachable', isError: true });

    const invalid = await executeRoutedTool(
      buildLocalToolset(),
      fakeMcp({ callTool: vi.fn().mockResolvedValue({ content: 'nope' }) }),
      'HassTurnOn',
      {},
    );
    expect(invalid).toEqual({ text: 'Invalid content', isError: true });
  });
});
