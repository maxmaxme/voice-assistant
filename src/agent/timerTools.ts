import type { TimersAdapter } from '../memory/types.ts';
import type { OpenAiFunctionTool } from './toolBridge.ts';

function toLocalIso(ms: number): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: tz,
    timeZoneName: 'longOffset',
  })
    .format(new Date(ms))
    .replace(',', '');
}

export const TIMER_TOOL_NAMES = new Set(['set_timer', 'list_timers', 'cancel_timer']);

export function buildTimerTools(): OpenAiFunctionTool[] {
  return [
    {
      type: 'function',
      name: 'set_timer',
      description:
        'Start a countdown timer. After `seconds` seconds the user gets a Telegram message. ' +
        'Use for cooking timers, "remind me in 10 minutes", etc.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short label, e.g. "pasta", "coffee".' },
          seconds: { type: 'integer', description: 'Countdown in whole seconds. Must be > 0.' },
        },
        required: ['label', 'seconds'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_timers',
      description: 'List active timers.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'cancel_timer',
      description:
        'Cancel an active timer by id. Returns {ok: true} if cancelled, else {ok: false}.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];
}

export function executeTimerTool(
  timers: TimersAdapter,
  name: string,
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case 'set_timer': {
      const label = String(args.label ?? '').trim();
      const seconds = Number(args.seconds);
      if (!label) throw new Error('set_timer: label is required');
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('set_timer: seconds must be a positive number');
      }
      const durationMs = Math.round(seconds * 1000);
      const fireAt = Date.now() + durationMs;
      const t = timers.add({ label, fireAt, durationMs });
      return {
        id: t.id,
        label: t.label,
        fire_at: t.fireAt,
        fire_at_local: toLocalIso(t.fireAt),
        duration_ms: t.durationMs,
      };
    }
    case 'list_timers':
      return timers.listActive().map((t) => ({
        id: t.id,
        label: t.label,
        fire_at: t.fireAt,
        fire_at_local: toLocalIso(t.fireAt),
        duration_ms: t.durationMs,
      }));
    case 'cancel_timer': {
      const id = Number(args.id);
      if (!Number.isFinite(id)) throw new Error('cancel_timer: id must be a number');
      return { ok: timers.cancel(id) };
    }
    default:
      throw new Error(`Unknown timer tool: ${name}`);
  }
}
