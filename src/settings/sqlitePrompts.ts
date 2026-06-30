import { eq } from 'drizzle-orm';
import type { Db } from '../memory/db.ts';
import { prompts } from '../memory/schema.ts';

export interface StoredPrompt {
  name: string;
  content: string;
  defaultContent: string;
  updatedAt: number;
}

/** DB-backed store for editable prompt text. The bundled `.md` files are the
 *  source of truth for any prompt the user hasn't customized: `seedWithDefault`
 *  stores their text in `default_content` (refreshed every start) but leaves
 *  `content` empty, and an **empty `content` is the "not customized" sentinel** —
 *  `get` reports it as unset so reads fall back to the live bundled default.
 *  Only a non-empty `content` (a real edit) wins. This keeps un-edited prompts
 *  following the code instead of freezing a stale copy. */
export class SqlitePrompts {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(name: string): string | undefined {
    const row = this.db
      .select({ content: prompts.content })
      .from(prompts)
      .where(eq(prompts.name, name))
      .get();
    // Empty content means "not customized" — report unset so callers fall back
    // to the bundled code default (see resolvePrompt).
    return row?.content ? row.content : undefined;
  }

  list(): StoredPrompt[] {
    return this.db
      .select({
        name: prompts.name,
        content: prompts.content,
        defaultContent: prompts.defaultContent,
        updatedAt: prompts.updatedAt,
      })
      .from(prompts)
      .all();
  }

  set(name: string, content: string): void {
    const now = Date.now();
    this.db
      .insert(prompts)
      .values({ name, content, defaultContent: content, updatedAt: now })
      .onConflictDoUpdate({ target: prompts.name, set: { content, updatedAt: now } })
      .run();
  }

  seedIfAbsent(name: string, content: string): void {
    const now = Date.now();
    this.db
      .insert(prompts)
      .values({ name, content, defaultContent: content, updatedAt: now })
      .onConflictDoNothing({ target: prompts.name })
      .run();
  }

  /** Insert a fresh prompt with empty `content` (so reads fall back to the
   *  bundled code default) and the bundled text in `default_content`; or, if it
   *  already exists, refresh only `default_content` to the latest bundled value
   *  — never touching the user's `content`. */
  seedWithDefault(name: string, content: string): void {
    const now = Date.now();
    this.db
      .insert(prompts)
      .values({ name, content: '', defaultContent: content, updatedAt: now })
      .onConflictDoUpdate({ target: prompts.name, set: { defaultContent: content } })
      .run();
  }

  /** Clear `content` to the "not customized" sentinel so the prompt reads (and
   *  keeps following) the bundled code default. Returns false if no such row. */
  resetToDefault(name: string): boolean {
    const result = this.db
      .update(prompts)
      .set({ content: '', updatedAt: Date.now() })
      .where(eq(prompts.name, name))
      .run();
    return result.changes > 0;
  }
}
