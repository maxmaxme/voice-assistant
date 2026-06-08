import { describe, it, expect } from 'vitest';
import { buildMemoryTools, executeMemoryTool } from '../../src/agent/memoryTools.ts';
import type { ScopedProfile } from '../../src/memory/scope.ts';

function fakeScoped(): ScopedProfile & { writes: Array<[string, unknown, string | undefined]> } {
  const store = new Map<string, unknown>();
  const writes: Array<[string, unknown, string | undefined]> = [];
  return {
    writes,
    recall: (key) => (key ? { [key]: store.get(key) } : Object.fromEntries(store)),
    remember: (key, value, scope) => {
      writes.push([key, value, scope]);
      store.set(key, value);
    },
    forget: (key) => {
      const deleted = store.delete(key);
      return deleted ? { deleted: true, scope: 'personal' } : { deleted: false };
    },
  };
}

describe('memory tools with scope', () => {
  it('remember tool schema exposes an optional scope enum', () => {
    const remember = buildMemoryTools().find((t) => t.name === 'remember')!;
    const props = remember.parameters.properties as Record<string, { enum?: string[] }>;
    expect(props.scope?.enum).toEqual(['personal', 'household']);
    expect(remember.parameters.required as string[]).toEqual(['key', 'value']);
  });

  it('passes scope through to the scoped profile', () => {
    const p = fakeScoped();
    executeMemoryTool(p, 'remember', { key: 'quiet', value: '22-7', scope: 'household' });
    expect(p.writes).toEqual([['quiet', '22-7', 'household']]);
  });

  it('omits scope when not provided', () => {
    const p = fakeScoped();
    executeMemoryTool(p, 'remember', { key: 'snack', value: 'olives' });
    expect(p.writes).toEqual([['snack', 'olives', undefined]]);
  });
});
