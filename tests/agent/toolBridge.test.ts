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

  it('marks the todo slots required and copies the list names onto `name`', () => {
    const mcp: McpTool[] = [
      {
        name: 'todo_get_items',
        inputSchema: {
          type: 'object',
          properties: { todo_list: { type: 'string', enum: ['Groceries', 'Tasks'] } },
        },
      },
      {
        name: 'HassListAddItem',
        description: 'Add item to a todo list',
        inputSchema: {
          type: 'object',
          properties: { item: { type: 'string' }, name: { type: 'string' } },
        },
      },
    ];
    const add = mcpToolsToOpenAi(mcp).find((t) => t.name === 'HassListAddItem')!;
    expect(add.parameters.required).toEqual(['name', 'item']);
    const props = add.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.name!.enum).toEqual(['Groceries', 'Tasks']);
    expect(props.name!.description).toMatch(/to-do list/);
  });

  it('leaves the todo schema alone when HA advertises no list names', () => {
    const mcp: McpTool[] = [
      {
        name: 'HassListRemoveItem',
        inputSchema: {
          type: 'object',
          properties: { item: { type: 'string' }, name: { type: 'string' } },
        },
      },
    ];
    const [out] = mcpToolsToOpenAi(mcp);
    const props = out!.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.name!.enum).toBeUndefined();
    expect(out!.parameters.required).toEqual(['name', 'item']);
  });

  it('keeps a `required` slot HA declared itself instead of overwriting it', () => {
    const mcp: McpTool[] = [
      {
        name: 'HassListAddItem',
        inputSchema: {
          type: 'object',
          properties: {
            item: { type: 'string' },
            name: { type: 'string' },
            due_date: { type: 'string' },
          },
          required: ['due_date', 'item'],
        },
      },
    ];
    const [out] = mcpToolsToOpenAi(mcp);
    expect(out!.parameters.required).toEqual(['due_date', 'item', 'name']);
  });

  it('leaves the tool untouched when the todo schema no longer has {name, item}', () => {
    const mcp: McpTool[] = [
      {
        name: 'HassListCompleteItem',
        description: 'Complete item on a todo list',
        inputSchema: {
          type: 'object',
          properties: { item: { type: 'string' }, todo_list: { type: 'string' } },
        },
      },
    ];
    const [out] = mcpToolsToOpenAi(mcp);
    expect(out!.parameters).toEqual({
      type: 'object',
      properties: { item: { type: 'string' }, todo_list: { type: 'string' } },
    });
  });

  it('handles empty list', () => {
    expect(mcpToolsToOpenAi([])).toEqual([]);
  });
});
