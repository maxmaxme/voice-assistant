import { eq } from 'drizzle-orm';
import type { Db } from '../memory/db.ts';
import { integrations } from '../memory/schema.ts';

/** Read-only access to configured integrations. The web panel owns writes
 *  (raw SQL); the agent only reads to decide what to wire up at startup. */
export interface IntegrationRow {
  config: Record<string, string>;
  enabled: boolean;
}

export class SqliteIntegrations {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Installed integration's parsed config + enabled flag, or null if absent /
   *  config corrupt. */
  get(type: string): IntegrationRow | null {
    const row = this.db
      .select({ config: integrations.config, enabled: integrations.enabled })
      .from(integrations)
      .where(eq(integrations.type, type))
      .get();
    if (!row) {
      return null;
    }
    try {
      return { config: JSON.parse(row.config), enabled: row.enabled === 1 };
    } catch {
      return null;
    }
  }
}
