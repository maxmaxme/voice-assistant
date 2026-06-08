import { describe, it, expect } from 'vitest';
import { buildMemoryTools, executeMemoryTool } from '../../src/agent/memoryTools.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';
import { makeScopedProfile, HOUSEHOLD_OWNER } from '../../src/memory/scope.ts';
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
    const p = makeScopedProfile(m, { userId: 1 });
    try {
      executeMemoryTool(p, 'remember', { key: 'name', value: 'Maxim' });
      const out = executeMemoryTool(p, 'recall', {});
      expect(out).toEqual({ name: 'Maxim' });
      executeMemoryTool(p, 'forget', { key: 'name' });
      expect(executeMemoryTool(p, 'recall', {})).toEqual({});
    } finally {
      m.close();
    }
  });

  it('forget reports the scope it deleted from and whether a value was revealed', () => {
    const { db } = freshTestDb();
    const m = new SqliteProfileMemory(db);
    const p = makeScopedProfile(m, { userId: 1 });
    try {
      m.rememberFor(HOUSEHOLD_OWNER, 'alias', 'Кондиционер');
      executeMemoryTool(p, 'remember', { key: 'alias', value: 'сплит' });

      // personal copy removed, shared value surfaces again
      expect(executeMemoryTool(p, 'forget', { key: 'alias' })).toEqual({
        ok: true,
        deleted: true,
        scope: 'personal',
        revealed: true,
      });

      // now only the shared copy is left; deleting it affects everyone
      expect(executeMemoryTool(p, 'forget', { key: 'alias' })).toEqual({
        ok: true,
        deleted: true,
        scope: 'household',
      });

      // nothing left to delete
      expect(executeMemoryTool(p, 'forget', { key: 'alias' })).toEqual({
        ok: false,
        deleted: false,
      });
    } finally {
      m.close();
    }
  });

  it('throws on unknown tool', () => {
    const { db } = freshTestDb();
    const m = new SqliteProfileMemory(db);
    const p = makeScopedProfile(m, { userId: 1 });
    try {
      expect(() => executeMemoryTool(p, 'does_not_exist', {})).toThrow();
    } finally {
      m.close();
    }
  });
});
