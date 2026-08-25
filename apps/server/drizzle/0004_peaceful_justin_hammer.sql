ALTER TABLE `files` ADD `content_hash` text;--> statement-breakpoint
CREATE INDEX `files_content_hash_idx` ON `files` (`content_hash`);