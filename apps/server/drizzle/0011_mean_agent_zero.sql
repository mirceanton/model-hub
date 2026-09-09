PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_auth_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`oidc_groups_claim` text DEFAULT 'groups' NOT NULL,
	`default_role` text DEFAULT 'viewer',
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_auth_settings`("id", "oidc_groups_claim", "default_role", "updated_at") SELECT "id", "oidc_groups_claim", "default_role", "updated_at" FROM `auth_settings`;--> statement-breakpoint
DROP TABLE `auth_settings`;--> statement-breakpoint
ALTER TABLE `__new_auth_settings` RENAME TO `auth_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;