import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../../src/memory/schema.ts';
import type { Db } from '../../src/memory/db.ts';
import { IdentitiesStore, hashToken } from '../../src/memory/identities.ts';
import { SqlitePrompts } from '../../src/settings/sqlitePrompts.ts';
import { SqliteRuntimeState, CONFIG_LOADED_AT } from '../../src/settings/sqliteRuntimeState.ts';
// The web panel's Nitro DB utils (web/ is a separate app with its own
// toolchain, but the SAME SQLite file and the same implicit contract:
// sha256 token hashing, the empty-`content` prompt sentinel, the
// `config_loaded_at` runtime-state key). Nothing else ties the two apps
// together — this suite is the drift detector. Imported with runtime-built
// specifiers: the web app uses extensionless bundler-style imports that the
// core's nodenext tsc can't resolve, so a static import would fail
// `npm run typecheck`; vitest (vite resolution) loads them fine.
const webModule = (name: string): string =>
  new URL(`../../web/server/utils/db/${name}.ts`, import.meta.url).href;

interface WebUsers {
  createUser(name: string, isAdmin: boolean): number;
  addDevice(userId: number, channel: string, value: string): { token?: string };
  deleteUser(id: number): boolean;
  UserNotFoundError: new () => Error;
}
interface WebPrompts {
  getPrompt(name: string): { content: string; defaultContent: string } | null;
  setPrompt(name: string, content: string): void;
  resetPrompt(name: string): boolean;
}
interface WebRuntimeState {
  getConfigLoadedAt(): number | null;
}

const { createUser, addDevice, deleteUser, UserNotFoundError } = (await import(
  webModule('users')
)) as WebUsers;
const { setPrompt, resetPrompt, getPrompt } = (await import(webModule('prompts'))) as WebPrompts;
const { getConfigLoadedAt } = (await import(webModule('runtimeState'))) as WebRuntimeState;

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

// The web utils open their own connection (getDb caches it per process), so
// the shared DB must be a real file, not :memory:.
let dir: string;
let sqlite: Database.Database;
let db: Db;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'va-contract-'));
  const dbPath = join(dir, 'va.db');
  sqlite = new Database(dbPath);
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  process.env.VA_DB_PATH = dbPath;
});

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function identityCountFor(userId: number): number {
  return sqlite
    .prepare<[number], { n: number }>(`SELECT COUNT(*) AS n FROM identities WHERE user_id = ?`)
    .get(userId)!.n;
}

describe('web ↔ core DB contract', () => {
  it('a device token attached in the web panel authenticates against the core hash lookup', () => {
    const userId = createUser('contract-user', false);
    const identities = new IdentitiesStore(db);

    // Voice: the admin pastes the device's token into the web panel.
    addDevice(userId, 'voice', 'device-secret');
    expect(identities.resolve('voice', hashToken('device-secret'))).toMatchObject({ userId });

    // HTTP: the web panel mints the token and stores only the hash.
    const { token } = addDevice(userId, 'http', '');
    expect(token).toBeTruthy();
    expect(identities.resolve('http', hashToken(token!))).toMatchObject({ userId });
  });

  it('a telegram chat id added in the web panel resolves as-is (no hashing)', () => {
    const userId = createUser('tg-user', false);
    addDevice(userId, 'telegram', '424242');
    const identities = new IdentitiesStore(db);
    expect(identities.resolve('telegram', '424242')).toMatchObject({ userId });
  });

  it('the empty-content prompt sentinel round-trips between the web editor and core resolution', () => {
    const prompts = new SqlitePrompts(db);
    prompts.seedWithDefault('contract-prompt', 'DEFAULT TEXT');

    // Saving text that equals the default (modulo trailing whitespace) must
    // store the sentinel: core reports "not customized" and keeps following
    // the bundled default.
    setPrompt('contract-prompt', 'DEFAULT TEXT\n');
    expect(getPrompt('contract-prompt')!.content).toBe('');
    expect(prompts.get('contract-prompt')).toBeUndefined();

    // A real edit is what core serves.
    setPrompt('contract-prompt', 'CUSTOM TEXT');
    expect(prompts.get('contract-prompt')).toBe('CUSTOM TEXT');

    // Reset writes the sentinel back — core falls back to the default again.
    expect(resetPrompt('contract-prompt')).toBe(true);
    expect(prompts.get('contract-prompt')).toBeUndefined();
  });

  it('core seeding refreshes default_content without clobbering a web edit', () => {
    const prompts = new SqlitePrompts(db);
    prompts.seedWithDefault('contract-evolving', 'v1 default');
    setPrompt('contract-evolving', 'user edit');

    // Next process start re-seeds with a newer bundled default.
    prompts.seedWithDefault('contract-evolving', 'v2 default');
    const row = getPrompt('contract-evolving')!;
    expect(row.defaultContent).toBe('v2 default');
    expect(row.content).toBe('user edit');
    expect(prompts.get('contract-evolving')).toBe('user edit');
  });

  // The FK rejects the phantom row, but its SQLITE_CONSTRAINT_FOREIGNKEY code
  // must not be misread as a UNIQUE conflict ("already attached", 409) — the
  // panel needs a user-not-found error it can surface as 404.
  it('addDevice against a nonexistent user fails as user-not-found, not a bogus conflict', () => {
    const ghostId = 999_999;
    let err: unknown;
    try {
      addDevice(ghostId, 'voice', 'ghost-token');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UserNotFoundError);
    expect(identityCountFor(ghostId)).toBe(0);
  });

  it('deleteUser still removes a user with attached devices under FK enforcement', () => {
    const userId = createUser('doomed-user', false);
    addDevice(userId, 'voice', 'doomed-token');
    expect(deleteUser(userId)).toBe(true);
    expect(identityCountFor(userId)).toBe(0);
  });

  it('the config-drift timestamp written by core is what the web status endpoint reads', () => {
    new SqliteRuntimeState(db).set(CONFIG_LOADED_AT, '1234567');
    expect(getConfigLoadedAt()).toBe(1234567);
  });
});
