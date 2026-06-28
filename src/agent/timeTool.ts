import type { OpenAiFunctionTool } from './toolBridge.ts';
import { getServerTimezone, toLocalIso } from '../utils/time.ts';

export const GET_CURRENT_TIME_TOOL_NAME = 'get_current_time';

export interface CurrentTimeResult {
  /** UTC ISO instant. */
  iso: string;
  /** Wall-clock in the server timezone with offset, e.g. "2026-06-29 00:30:15 GMT+02:00". */
  local: string;
  /** IANA timezone name, e.g. "Europe/Madrid". */
  timezone: string;
  /** English weekday name in the server timezone, e.g. "Monday". */
  weekday: string;
  unixMs: number;
}

export function buildCurrentTimeTool(): OpenAiFunctionTool {
  return {
    type: 'function',
    name: GET_CURRENT_TIME_TOOL_NAME,
    description:
      'Get the current date and time in the server timezone. You do NOT otherwise ' +
      'know what day or time it is — call this first whenever you need "now" or to ' +
      'resolve a relative date/time (today, tomorrow, this weekend, "in 5 minutes"), ' +
      'e.g. before get_weather or schedule_action. Takes no arguments.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  };
}

export function executeCurrentTimeTool(deps: { now?: number } = {}): CurrentTimeResult {
  const nowMs = deps.now ?? Date.now();
  const tz = getServerTimezone();
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: tz }).format(
    new Date(nowMs),
  );
  return {
    iso: new Date(nowMs).toISOString(),
    local: toLocalIso(nowMs),
    timezone: tz,
    weekday,
    unixMs: nowMs,
  };
}
