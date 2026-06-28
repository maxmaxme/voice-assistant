import { eq } from 'drizzle-orm';
import type { Db } from '../memory/db.ts';
import { prompts } from '../memory/schema.ts';

export interface StoredPrompt {
  name: string;
  content: string;
  updatedAt: number;
}

/** DB-backed store for editable prompt text. The bundled `.md` files remain
 *  the source of truth on a fresh DB — `seedIfAbsent` copies them in on
 *  startup; thereafter the row wins and is what the web UI edits. */
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
      .select({ name: prompts.name, content: prompts.content, updatedAt: prompts.updatedAt })
      .from(prompts)
      .all();
  }

  set(name: string, content: string): void {
    const now = Date.now();
    this.db
      .insert(prompts)
      .values({ name, content, updatedAt: now })
      .onConflictDoUpdate({ target: prompts.name, set: { content, updatedAt: now } })
      .run();
  }

  seedIfAbsent(name: string, content: string): void {
    const now = Date.now();
    this.db
      .insert(prompts)
      .values({ name, content, updatedAt: now })
      .onConflictDoNothing({ target: prompts.name })
      .run();
  }
}
