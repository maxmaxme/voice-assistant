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
    const config = parseConfig(row.config);
    if (!config) {
      return null;
    }
    return { config, enabled: row.enabled === 1 };
  }
}

// The DB is also hand-edited via the sqlite-web CRUD UI. Consumers index the
// result and call string methods on the values (e.g. resolveOpenAiConfig's
// `(c.apiKey ?? '').trim()`), so anything that isn't a plain object is treated
// as corrupt and non-string values are dropped — otherwise a mangled row
// crash-loops the bootstrap.
function parseConfig(raw: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      config[key] = value;
    }
  }
  return config;
}
