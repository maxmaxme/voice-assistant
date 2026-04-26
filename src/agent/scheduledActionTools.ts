import type { ScheduledActionsAdapter } from '../memory/types.ts';
import { nextFireAt as computeNextFireAt, validateSchedule } from '../scheduling/cron.ts';
import type { Schedule } from '../scheduling/types.ts';
import { parseLocalWallClock, toLocalIso } from '../utils/time.ts';
import type { OpenAiFunctionTool } from './toolBridge.ts';

export const SCHEDULED_ACTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'schedule_action',
  'list_scheduled',
  'cancel_scheduled',
]);

export function buildScheduledActionTools(): OpenAiFunctionTool[] {
  return [
    {
      type: 'function',
      name: 'schedule_action',
      description:
        'Schedule a future natural-language goal for the assistant to carry out at a later time. ' +
        'REPLACES `add_reminder` and `set_timer` — use this for any future-time goal, one-shot or recurring. ' +
        'At fire time, `goal` is replayed to the assistant verbatim, so write it as a clear, self-contained instruction ' +
        '(include any context the assistant will need, e.g. "Включи свет на кухне и напиши мне в Telegram «доброе утро»"). ' +
        'For `schedule_kind: "once"`, set `schedule_expr` to a wall-clock time string in the SERVER timezone, ' +
        'either "YYYY-MM-DD HH:mm" or "YYYY-MM-DD HH:mm:ss" (NO timezone offset). Must be in the future. ' +
        'For `schedule_kind: "cron"`, set `schedule_expr` to a POSIX 5-field cron expression evaluated in the server timezone. ' +
        'Examples: "0 8 * * *" (daily at 08:00), "30 7 * * 1-5" (weekdays at 07:30), "*/15 * * * *" (every 15 minutes).',
      parameters: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description:
              'Natural-language description of what the assistant should do at fire time. Replayed verbatim — write it as a clear, self-contained instruction.',
          },
          schedule_kind: {
            type: 'string',
            enum: ['once', 'cron'],
            description:
              '"once" = single fire at a wall-clock time. "cron" = recurring on a POSIX cron schedule.',
          },
          schedule_expr: {
            type: 'string',
            description:
              'For "once": wall-clock string "YYYY-MM-DD HH:mm[:ss]" in the SERVER timezone (no offset). ' +
              'For "cron": POSIX 5-field cron ("minute hour day-of-month month day-of-week").',
          },
        },
        required: ['goal', 'schedule_kind', 'schedule_expr'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_scheduled',
      description:
        'List active scheduled actions sorted by next_fire_at ascending. Includes both one-shot and recurring entries.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'cancel_scheduled',
      description:
        'Cancel an active scheduled action by id. Returns {ok: true} if cancelled, else {ok: false}.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];
}

export interface ScheduleActionResult {
  id: number;
  goal: string;
  schedule_kind: 'once' | 'cron';
  schedule_expr: string;
  next_fire_at: number;
  next_fire_at_local: string;
}

export interface ListScheduledItem {
  id: number;
  goal: string;
  schedule_kind: 'once' | 'cron';
  schedule_expr: string;
  next_fire_at: number;
  next_fire_at_local: string;
  last_fired_at: number | null;
  last_fired_at_local: string | null;
}

export interface CancelScheduledResult {
  ok: boolean;
}

export type ScheduledActionToolResult =
  | ScheduleActionResult
  | ListScheduledItem[]
  | CancelScheduledResult;

function buildSchedule(kind: unknown, expr: unknown): { schedule: Schedule; nextFireAt: number } {
  const exprStr = String(expr ?? '').trim();
  if (!exprStr) {
    throw new Error('schedule_action: schedule_expr is required');
  }
  if (kind === 'once') {
    let parsed: number;
    try {
      parsed = parseLocalWallClock(exprStr);
    } catch (e) {
      throw new Error(
        `schedule_action: invalid schedule_expr "${exprStr}" for schedule_kind="once": ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
    if (parsed <= Date.now()) {
      throw new Error(`schedule_action: schedule_expr "${exprStr}" is in the past`);
    }
    return { schedule: { kind: 'once', at: parsed }, nextFireAt: parsed };
  }
  if (kind === 'cron') {
    const schedule: Schedule = { kind: 'cron', expr: exprStr };
    try {
      validateSchedule(schedule);
    } catch (e) {
      throw new Error(
        `schedule_action: invalid cron schedule_expr "${exprStr}": ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
    const next = computeNextFireAt(schedule, Date.now());
    return { schedule, nextFireAt: next };
  }
  throw new Error(
    `schedule_action: unknown schedule_kind "${String(kind)}", expected "once" or "cron"`,
  );
}

function scheduleToExprString(schedule: Schedule): string {
  return schedule.kind === 'once' ? String(schedule.at) : schedule.expr;
}

export function executeScheduledActionTool(
  adapter: ScheduledActionsAdapter,
  name: 'schedule_action',
  args: Record<string, unknown>,
): ScheduleActionResult;
export function executeScheduledActionTool(
  adapter: ScheduledActionsAdapter,
  name: 'list_scheduled',
  args: Record<string, unknown>,
): ListScheduledItem[];
export function executeScheduledActionTool(
  adapter: ScheduledActionsAdapter,
  name: 'cancel_scheduled',
  args: Record<string, unknown>,
): CancelScheduledResult;
export function executeScheduledActionTool(
  adapter: ScheduledActionsAdapter,
  name: string,
  args: Record<string, unknown>,
): ScheduledActionToolResult;
export function executeScheduledActionTool(
  adapter: ScheduledActionsAdapter,
  name: string,
  args: Record<string, unknown>,
): ScheduledActionToolResult {
  switch (name) {
    case 'schedule_action': {
      const goal = String(args.goal ?? '').trim();
      if (!goal) {
        throw new Error('schedule_action: goal is required');
      }
      const { schedule, nextFireAt } = buildSchedule(args.schedule_kind, args.schedule_expr);
      const created = adapter.add({ goal, schedule, nextFireAt });
      return {
        id: created.id,
        goal: created.goal,
        schedule_kind: created.schedule.kind,
        schedule_expr: scheduleToExprString(created.schedule),
        next_fire_at: created.nextFireAt,
        next_fire_at_local: toLocalIso(created.nextFireAt),
      };
    }
    case 'list_scheduled': {
      return adapter.listActive().map((row) => ({
        id: row.id,
        goal: row.goal,
        schedule_kind: row.schedule.kind,
        schedule_expr: scheduleToExprString(row.schedule),
        next_fire_at: row.nextFireAt,
        next_fire_at_local: toLocalIso(row.nextFireAt),
        last_fired_at: row.lastFiredAt,
        last_fired_at_local: row.lastFiredAt === null ? null : toLocalIso(row.lastFiredAt),
      }));
    }
    case 'cancel_scheduled': {
      const id = Number(args.id);
      if (!Number.isFinite(id)) {
        throw new Error('cancel_scheduled: id must be a number');
      }
      return { ok: adapter.cancel(id) };
    }
    default:
      throw new Error(`Unknown scheduled action tool: ${name}`);
  }
}
