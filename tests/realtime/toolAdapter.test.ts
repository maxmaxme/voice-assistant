import { describe, it, expect } from 'vitest';
import { mcpToolsToRealtime } from '../../src/realtime/toolAdapter.ts';

describe('mcpToolsToRealtime', () => {
  it('converts MCP tool to Realtime tool definition', () => {
    const mcp = [
      {
        name: 'HassTurnOn',
        description: 'Turn on an entity',
        inputSchema: {
          type: 'object',
          properties: { entity_id: { type: 'string' } },
          required: ['entity_id'],
        },
      },
    ];
    const out = mcpToolsToRealtime(mcp);
    expect(out).toEqual([
      {
        type: 'function',
        name: 'HassTurnOn',
        description: 'Turn on an entity',
        parameters: {
          type: 'object',
          properties: { entity_id: { type: 'string' } },
          required: ['entity_id'],
        },
      },
    ]);
  });

  it('skips tools with missing schema', () => {
    interface PartialTool {
      name: string;
    }
    const out = mcpToolsToRealtime([{ name: 'broken' } as PartialTool]);
    expect(out).toEqual([]);
  });
});
