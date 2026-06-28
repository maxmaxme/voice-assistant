CREATE TABLE `integrations` (
	`type` text PRIMARY KEY NOT NULL,
	`config` text NOT NULL,
	`updated_at` integer NOT NULL
);
