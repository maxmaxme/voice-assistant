import type { RemindersAdapter } from '../memory/types.ts';
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

/** Parse a wall-clock string in the server's local TZ into a UTC epoch ms.
 * Accepts "YYYY-MM-DD HH:mm" or "YYYY-MM-DD HH:mm:ss" (space or 'T'
 * separator). The string MUST NOT include a timezone offset — the server's
 * TZ (process.env.TZ / system) is implicit. */
function parseLocalWallClock(raw: string): number {
  const s = raw.trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    throw new Error(
      `at_local: invalid format "${raw}", expected "YYYY-MM-DD HH:mm" or "YYYY-MM-DD HH:mm:ss"`,
    );
  }
  // JS Date parses an ISO string without offset as local time (TZ env).
  const ms = new Date(s).getTime();
  if (!Number.isFinite(ms)) throw new Error(`at_local: failed to parse "${raw}"`);
  return ms;
}

/** Resolve add_reminder's three alternative time inputs into a single UTC
 * epoch ms. Exactly one of `in_seconds`, `at_local`, `fire_at` must be a
 * non-null value. */
function resolveFireAt(args: Record<string, unknown>): number {
  const provided: string[] = [];
  let fireAt: number | null = null;

  if (args.in_seconds != null) {
    provided.push('in_seconds');
    const sec = Number(args.in_seconds);
    if (!Number.isFinite(sec) || sec <= 0) {
      throw new Error('in_seconds must be a positive number');
    }
    fireAt = Date.now() + Math.round(sec * 1000);
  }
  if (args.at_local != null) {
    provided.push('at_local');
    fireAt = parseLocalWallClock(String(args.at_local));
  }
  if (args.fire_at != null) {
    provided.push('fire_at');
    const f = Number(args.fire_at);
    if (!Number.isFinite(f)) throw new Error('fire_at must be a number');
    fireAt = f;
  }

  if (provided.length === 0) {
    throw new Error('add_reminder: provide one of in_seconds, at_local, or fire_at');
  }
  if (provided.length > 1) {
    throw new Error(
      `add_reminder: provide only one of in_seconds/at_local/fire_at, got: ${provided.join(', ')}`,
    );
  }
  return fireAt as number;
}

export const REMINDER_TOOL_NAMES = new Set(['add_reminder', 'list_reminders', 'cancel_reminder']);

export function buildReminderTools(): OpenAiFunctionTool[] {
  return [
    {
      type: 'function',
      name: 'add_reminder',
      description:
        'Schedule a one-shot reminder. The user gets a Telegram message with `text` when it fires. ' +
        'Provide EXACTLY ONE of `in_seconds`, `at_local`, or `fire_at` (set the other two to null). ' +
        'Prefer `in_seconds` for relative times ("через час" → 3600) and `at_local` for absolute wall-clock times ' +
        '("завтра в 9 утра" → "2026-04-27 09:00") — both avoid timezone arithmetic. ' +
        'Use `fire_at` only when you already have a precise UTC epoch.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to remind the user about. Plain text.' },
          in_seconds: {
            type: ['integer', 'null'],
            description:
              'PREFERRED for relative times. Whole seconds from now until fire. Server adds to current time. Must be > 0.',
          },
          at_local: {
            type: ['string', 'null'],
            description:
              'PREFERRED for absolute times. Wall-clock time in the SERVER timezone (shown in the system prompt). ' +
              'Format: "YYYY-MM-DD HH:mm" or "YYYY-MM-DD HH:mm:ss". Do NOT include a timezone offset. ' +
              'Example: "2026-04-27 09:00" means 9:00 AM in the server timezone.',
          },
          fire_at: {
            type: ['integer', 'null'],
            description:
              'Fallback: Unix ms since epoch (UTC). Avoid unless you really must — easy to get wrong with timezones.',
          },
        },
        required: ['text', 'in_seconds', 'at_local', 'fire_at'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_reminders',
      description: 'List pending reminders sorted by fire_at ascending.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'cancel_reminder',
      description:
        'Cancel a pending reminder by id. Returns {ok: true} if cancelled, else {ok: false}.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];
}

export interface AddReminderResult {
  id: number;
  fire_at: number;
  fire_at_local: string;
  text: string;
}
export interface ListReminderItem {
  id: number;
  text: string;
  fire_at: number;
  fire_at_local: string;
}
export interface CancelResult {
  ok: boolean;
}
export type ReminderToolResult = AddReminderResult | ListReminderItem[] | CancelResult;

export function executeReminderTool(
  reminders: RemindersAdapter,
  name: 'add_reminder',
  args: Record<string, unknown>,
): AddReminderResult;
export function executeReminderTool(
  reminders: RemindersAdapter,
  name: 'list_reminders',
  args: Record<string, unknown>,
): ListReminderItem[];
export function executeReminderTool(
  reminders: RemindersAdapter,
  name: 'cancel_reminder',
  args: Record<string, unknown>,
): CancelResult;
export function executeReminderTool(
  reminders: RemindersAdapter,
  name: string,
  args: Record<string, unknown>,
): ReminderToolResult;
export function executeReminderTool(
  reminders: RemindersAdapter,
  name: string,
  args: Record<string, unknown>,
): ReminderToolResult {
  switch (name) {
    case 'add_reminder': {
      const text = String(args.text ?? '').trim();
      if (!text) throw new Error('add_reminder: text is required');
      const fireAt = resolveFireAt(args);
      if (fireAt <= Date.now()) throw new Error('add_reminder: fire_at is in the past');
      const r = reminders.add({ text, fireAt });
      return {
        id: r.id,
        fire_at: r.fireAt,
        fire_at_local: toLocalIso(r.fireAt),
        text: r.text,
      };
    }
    case 'list_reminders':
      return reminders.listPending().map((r) => ({
        id: r.id,
        text: r.text,
        fire_at: r.fireAt,
        fire_at_local: toLocalIso(r.fireAt),
      }));
    case 'cancel_reminder': {
      const id = Number(args.id);
      if (!Number.isFinite(id)) throw new Error('cancel_reminder: id must be a number');
      return { ok: reminders.cancel(id) };
    }
    default:
      throw new Error(`Unknown reminder tool: ${name}`);
  }
}
