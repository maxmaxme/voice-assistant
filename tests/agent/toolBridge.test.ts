import { describe, it, expect } from 'vitest';
import { mcpToolsToOpenAi } from '../../src/agent/toolBridge.ts';
import type { McpTool } from '../../src/mcp/types.ts';

describe('mcpToolsToOpenAi', () => {
  it('maps name, description, and inputSchema to OpenAI function format', () => {
    const mcp: McpTool[] = [
      {
        name: 'HassTurnOn',
        description: 'Turn on a device',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
    ];
    const out = mcpToolsToOpenAi(mcp);
    expect(out).toEqual([
      {
        type: 'function',
        name: 'HassTurnOn',
        description: 'Turn on a device',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        strict: false,
      },
    ]);
  });

  it('handles empty list', () => {
    expect(mcpToolsToOpenAi([])).toEqual([]);
  });
});
