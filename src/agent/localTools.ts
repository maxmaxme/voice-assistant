/** Registry of "self-contained" local tools — ones that don't need any
 * adapter injected (no MCP, no TelegramSender, no MemoryAdapter). They're
 * shared verbatim between the Responses-API `OpenAiAgent` loop and the
 * Realtime bridge so adding a new tool here lights it up on every channel.
 *
 * Tools that DO need an adapter (memory, scheduled actions, send_to_telegram,
 * ask) stay in their own modules and are wired per-channel. */

import type { OpenAiFunctionTool } from './toolBridge.ts';
import { buildWeatherTool, executeWeatherTool, WEATHER_TOOL_NAME } from './weatherTool.ts';

interface LocalTool {
  tool: OpenAiFunctionTool;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

const REGISTRY: Record<string, LocalTool> = {
  [WEATHER_TOOL_NAME]: {
    tool: buildWeatherTool(),
    execute: (args) => executeWeatherTool(args),
  },
};

export const LOCAL_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(REGISTRY));

export function buildLocalTools(): OpenAiFunctionTool[] {
  return Object.values(REGISTRY).map((e) => e.tool);
}

/** Run a local tool by name. Throws if the name isn't registered (callers
 * should gate on `LOCAL_TOOL_NAMES.has(name)`). */
export async function executeLocalTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const entry = REGISTRY[name];
  if (!entry) {
    throw new Error(`executeLocalTool: unknown tool "${name}"`);
  }
  return entry.execute(args);
}
