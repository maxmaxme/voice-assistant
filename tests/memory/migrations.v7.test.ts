import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';

describe('migration v7', () => {
  it('adds owner to profile and backfills existing rows to household', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
             CREATE TABLE profile (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE scheduled_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, goal TEXT NOT NULL, schedule_kind TEXT NOT NULL, schedule_expr TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', next_fire_at INTEGER NOT NULL, last_fired_at INTEGER, created_at INTEGER NOT NULL);
             INSERT INTO schema_version (version) VALUES (1),(2),(3),(4),(5),(6);
             INSERT INTO profile (key, value, updated_at) VALUES ('name', '"Max"', 1);`);
    runMigrations(db);
    const row = db.prepare(`SELECT owner, key, value FROM profile WHERE key='name'`).get() as {
      owner: string;
      key: string;
      value: string;
    };
    expect(row.owner).toBe('household');
    expect(JSON.parse(row.value)).toBe('Max');
  });

  it('creates users and identities with the documented shape', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const userCols = db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
    const idCols = db.prepare(`PRAGMA table_info(identities)`).all() as { name: string }[];
    // v8 (run as part of the full chain here) drops the role column; v12 adds is_admin.
    expect(userCols.map((c) => c.name).sort()).toEqual(['created_at', 'id', 'is_admin', 'name']);
    expect(idCols.map((c) => c.name).sort()).toEqual([
      'channel',
      'created_at',
      'id',
      'identity',
      'last_used_at', // added in v11 (run as part of the full chain here)
      'user_id',
    ]);
    db.prepare(`INSERT INTO users (name, created_at) VALUES ('home',1)`).run();
    db.prepare(
      `INSERT INTO identities (channel, identity, user_id, created_at) VALUES ('voice','h1',1,1)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO identities (channel, identity, user_id, created_at) VALUES ('voice','h1',1,1)`,
        )
        .run(),
    ).toThrow();
  });

  it('composite PK on (owner, key) allows same key in two scopes', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO profile (owner, key, value, updated_at) VALUES ('household','x','1',1)`,
    ).run();
    db.prepare(
      `INSERT INTO profile (owner, key, value, updated_at) VALUES ('user:1','x','2',1)`,
    ).run();
    const n = db.prepare(`SELECT COUNT(*) AS n FROM profile WHERE key='x'`).get() as { n: number };
    expect(n.n).toBe(2);
  });
});
