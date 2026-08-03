CREATE TABLE `models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fs_id` text NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`primary_file_path` text,
	`thumbnail_path` text,
	`thumbnail_status` text DEFAULT 'pending' NOT NULL,
	`last_synced_commit_sha` text,
	`last_synced_at` integer,
	`sync_status` text DEFAULT 'ok' NOT NULL,
	`sync_error` text,
	`missing_since` integer,
	`favorite` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_fs_id_unique` ON `models` (`fs_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `models_path_unique` ON `models` (`path`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_id` integer NOT NULL,
	`relative_path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`mtime` integer NOT NULL,
	`extension` text NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_model_id_relative_path_unique` ON `files` (`model_id`,`relative_path`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#6b7280' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `model_tags` (
	`model_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`model_id`, `tag_id`),
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `model_tags_tag_id_idx` ON `model_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_model_pins` (
	`project_id` integer NOT NULL,
	`model_id` integer NOT NULL,
	`pinned_commit_sha` text NOT NULL,
	`pinned_commit_message` text NOT NULL,
	`pinned_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `model_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_model_pins_model_id_idx` ON `project_model_pins` (`model_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`oidc_subject` text,
	`email` text,
	`name` text,
	`is_local_owner` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_oidc_subject_unique` ON `users` (`oidc_subject`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
