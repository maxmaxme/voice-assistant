import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from '../../src/memory/schema.ts';
import type { Db } from '../../src/memory/db.ts';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface TestDb {
  sqlite: Database.Database;
  db: Db;
}

/** A fresh, migrated in-memory database for store unit tests. */
export function freshTestDb(): TestDb {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { sqlite, db };
}
