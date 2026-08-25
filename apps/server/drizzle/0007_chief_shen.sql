CREATE TABLE `project_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	`dismissed_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_activity_project_id_idx` ON `project_activity` (`project_id`);