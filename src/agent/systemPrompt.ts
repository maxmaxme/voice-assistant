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
