import type { IdentitiesAdapter, ScheduledActionsAdapter } from '../memory/types.ts';
import { nextFireAt as computeNextFireAt, validateSchedule } from '../scheduling/cron.ts';
import type { Schedule } from '../scheduling/types.ts';
import { parseLocalWallClock, toLocalIso } from '../utils/time.ts';
import { resolvePrompt } from './prompts/registry.ts';
import { resolveTelegramRecipient } from './recipients.ts';
import type { OpenAiFunctionTool } from './toolBridge.ts';

export function buildScheduledActionTools(): OpenAiFunctionTool[] {
  return [
    {
      type: 'function',
      name: 'schedule_action',
      description: resolvePrompt('tools/schedule-action'),
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
          recipient: {
            type: 'integer',
            description:
              'User id who the reminder fires to. Omit to remind the current user. ' +
              'If the current user has no Telegram linked (e.g. on the shared speaker), scheduling fails with an error listing valid recipients (id = name) — ask who to remind, then pass that id.',
          },
        },
        required: ['goal', 'schedule_kind', 'schedule_expr'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_scheduled',
      description: resolvePrompt('tools/list-scheduled'),
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
      description: resolvePrompt('tools/cancel-scheduled'),
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
      // Reminders fire to a user over Telegram. The recipient is the explicit
      // `recipient` user id, or the current user by default — and must have a
      // Telegram chat to deliver to. The speaker (voice principal, no Telegram)
      // hits this unless it names a Telegram-linked recipient.
      const ownerUserId = resolveTelegramRecipient(
        args.recipient,
        ctx.ownerUserId,
        ctx.identities,
        {
          invalidRecipient:
            'schedule_action: `recipient` must be a user id (integer), or omit it to remind yourself',
          noCurrentUser:
            'schedule_action: no recipient — there is no current user, specify who to remind.',
          noTelegramLinked: (userId) =>
            `schedule_action: user ${userId} has no Telegram linked, so the reminder cannot be delivered.`,
        },
      );
      const { schedule, nextFireAt } = buildSchedule(args.schedule_kind, args.schedule_expr);
      const created = adapter.add({ goal, schedule, nextFireAt, ownerUserId });
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
      // Returning [] here would make the model confidently tell the user they
      // have no reminders — throw so it can explain the caller is unidentified.
      if (ctx.ownerUserId === null) {
        throw new Error(
          'list_scheduled: there is no current user — reminders are owned per-user and cannot be listed for an unidentified caller.',
        );
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
      // Same reasoning as list_scheduled: a silent ok:false reads as "already
      // cancelled" to the model — surface the real cause instead.
      if (ctx.ownerUserId === null) {
        throw new Error(
          'cancel_scheduled: there is no current user — reminders are owned per-user and cannot be cancelled by an unidentified caller.',
        );
      }
      return { ok: adapter.cancel(id, ctx.ownerUserId) };
    }
    default:
      throw new Error(`Unknown scheduled action tool: ${name}`);
  }
}
