/** Registry of local tools — ones executed in-process rather than via MCP.
 *
 * Two flavours:
 *  - **Adapter-free** (currently `get_weather`): always available; no
 *    injection needed.
 *  - **Adapter-backed** (currently `remember` / `recall` / `forget`):
 *    available when the caller passes the relevant adapter. The
 *    Responses-API `OpenAiAgent` and the Realtime bridge both wire memory
 *    in via `buildLocalToolset({ profile })`; tools that need an adapter
 *    the caller did NOT provide are silently omitted.
 *
 * Tools that need more than a simple adapter (scheduled actions,
 * send_to_telegram, ask) still live in their own modules and are wired
 * per-channel. */

import type { IdentitiesAdapter, ScheduledActionsAdapter } from '../memory/types.ts';
import type { ScopedProfile } from '../memory/scope.ts';
import type { TelegramSender } from '../telegram/types.ts';
import { MEMORY_TOOL_NAMES, buildMemoryTools, executeMemoryTool } from './memoryTools.ts';
import {
  SCHEDULED_ACTION_TOOL_NAMES,
  buildScheduledActionTools,
  executeScheduledActionTool,
} from './scheduledActionTools.ts';
import { TELEGRAM_TOOL_NAME, buildTelegramTool, executeTelegramTool } from './telegramTool.ts';
import type { OpenAiFunctionTool } from './toolBridge.ts';
import { buildWeatherTool, executeWeatherTool, WEATHER_TOOL_NAME } from './weatherTool.ts';

export interface LocalToolDeps {
  profile?: ScopedProfile;
  scheduledActions?: ScheduledActionsAdapter;
  telegram?: TelegramSender;
  /** Owner-aware scheduled-action context. Required for the scheduled-action
   *  tools to know who is scheduling (author of reminders, owner-scoped
   *  list/cancel). When `scheduledActions` is provided without this, the
   *  caller is treated as unidentified (`ownerUserId: null`). */
  identities?: IdentitiesAdapter;
  ownerUserId?: number | null;
}

export interface LocalToolset {
  tools: OpenAiFunctionTool[];
  names: ReadonlySet<string>;
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

interface LocalTool {
  tool: OpenAiFunctionTool;
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

function buildRegistry(deps: LocalToolDeps): Record<string, LocalTool> {
  const registry: Record<string, LocalTool> = {
    [WEATHER_TOOL_NAME]: {
      tool: buildWeatherTool(),
      execute: (args) => executeWeatherTool(args),
    },
  };
  if (deps.profile) {
    const profile = deps.profile;
    for (const tool of buildMemoryTools()) {
      registry[tool.name] = {
        tool,
        execute: (args) => executeMemoryTool(profile, tool.name, args),
      };
    }
  }
  // Scheduled-action tools are owner-aware: they need an identities adapter to
  // validate/route reminders. Register them only when both are wired.
  if (deps.scheduledActions && deps.identities) {
    const scheduledActions = deps.scheduledActions;
    const identities = deps.identities;
    const ownerUserId = deps.ownerUserId ?? null;
    for (const tool of buildScheduledActionTools()) {
      registry[tool.name] = {
        tool,
        execute: (args) =>
          executeScheduledActionTool(scheduledActions, tool.name, args, {
            ownerUserId,
            identities,
          }),
      };
    }
  }
  if (deps.telegram) {
    const telegram = deps.telegram;
    registry[TELEGRAM_TOOL_NAME] = {
      tool: buildTelegramTool(),
      execute: (args) => executeTelegramTool(telegram, args),
    };
  }
  return registry;
}

export function buildLocalToolset(deps: LocalToolDeps = {}): LocalToolset {
  const registry = buildRegistry(deps);
  const names = new Set(Object.keys(registry));
  return {
    tools: Object.values(registry).map((e) => e.tool),
    names,
    async execute(name, args) {
      const entry = registry[name];
      if (!entry) {
        throw new Error(`executeLocalTool: unknown tool "${name}"`);
      }
      return entry.execute(args);
    },
  };
}

/** Back-compat thin wrappers used by the Responses-API agent, which wires
 *  memory tools separately. New callers should prefer `buildLocalToolset`. */

const ADAPTER_FREE = buildRegistry({});

export const LOCAL_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(ADAPTER_FREE));

export function buildLocalTools(): OpenAiFunctionTool[] {
  return Object.values(ADAPTER_FREE).map((e) => e.tool);
}

export async function executeLocalTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const entry = ADAPTER_FREE[name];
  if (!entry) {
    throw new Error(`executeLocalTool: unknown tool "${name}"`);
  }
  return entry.execute(args);
}

export { MEMORY_TOOL_NAMES, SCHEDULED_ACTION_TOOL_NAMES, TELEGRAM_TOOL_NAME };
