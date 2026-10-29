import type { SqliteIntegrations } from './sqliteIntegrations.ts';

/** Row type prefix for user-added MCP servers: one `mcp:<name>` row per server.
 *  Matches the multi-instance `mcp` entry in the web catalog
 *  (`web/server/utils/integrations.ts`). */
export const CUSTOM_MCP_PREFIX = 'mcp:';

export interface CustomMcpConfig {
  /** Tool-name prefix: the server's tools reach the model as `<name>__<tool>`. */
  name: string;
  url: string;
  token?: string;
  /** Upstream (unprefixed) tool names the filter applies to. */
  tools: string[];
  /** true: expose only `tools`; false: expose everything except `tools`. */
  only: boolean;
}

/** Enabled custom MCP servers with a url; disabled / url-less rows are skipped. */
export function resolveCustomMcpConfigs(store: SqliteIntegrations): CustomMcpConfig[] {
  return store.listByPrefix(CUSTOM_MCP_PREFIX).flatMap((row) => {
    const url = (row.config.url ?? '').trim();
    if (!row.enabled || !url) {
      return [];
    }
    const token = (row.config.token ?? '').trim();
    const tools = (row.config.tools ?? '').split(/[\s,]+/).filter((t) => t !== '');
    return [
      {
        name: row.type.slice(CUSTOM_MCP_PREFIX.length),
        url,
        ...(token ? { token } : {}),
        tools,
        only: row.config.toolMode === 'only',
      },
    ];
  });
}
