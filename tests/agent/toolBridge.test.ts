import { describe, it, expect } from 'vitest';
import { mcpToolsToOpenAi } from '../../src/agent/toolBridge.ts';
import type { McpTool } from '../../src/mcp/types.ts';

describe('mcpToolsToOpenAi', () => {
  it('maps name, description, and inputSchema to OpenAI function format', () => {
    const mcp: McpTool[] = [
      {
        name: 'SomeUnrelatedTool',
        description: 'Does something',
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
        name: 'SomeUnrelatedTool',
        description: 'Does something',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        strict: false,
      },
    ]);
  });

  it('appends a behavioural suffix to known HA tool names', () => {
    const mcp: McpTool[] = [
      {
        name: 'HassClimateSetTemperature',
        description: 'Set target temperature',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
    ];
    const [out] = mcpToolsToOpenAi(mcp);
    expect(out!.description.startsWith('Set target temperature')).toBe(true);
    expect(out!.description).toMatch(/IR-controlled/);
  });

  it('handles empty list', () => {
    expect(mcpToolsToOpenAi([])).toEqual([]);
  });
});
