import { executeRoutedTool } from '../agent/toolExecutor.ts';
import type { LocalToolset } from '../agent/localTools.ts';
import type { McpClient } from '../mcp/types.ts';
import { ToolResultCache, CACHEABLE_TOOLS } from './toolCache.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('tool-runner');

export interface RealtimeToolRunnerDeps {
  localToolset: LocalToolset;
  mcp: McpClient;
  cache: ToolResultCache;
  cacheTtlMs: number;
}

/**
 * The realtime bridge's `runTool` hook: the shared local-vs-MCP routing
 * (executeRoutedTool — same as the Responses-API agent loop) with the
 * short-TTL HA result cache layered on the MCP side as a decorator.
 * Errors come back as `{"error": …}` JSON — the Realtime model's expected
 * failure shape — never as a throw.
 */
export function buildRealtimeToolRunner(
  deps: RealtimeToolRunnerDeps,
): (name: string, args: unknown) => Promise<string> {
  const { localToolset, mcp, cache, cacheTtlMs } = deps;

  const cachedMcp: McpClient = {
    connect: () => mcp.connect(),
    disconnect: () => mcp.disconnect(),
    listTools: () => mcp.listTools(),
    callTool: async (name, args) => {
      if (CACHEABLE_TOOLS.has(name)) {
        const key = `${name}:${JSON.stringify(args)}`;
        const hit = cache.get(key);
        if (hit !== undefined) {
          log.info({ name }, `${name} cache hit`);
          // The cache only ever stores JSON.stringify(result) from the branch
          // below, so parsing back yields the same McpToolResult shape.
          return JSON.parse(hit);
        }
        const result = await mcp.callTool(name, args);
        cache.set(key, JSON.stringify(result), cacheTtlMs);
        return result;
      }
      // Any non-cacheable MCP tool may have mutated state (HassTurnOn /
      // HassTurnOff / SetClimate / …). Drop the snapshot so the next
      // GetLiveContext goes to HA for real. Local tools never reach this
      // client, so they leave the snapshot valid.
      cache.clear(name);
      return mcp.callTool(name, args);
    },
  };

  return async (name, args) => {
    // The model can emit malformed argument JSON; run the tool with empty
    // args rather than failing the turn.
    const safeArgs: Record<string, unknown> = {};
    if (args && typeof args === 'object') {
      Object.assign(safeArgs, args);
    }
    const result = await executeRoutedTool(localToolset, cachedMcp, name, safeArgs);
    return result.isError ? JSON.stringify({ error: result.text }) : result.text;
  };
}
