import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

export const profile = sqliteTable(
  'profile',
  {
    owner: text('owner').notNull().default('household'),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.key] })],
);

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  isAdmin: integer('is_admin').notNull().default(0),
});

export const identities = sqliteTable(
  'identities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channel: text('channel', { enum: ['telegram', 'http', 'voice'] }).notNull(),
    identity: text('identity').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [
    unique('identities_channel_identity_unique').on(t.channel, t.identity),
    check('identities_channel_check', sql`${t.channel} IN ('telegram', 'http', 'voice')`),
  ],
);

export const scheduledActions = sqliteTable(
  'scheduled_actions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    goal: text('goal').notNull(),
    scheduleKind: text('schedule_kind', { enum: ['once', 'cron'] }).notNull(),
    scheduleExpr: text('schedule_expr').notNull(),
    // `status` is enum-typed for TS but has NO SQL CHECK — faithful to the prod
    // schema (the original migrations put CHECKs only on schedule_kind/channel).
    status: text('status', { enum: ['active', 'done', 'cancelled', 'error'] })
      .notNull()
      .default('active'),
    nextFireAt: integer('next_fire_at').notNull(),
    lastFiredAt: integer('last_fired_at'),
    createdAt: integer('created_at').notNull(),
    ownerUserId: integer('owner_user_id').notNull().default(1),
  },
  (t) => [
    // Bare `status` (not `${t.status}`) so the generated DDL matches the prod
    // index verbatim — the baseline shim skips 0000_init on prod, so a fresh DB
    // must reproduce the exact `WHERE status = 'active'` the old migration emitted.
    index('idx_scheduled_actions_due')
      .on(t.nextFireAt)
      .where(sql`status = 'active'`),
    check('scheduled_actions_kind_check', sql`${t.scheduleKind} IN ('once', 'cron')`),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const prompts = sqliteTable('prompts', {
  name: text('name').primaryKey(),
  content: text('content').notNull(),
  // The bundled default, refreshed from the `.md` source on every startup.
  // Lets the web panel show "modified" and reset without reading image files.
  defaultContent: text('default_content').notNull().default(''),
  updatedAt: integer('updated_at').notNull(),
});

export const telegramSessions = sqliteTable('telegram_sessions', {
  chatId: integer('chat_id').primaryKey(),
  lastResponseId: text('last_response_id'),
  pendingAskCallId: text('pending_ask_call_id'),
  updatedAt: integer('updated_at').notNull(),
  pendingToolOutputs: text('pending_tool_outputs'),
  pendingAskExpiresAt: integer('pending_ask_expires_at'),
});
