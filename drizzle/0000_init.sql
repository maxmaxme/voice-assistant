CREATE TABLE `identities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`identity` text NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "identities_channel_check" CHECK("identities"."channel" IN ('telegram', 'http', 'voice'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identities_channel_identity_unique` ON `identities` (`channel`,`identity`);--> statement-breakpoint
CREATE TABLE `profile` (
	`owner` text DEFAULT 'household' NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner`, `key`)
);
--> statement-breakpoint
CREATE TABLE `scheduled_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`goal` text NOT NULL,
	`schedule_kind` text NOT NULL,
	`schedule_expr` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`next_fire_at` integer NOT NULL,
	`last_fired_at` integer,
	`created_at` integer NOT NULL,
	`owner_user_id` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "scheduled_actions_kind_check" CHECK("scheduled_actions"."schedule_kind" IN ('once', 'cron'))
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_actions_due` ON `scheduled_actions` (`next_fire_at`) WHERE status = 'active';--> statement-breakpoint
CREATE TABLE `telegram_sessions` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`last_response_id` text,
	`pending_ask_call_id` text,
	`updated_at` integer NOT NULL,
	`pending_tool_outputs` text
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`is_admin` integer DEFAULT 0 NOT NULL
);
