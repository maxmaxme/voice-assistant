import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';

describe('migration v11 — identities.last_used_at', () => {
  it('adds the last_used_at column to identities', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = (db.prepare(`PRAGMA table_info(identities)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('last_used_at');
  });

  it('pre-existing rows get NULL last_used_at (no backfill)', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const uid = Number(
      db.prepare(`INSERT INTO users (name, created_at) VALUES ('me', 1)`).run().lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO identities (channel, identity, user_id, created_at) VALUES ('telegram','5',?,1)`,
    ).run(uid);
    const row = db
      .prepare<[], { last_used_at: number | null }>(`SELECT last_used_at FROM identities`)
      .get();
    expect(row?.last_used_at).toBeNull();
  });

  it('is idempotent across a repeated open', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const cols = (db.prepare(`PRAGMA table_info(identities)`).all() as { name: string }[]).filter(
      (c) => c.name === 'last_used_at',
    );
    expect(cols).toHaveLength(1);
  });
});
