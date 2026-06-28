import { eq, sql } from 'drizzle-orm';
import type { Db } from '../memory/db.ts';
import { prompts } from '../memory/schema.ts';

export interface StoredPrompt {
  name: string;
  content: string;
  defaultContent: string;
  updatedAt: number;
}

/** DB-backed store for editable prompt text. The bundled `.md` files remain
 *  the source of truth on a fresh DB — `seedWithDefault` copies them in on
 *  startup (and refreshes the stored default) without clobbering edits;
 *  thereafter `content` wins and is what the web UI edits. `default_content`
 *  lets the web reset to default without reading image files. */
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
    return row?.content;
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

  /** Insert a fresh prompt (content = default = bundled), or, if it already
   *  exists, refresh only `default_content` to the latest bundled value —
   *  never touching the user's `content`. */
  seedWithDefault(name: string, content: string): void {
    const now = Date.now();
    this.db
      .insert(prompts)
      .values({ name, content, defaultContent: content, updatedAt: now })
      .onConflictDoUpdate({ target: prompts.name, set: { defaultContent: content } })
      .run();
  }

  /** Restore `content` from the stored default. Returns false if no such row. */
  resetToDefault(name: string): boolean {
    const result = this.db
      .update(prompts)
      .set({ content: sql`${prompts.defaultContent}`, updatedAt: Date.now() })
      .where(eq(prompts.name, name))
      .run();
    return result.changes > 0;
  }
}
