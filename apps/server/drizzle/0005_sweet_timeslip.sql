ALTER TABLE `models` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `models` ADD `source_snapshot_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `source_snapshot_html` text;--> statement-breakpoint
ALTER TABLE `models` ADD `source_snapshot_error` text;--> statement-breakpoint
ALTER TABLE `models` ADD `source_snapshot_fetched_at` integer;