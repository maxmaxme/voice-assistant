/** Registry of local tools — ones executed in-process rather than via MCP.
 *
 * Two flavours:
 *  - **Adapter-free** (currently `get_weather`): always available; no
 *    injection needed.
 *  - **Adapter-backed** (memory, scheduled actions, `send_to_telegram`):
 *    registered only when the caller passes the relevant adapter(s); tools
 *    whose adapters are absent are silently omitted. That omission is the
 *    per-channel policy knob — e.g. goal mode simply doesn't wire
 *    `scheduledActions`/`telegram`.
 *
 * Both the Responses-API `OpenAiAgent` and the Realtime bridge build their
 * tool list AND dispatch execution through `buildLocalToolset` — adding a
 * tool here makes it available everywhere the needed adapter is wired.
 * The only local tool outside the registry is `ask` (askTool.ts): it is
 * terminal control flow handled inside the agent loop, not an executable. */

import type { IdentitiesAdapter, ScheduledActionsAdapter } from '../memory/types.ts';
import type { ScopedProfile } from '../memory/scope.ts';
import type { TelegramSender } from '../telegram/types.ts';
import { buildMemoryTools, executeMemoryTool } from './memoryTools.ts';
import { buildScheduledActionTools, executeScheduledActionTool } from './scheduledActionTools.ts';
import { TELEGRAM_TOOL_NAME, buildTelegramTool, executeTelegramTool } from './telegramTool.ts';
import type { OpenAiFunctionTool } from './toolBridge.ts';
import {
  buildWeatherTool,
  executeWeatherTool,
  WEATHER_TOOL_NAME,
  type WeatherUnits,
} from './weatherTool.ts';
import {
  buildCurrentTimeTool,
  executeCurrentTimeTool,
  GET_CURRENT_TIME_TOOL_NAME,
} from './timeTool.ts';

export interface LocalToolDeps {
  profile?: ScopedProfile;
  scheduledActions?: ScheduledActionsAdapter;
  /** Builds a Telegram sender bound to a chat id. `send_to_telegram` resolves
   *  a recipient (the current principal by default) to a chat via `identities`
   *  and delivers through this. Requires `identities` to be wired too. */
  telegram?: { senderFor: (chatId: string) => TelegramSender };
  /** Owner-aware context. Required for the scheduled-action tools (author of
   *  reminders, owner-scoped list/cancel) and for `send_to_telegram` recipient
   *  resolution. When omitted, the caller is treated as unidentified
   *  (`ownerUserId: null`). */
  identities?: IdentitiesAdapter;
  ownerUserId?: number | null;
  /** Built-in tool gates (web panel's Tools page). On by default — pass `false`
   *  to omit that tool group even when its adapter is wired. */
  enableMemory?: boolean;
  enableReminders?: boolean;
  enableWeather?: boolean;
  /** Weather config (units + default-location fallback) forwarded to the tool. */
  weatherUnits?: WeatherUnits;
  weatherDefaultLocation?: string;
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
  // Always available + adapter-free: the agent has no static clock in its
  // prompt, so this is how it learns "now" / resolves relative dates.
  const registry: Record<string, LocalTool> = {
    [GET_CURRENT_TIME_TOOL_NAME]: {
      tool: buildCurrentTimeTool(),
      execute: () => executeCurrentTimeTool(),
    },
  };
  if (deps.enableWeather !== false) {
    registry[WEATHER_TOOL_NAME] = {
      tool: buildWeatherTool(),
      execute: (args) =>
        executeWeatherTool(args, {
          units: deps.weatherUnits,
          defaultLocation: deps.weatherDefaultLocation,
        }),
    };
  }
  if (deps.profile && deps.enableMemory !== false) {
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
  if (deps.scheduledActions && deps.identities && deps.enableReminders !== false) {
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
  // send_to_telegram resolves a recipient via identities, so both must be wired.
  if (deps.telegram && deps.identities) {
    const senderFor = deps.telegram.senderFor;
    const identities = deps.identities;
    const scopeUserId = deps.ownerUserId ?? null;
    registry[TELEGRAM_TOOL_NAME] = {
      tool: buildTelegramTool(),
      execute: (args) =>
        executeTelegramTool(
          { scope: scopeUserId === null ? null : { userId: scopeUserId }, identities, senderFor },
          args,
        ),
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
