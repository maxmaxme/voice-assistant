import type { MemoryAdapter } from '../memory/types.ts';
import type { OpenAiFunctionTool } from './toolBridge.ts';

export const MEMORY_TOOL_NAMES = new Set(['remember', 'recall', 'forget']);

export function buildMemoryTools(): OpenAiFunctionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'remember',
        description:
          'Persist a fact about the user across sessions. Call when the user shares a preference or fact you should remember.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Short snake_case identifier, e.g. "name", "comfort_temp"' },
            value: { description: 'Any JSON-serializable value' },
          },
          required: ['key', 'value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recall',
        description: 'Read user profile. Omit "key" to get the full profile.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'forget',
        description: 'Delete a profile entry by key.',
        parameters: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
        },
      },
    },
  ];
}

export function executeMemoryTool(
  memory: MemoryAdapter,
  name: string,
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case 'remember':
      memory.remember(String(args.key), args.value);
      return { ok: true };
    case 'recall':
      return memory.recall(args.key as string | undefined);
    case 'forget':
      memory.forget(String(args.key));
      return { ok: true };
    default:
      throw new Error(`Unknown memory tool: ${name}`);
  }
}
