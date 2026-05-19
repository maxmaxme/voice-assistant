import type { MemoryAdapter } from '../memory/types.ts';
import { loadPrompt } from './prompts/load.ts';
import type { OpenAiFunctionTool } from './toolBridge.ts';

export const MEMORY_TOOL_NAMES = new Set(['remember', 'recall', 'forget']);

const REMEMBER_DESCRIPTION = loadPrompt('./prompts/tools/remember.md', import.meta.url);
const RECALL_DESCRIPTION = loadPrompt('./prompts/tools/recall.md', import.meta.url);
const FORGET_DESCRIPTION = loadPrompt('./prompts/tools/forget.md', import.meta.url);

export function buildMemoryTools(): OpenAiFunctionTool[] {
  return [
    {
      type: 'function',
      name: 'remember',
      description: REMEMBER_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Short snake_case identifier, e.g. "name", "comfort_temp"',
          },
          value: {
            type: ['string', 'number', 'boolean'],
            description:
              'The value to store. Use a string for free-form facts, ' +
              'numbers for measurements, booleans for flags.',
          },
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'recall',
      description: RECALL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: ['string', 'null'],
            description: 'Specific key to read, or null for the full profile.',
          },
        },
        required: ['key'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'forget',
      description: FORGET_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
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
    case 'recall': {
      const key = args.key;
      return memory.recall(typeof key === 'string' ? key : undefined);
    }
    case 'forget':
      memory.forget(String(args.key));
      return { ok: true };
    default:
      throw new Error(`Unknown memory tool: ${name}`);
  }
}
