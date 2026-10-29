import { describe, it, expect, vi } from 'vitest';
import { MultiMcpClient } from '../../src/mcp/multiMcpClient.ts';
import type { McpClient, McpTool } from '../../src/mcp/types.ts';

function fake(tools: McpTool[] | Error): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools:
      tools instanceof Error ? vi.fn().mockRejectedValue(tools) : vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}
const tool = (name: string): McpTool => ({ name, inputSchema: { type: 'object' } });

describe('MultiMcpClient', () => {
  it('prefixes extra tools, drops hidden/invalid ones and routes calls back', async () => {
    const ha = fake([tool('HassTurnOn')]);
    const zen = fake([tool('list_accounts'), tool('delete_transactions'), tool('bad.name')]);
    const multi = new MultiMcpClient(ha, [
      { name: 'zen', client: zen, tools: new Set(['delete_transactions']), only: false },
    ]);

    const names = (await multi.listTools()).map((t) => t.name);
    expect(names).toEqual(['HassTurnOn', 'zen__list_accounts']);

    await multi.callTool('zen__list_accounts', { x: 1 });
    expect(zen.callTool).toHaveBeenCalledWith('list_accounts', { x: 1 });
    await multi.callTool('HassTurnOn', {});
    expect(ha.callTool).toHaveBeenCalledWith('HassTurnOn', {});
  });

  it('exposes only the listed tools in only-mode', async () => {
    const zen = fake([tool('list_accounts'), tool('delete_transactions')]);
    const multi = new MultiMcpClient(fake([]), [
      { name: 'zen', client: zen, tools: new Set(['list_accounts']), only: true },
    ]);
    expect((await multi.listTools()).map((t) => t.name)).toEqual(['zen__list_accounts']);
  });

  it('skips a failing extra server but surfaces primary errors', async () => {
    const ok = new MultiMcpClient(fake([tool('HassTurnOn')]), [
      { name: 'down', client: fake(new Error('boom')), tools: new Set(), only: false },
    ]);
    expect((await ok.listTools()).map((t) => t.name)).toEqual(['HassTurnOn']);

    const broken = new MultiMcpClient(fake(new Error('ha down')), []);
    await expect(broken.listTools()).rejects.toThrow('ha down');
  });
});
