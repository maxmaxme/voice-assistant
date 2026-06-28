import type { SqliteIntegrations } from './sqliteIntegrations.ts';

/** Matches the integration `type` key in the web catalog
 *  (`web/server/utils/integrations.ts`). */
export const HA_INTEGRATION_TYPE = 'home-assistant';

export interface HaConfig {
  url: string;
  token: string;
}

/** The configured Home Assistant connection, or null when the integration is
 *  not installed, **disabled**, or missing url/token. Null = HA stays off: no
 *  MCP client, no HA tools. */
export function resolveHaConfig(store: SqliteIntegrations): HaConfig | null {
  const row = store.get(HA_INTEGRATION_TYPE);
  if (!row || !row.enabled) {
    return null;
  }
  const url = (row.config.url ?? '').trim();
  const token = (row.config.token ?? '').trim();
  if (!url || !token) {
    return null;
  }
  return { url, token };
}
