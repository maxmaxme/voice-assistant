import { executeRoutedTool } from '../agent/toolExecutor.ts';
import { bareToolName } from '../agent/toolBridge.ts';
import type { LocalToolset } from '../agent/localTools.ts';
import type { McpClient } from '../mcp/types.ts';
import { ToolResultCache, CACHEABLE_TOOLS } from './toolCache.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('tool-runner');

export interface SpeakerToolRunnerDeps {
  localToolset: LocalToolset;
  mcp: McpClient;
  cache: ToolResultCache;
  cacheTtlMs: number;
}

/**
 * The voice MCP's `tools/call` runner: the shared local-vs-MCP routing
 * (executeRoutedTool — same as the Responses-API agent loop) with the
 * short-TTL HA result cache layered on the MCP side as a decorator.
 * Errors come back as `{"error": …}` JSON — the Realtime model's expected
 * failure shape — never as a throw.
 */
export function buildSpeakerToolRunner(
  deps: SpeakerToolRunnerDeps,
): (name: string, args: unknown) => Promise<string> {
  const { localToolset, mcp, cache, cacheTtlMs } = deps;

  const cachedMcp: McpClient = {
    connect: () => mcp.connect(),
    disconnect: () => mcp.disconnect(),
    listTools: () => mcp.listTools(),
    callTool: async (name, args) => {
      if (CACHEABLE_TOOLS.has(bareToolName(name))) {
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
    if (!result.isError) {
      return result.text;
    }
    // The front-end sees a normal result either way, so this is the only trace.
    log.warn({ name, args: safeArgs, error: result.text }, `${name} failed: ${result.text}`);
    return JSON.stringify({ error: result.text });
  };
}
