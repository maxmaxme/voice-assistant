import type { IdentitiesAdapter, ScheduledActionsAdapter } from '../memory/types.ts';
import { nextFireAt as computeNextFireAt, validateSchedule } from '../scheduling/cron.ts';
import type { Schedule } from '../scheduling/types.ts';
import { parseLocalWallClock, toLocalIso } from '../utils/time.ts';
import { loadPrompt } from './prompts/load.ts';
import type { OpenAiFunctionTool } from './toolBridge.ts';

const SCHEDULE_ACTION_DESCRIPTION = loadPrompt(
  './prompts/tools/schedule-action.md',
  import.meta.url,
);
const LIST_SCHEDULED_DESCRIPTION = loadPrompt('./prompts/tools/list-scheduled.md', import.meta.url);
const CANCEL_SCHEDULED_DESCRIPTION = loadPrompt(
  './prompts/tools/cancel-scheduled.md',
  import.meta.url,
);

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
      description: SCHEDULE_ACTION_DESCRIPTION,
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
      description: LIST_SCHEDULED_DESCRIPTION,
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
      description: CANCEL_SCHEDULED_DESCRIPTION,
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
      throw new Error(
        `schedule_action: schedule_expr "${exprStr}" is in the past (now: ${toLocalIso(Date.now())})`,
      );
    }
    return { schedule: { kind: 'once', at: parsed }, nextFireAt: parsed };
  }
  if (kind === 'cron') {
    const schedule: Schedule = { kind: 'cron', expr: exprStr };
    try {
      validateSchedule(schedule);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `schedule_action: invalid cron schedule_expr "${exprStr}" (expected POSIX 5-field "minute hour dom month dow", e.g. "0 8 * * *"): ${msg}`,
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
  return schedule.kind === 'once' ? toLocalIso(schedule.at) : schedule.expr;
}

/** The principal context for owner-aware scheduled-action tools. `ownerUserId`
 *  is the resolved caller (null when unscoped, e.g. a goal-mode fire);
 *  `identities` resolves whether that user can actually receive a reminder. */
export interface ScheduledActionToolContext {
  ownerUserId: number | null;
  identities: IdentitiesAdapter;
}

export function executeScheduledActionTool(
  adapter: ScheduledActionsAdapter,
  name: 'schedule_action',
  args: Record<string, unknown>,
  ctx: ScheduledActionToolContext,
): ScheduleActionResult;
export function executeScheduledActionTool(
  adapter: ScheduledActionsAdapter,
  name: 'list_scheduled',
  args: Record<string, unknown>,
  ctx: ScheduledActionToolContext,
): ListScheduledItem[];
export function executeScheduledActionTool(
  adapter: ScheduledActionsAdapter,
  name: 'cancel_scheduled',
  args: Record<string, unknown>,
  ctx: ScheduledActionToolContext,
): CancelScheduledResult;
export function executeScheduledActionTool(
  adapter: ScheduledActionsAdapter,
  name: string,
  args: Record<string, unknown>,
  ctx: ScheduledActionToolContext,
): ScheduledActionToolResult;
export function executeScheduledActionTool(
  adapter: ScheduledActionsAdapter,
  name: string,
  args: Record<string, unknown>,
  ctx: ScheduledActionToolContext,
): ScheduledActionToolResult {
  switch (name) {
    case 'schedule_action': {
      const goal = String(args.goal ?? '').trim();
      if (!goal) {
        throw new Error('schedule_action: goal is required');
      }
      // Reminders fire back to the author over Telegram, so an action can
      // only be scheduled by an identified user who has a Telegram chat to
      // deliver to. The speaker (voice principal, no Telegram) hits this.
      if (ctx.ownerUserId === null) {
        throw new Error(
          'schedule_action: cannot schedule — no identified user to deliver the reminder to',
        );
      }
      if (ctx.identities.identityFor('telegram', ctx.ownerUserId) === null) {
        throw new Error(
          'schedule_action: cannot schedule — you have no Telegram linked, so the reminder could not be delivered',
        );
      }
      const { schedule, nextFireAt } = buildSchedule(args.schedule_kind, args.schedule_expr);
      const created = adapter.add({ goal, schedule, nextFireAt, ownerUserId: ctx.ownerUserId });
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
      if (ctx.ownerUserId === null) {
        return [];
      }
      return adapter.listActiveForOwner(ctx.ownerUserId).map((row) => ({
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
      if (ctx.ownerUserId === null) {
        return { ok: false };
      }
      return { ok: adapter.cancel(id, ctx.ownerUserId) };
    }
    default:
      throw new Error(`Unknown scheduled action tool: ${name}`);
  }
}
