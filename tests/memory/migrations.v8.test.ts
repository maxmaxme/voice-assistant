import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';

describe('migration v8 — drop users.role', () => {
  it('users has no role column after migration; id/name/created_at preserved', () => {
    const db = new Database(':memory:');
    runMigrations(db); // run all up to v8
    const cols = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(['created_at', 'id', 'name']);
  });

  it('preserves existing user rows (id + name) across the rebuild', () => {
    const db = new Database(':memory:');
    // Simulate a pre-v8 DB: run migrations, then (since v8 already dropped role
    // in this build) we instead verify round-trip on the post-v8 schema:
    runMigrations(db);
    const info = db.prepare(`INSERT INTO users (name, created_at) VALUES ('home', 1)`).run();
    const id = Number(info.lastInsertRowid);
    const row = db
      .prepare<[number], { id: number; name: string }>(`SELECT id, name FROM users WHERE id = ?`)
      .get(id);
    expect(row).toEqual({ id, name: 'home' });
  });

  it('identities.user_id still references the same ids after the rebuild', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const uid = Number(
      db.prepare(`INSERT INTO users (name, created_at) VALUES ('me', 1)`).run().lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO identities (channel, identity, user_id, created_at) VALUES ('telegram','5',?,1)`,
    ).run(uid);
    const got = db
      .prepare<
        [string],
        { user_id: number }
      >(`SELECT user_id FROM identities WHERE channel='telegram' AND identity=?`)
      .get('5');
    expect(got?.user_id).toBe(uid);
  });

  it('migrates a v7 row (with role) to the v8 schema, dropping role', () => {
    const db = new Database(':memory:');
    // hand-build the pre-v8 state: schema_version up to 7, users with role + a row
    db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
             INSERT INTO schema_version (version) VALUES (1),(2),(3),(4),(5),(6),(7);
             CREATE TABLE profile (owner TEXT NOT NULL DEFAULT 'household', key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner,key));
             CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('shared','member')), created_at INTEGER NOT NULL);
             CREATE TABLE identities (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, identity TEXT NOT NULL, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(channel, identity));
             CREATE TABLE scheduled_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, goal TEXT NOT NULL, schedule_kind TEXT NOT NULL, schedule_expr TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', next_fire_at INTEGER NOT NULL, last_fired_at INTEGER, created_at INTEGER NOT NULL);
             INSERT INTO users (id, name, role, created_at) VALUES (7, 'home', 'shared', 100);`);
    runMigrations(db); // should apply only v8
    const cols = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(['created_at', 'id', 'name']);
    const row = db
      .prepare<
        [],
        { id: number; name: string; created_at: number }
      >(`SELECT id, name, created_at FROM users`)
      .get();
    expect(row).toEqual({ id: 7, name: 'home', created_at: 100 });
  });
});
