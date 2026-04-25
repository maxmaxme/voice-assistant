import { describe, it, expect } from 'vitest';
import { buildMemoryTools, executeMemoryTool } from '../../src/agent/memoryTools.js';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.js';

describe('memoryTools', () => {
  it('exposes three function tools with sensible names', () => {
    const tools = buildMemoryTools();
    const names = tools.map((t) => t.function.name);
    expect(names).toEqual(['remember', 'recall', 'forget']);
  });

  it('executeMemoryTool routes calls', () => {
    const m = new SqliteProfileMemory({ dbPath: ':memory:' });
    try {
      executeMemoryTool(m, 'remember', { key: 'name', value: 'Maxim' });
      const out = executeMemoryTool(m, 'recall', {});
      expect(out).toEqual({ name: 'Maxim' });
      executeMemoryTool(m, 'forget', { key: 'name' });
      expect(executeMemoryTool(m, 'recall', {})).toEqual({});
    } finally {
      m.close();
    }
  });

  it('throws on unknown tool', () => {
    const m = new SqliteProfileMemory({ dbPath: ':memory:' });
    try {
      expect(() => executeMemoryTool(m, 'does_not_exist', {})).toThrow();
    } finally {
      m.close();
    }
  });
});
