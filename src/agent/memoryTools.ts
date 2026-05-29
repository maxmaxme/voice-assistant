import type { ScopedProfile, WriteScope } from '../memory/scope.ts';
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
          scope: {
            type: 'string',
            enum: ['personal', 'household'],
            description:
              'Who the fact is about. "personal" (default) = only this user. ' +
              '"household" = shared with everyone on the speaker. Only set ' +
              '"household" when the user clearly means a shared fact; if ' +
              'unsure, ask first.',
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
  profile: ScopedProfile,
  name: string,
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case 'remember': {
      const scope: WriteScope | undefined = args.scope === 'household' ? 'household' : undefined;
      profile.remember(String(args.key), args.value, scope);
      return { ok: true };
    }
    case 'recall': {
      const key = args.key;
      return profile.recall(typeof key === 'string' ? key : undefined);
    }
    case 'forget':
      profile.forget(String(args.key));
      return { ok: true };
    default:
      throw new Error(`Unknown memory tool: ${name}`);
  }
}
