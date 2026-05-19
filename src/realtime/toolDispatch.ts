import type { McpClient } from '../mcp/types.ts';
import type { MemoryStore } from '../memory/types.ts';
import type { TelegramSender } from '../telegram/types.ts';
import { mcpToolsToOpenAi, type OpenAiFunctionTool } from '../agent/toolBridge.ts';
import { MEMORY_TOOL_NAMES, buildMemoryTools, executeMemoryTool } from '../agent/memoryTools.ts';
import {
  SCHEDULED_ACTION_TOOL_NAMES,
  buildScheduledActionTools,
  executeScheduledActionTool,
} from '../agent/scheduledActionTools.ts';
import {
  TELEGRAM_TOOL_NAME,
  buildTelegramTool,
  executeTelegramTool,
} from '../agent/telegramTool.ts';
import { isValidContent } from '../utils/mcpContent.ts';

export interface ToolDispatchDeps {
  mcp: McpClient;
  memory: MemoryStore;
  telegram: TelegramSender;
}

/** Realtime session tool shape — same as Responses function tool but
 *  Realtime rejects the `strict` field, so we strip it. */
export interface RealtimeFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Build the tool list shared with the OpenAI Realtime session.
 *  Mirrors what OpenAiAgent exposes, minus `ask` (Realtime owns the
 *  conversation turn-taking natively). */
export async function buildRealtimeTools(deps: ToolDispatchDeps): Promise<RealtimeFunctionTool[]> {
  const mcpTools = mcpToolsToOpenAi(await deps.mcp.listTools());
  const all: OpenAiFunctionTool[] = [
    ...mcpTools,
    ...buildMemoryTools(),
    ...buildScheduledActionTools(),
    buildTelegramTool(),
  ];
  return all.map(({ type, name, description, parameters }) => ({
    type,
    name,
    description,
    parameters,
  }));
}

export interface ToolCallResult {
  output: string;
  isError: boolean;
}

/** Dispatch one tool call against memory / scheduled / telegram / MCP.
 *  Returns serialised JSON or an error message — never throws. */
export async function dispatchRealtimeTool(
  deps: ToolDispatchDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    if (MEMORY_TOOL_NAMES.has(name)) {
      const r = executeMemoryTool(deps.memory.profile, name, args);
      return { output: JSON.stringify(r), isError: false };
    }
    if (SCHEDULED_ACTION_TOOL_NAMES.has(name)) {
      const r = executeScheduledActionTool(deps.memory.scheduledActions, name, args);
      return { output: JSON.stringify(r), isError: false };
    }
    if (name === TELEGRAM_TOOL_NAME) {
      const r = await executeTelegramTool(deps.telegram, args);
      return { output: JSON.stringify(r), isError: false };
    }
    const result = await deps.mcp.callTool(name, args);
    if (!isValidContent(result.content)) {
      return { output: 'ERROR: Invalid content', isError: true };
    }
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { output: text, isError: result.isError ?? false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { output: `ERROR: ${msg}`, isError: true };
  }
}
