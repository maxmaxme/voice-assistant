import type { ProfileFacts } from '../memory/types.ts';
import { getServerTimezone, toLocalIso } from '../utils/time.ts';
import { loadPrompt } from './prompts/load.ts';

/**
 * Cross-cutting system prompt — identity, recovery procedure that spans
 * multiple tools, composite-intent self-check, style, and the JSON output
 * shape. Tool-specific behavioural rules live on the individual tool
 * descriptions (see askTool, memoryTools, scheduledActionTools,
 * telegramTool, and the MCP description-suffix map in toolBridge). When a
 * rule applies to ONE tool, put it on that tool's description; only
 * cross-tool rules belong here.
 *
 * The text itself lives in `prompts/base-system.md` so it's easier to
 * read, diff, and preview than an escaped TS string literal.
 */
export const BASE_SYSTEM_PROMPT = loadPrompt('./prompts/base-system.md', import.meta.url);

/** Append the time/profile context block that the model needs on every
 *  fresh chain (Responses) or session (Realtime). Pure — no `Date.now()`
 *  injection abstraction; both callers already accept "built once per
 *  session" semantics. */
export function appendUserContext(base: string, profile: ProfileFacts): string {
  const nowMs = Date.now();
  const nowUtcIso = new Date(nowMs).toISOString();
  const tzName = getServerTimezone();
  const nowLocal = toLocalIso(nowMs);
  const timeBlock =
    `\n\nCurrent time: ${nowUtcIso} UTC = ${nowLocal} (server timezone: ${tzName}).` +
    ` Unix ms now: ${nowMs}.`;
  if (Object.keys(profile).length === 0) {
    return `${base}${timeBlock}`;
  }
  return `${base}${timeBlock}\n\nKnown user profile: ${JSON.stringify(profile)}`;
}
