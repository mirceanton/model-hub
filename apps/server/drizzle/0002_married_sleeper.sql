CREATE TABLE `auth_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`oidc_groups_claim` text DEFAULT 'groups' NOT NULL,
	`default_role` text DEFAULT 'viewer' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oidc_group_role_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_group_role_mappings_group_name_unique` ON `oidc_group_role_mappings` (`group_name`);--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
-- Backfill: the pre-existing single-user-mode "local owner" row always gets
-- full access, unchanged from its pre-RBAC behavior. Every other existing
-- (OIDC) user row keeps the 'viewer' column default above — the safe
-- fallback — and gets its role recomputed from its OIDC groups on next login.
UPDATE `users` SET `role` = 'admin' WHERE `is_local_owner` = 1;