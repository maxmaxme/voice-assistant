import { describe, it, expect } from 'vitest';
import { buildMemoryTools, executeMemoryTool } from '../../src/agent/memoryTools.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';
import { freshTestDb } from '../memory/helpers.ts';

describe('memoryTools', () => {
  it('exposes three function tools with sensible names', () => {
    const tools = buildMemoryTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(['remember', 'recall', 'forget']);
  });

  it('executeMemoryTool routes calls', () => {
    const { db } = freshTestDb();
    const m = new SqliteProfileMemory(db);
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
    const { db } = freshTestDb();
    const m = new SqliteProfileMemory(db);
    try {
      expect(() => executeMemoryTool(m, 'does_not_exist', {})).toThrow();
    } finally {
      m.close();
    }
  });
});
