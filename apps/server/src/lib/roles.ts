import type { UserRole } from "@model-hub/shared";

const ALL_ROLES: UserRole[] = ["admin", "editor", "viewer"];

// Higher number = more access. admin > editor > viewer.
const ROLE_RANK: Record<UserRole, number> = { viewer: 0, editor: 1, admin: 2 };

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (ALL_ROLES as string[]).includes(value);
}

/** True when `role` grants at least as much access as `minimumRole`. */
export function roleSatisfies(role: UserRole, minimumRole: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimumRole];
}

/**
 * Picks the highest-ranked role among the OIDC groups a user belongs to. A
 * user with no matching group mapping gets `defaultRole` (recommended:
 * "viewer") rather than silently falling through to admin.
 */
export function resolveRoleFromGroups(
  groups: readonly string[],
  mappings: readonly { groupName: string; role: UserRole }[],
  defaultRole: UserRole,
): UserRole {
  const roleByGroup = new Map(mappings.map((m) => [m.groupName, m.role]));

  let resolved: UserRole = defaultRole;
  for (const group of groups) {
    const mapped = roleByGroup.get(group);
    if (mapped && ROLE_RANK[mapped] > ROLE_RANK[resolved]) {
      resolved = mapped;
    }
  }
  return resolved;
}
