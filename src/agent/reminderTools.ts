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

export const REMINDER_TOOL_NAMES = new Set(['add_reminder', 'list_reminders', 'cancel_reminder']);

export function buildReminderTools(): OpenAiFunctionTool[] {
  return [
    {
      type: 'function',
      name: 'add_reminder',
      description:
        'Schedule a one-shot reminder. The user gets a Telegram message with `text` at `fire_at`. ' +
        'Resolve relative times like "tomorrow at 9am" yourself based on the current time in the system prompt. ' +
        'Returns the new reminder id.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to remind the user about. Plain text.' },
          fire_at: {
            type: 'integer',
            description: 'When to fire, as Unix ms (UTC). Must be in the future.',
          },
        },
        required: ['text', 'fire_at'],
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
      const fireAt = Number(args.fire_at);
      if (!text) throw new Error('add_reminder: text is required');
      if (!Number.isFinite(fireAt)) throw new Error('add_reminder: fire_at must be a number');
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
