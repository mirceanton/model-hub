CREATE TABLE `files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`relative_path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`mtime` integer NOT NULL,
	`extension` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_project_id_relative_path_unique` ON `files` (`project_id`,`relative_path`);--> statement-breakpoint
CREATE TABLE `projects` (
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_fs_id_unique` ON `projects` (`fs_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_unique` ON `projects` (`path`);