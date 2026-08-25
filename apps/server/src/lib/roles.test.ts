import { describe, expect, it } from "vitest";
import { isUserRole, resolveRoleFromGroups, roleSatisfies } from "./roles.js";

describe("isUserRole", () => {
  it("accepts the three known roles", () => {
    expect(isUserRole("admin")).toBe(true);
    expect(isUserRole("editor")).toBe(true);
    expect(isUserRole("viewer")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isUserRole("superadmin")).toBe(false);
    expect(isUserRole("")).toBe(false);
    expect(isUserRole(42)).toBe(false);
    expect(isUserRole(undefined)).toBe(false);
  });
});

describe("roleSatisfies", () => {
  it("admin satisfies every minimum", () => {
    expect(roleSatisfies("admin", "admin")).toBe(true);
    expect(roleSatisfies("admin", "editor")).toBe(true);
    expect(roleSatisfies("admin", "viewer")).toBe(true);
  });

  it("editor satisfies editor and viewer but not admin", () => {
    expect(roleSatisfies("editor", "editor")).toBe(true);
    expect(roleSatisfies("editor", "viewer")).toBe(true);
    expect(roleSatisfies("editor", "admin")).toBe(false);
  });

  it("viewer only satisfies viewer", () => {
    expect(roleSatisfies("viewer", "viewer")).toBe(true);
    expect(roleSatisfies("viewer", "editor")).toBe(false);
    expect(roleSatisfies("viewer", "admin")).toBe(false);
  });
});

describe("resolveRoleFromGroups", () => {
  const mappings = [
    { groupName: "3d-printing-admins", role: "admin" as const },
    { groupName: "3d-printing-editors", role: "editor" as const },
  ];

  it("falls back to defaultRole when the user has no groups", () => {
    expect(resolveRoleFromGroups([], mappings, "viewer")).toBe("viewer");
  });

  it("falls back to defaultRole when none of the user's groups match a mapping", () => {
    expect(resolveRoleFromGroups(["some-other-group"], mappings, "viewer")).toBe("viewer");
  });

  it("never silently falls through to admin: an unmapped group stays at defaultRole", () => {
    expect(resolveRoleFromGroups(["unmapped"], mappings, "editor")).toBe("editor");
  });

  it("resolves to the mapped role for a single matching group", () => {
    expect(resolveRoleFromGroups(["3d-printing-editors"], mappings, "viewer")).toBe("editor");
  });

  it("picks the highest-ranked role when the user belongs to multiple mapped groups", () => {
    const groups = ["3d-printing-editors", "3d-printing-admins"];
    expect(resolveRoleFromGroups(groups, mappings, "viewer")).toBe("admin");
  });

  it("ignores groups with no mapping while still picking up mapped ones", () => {
    const groups = ["unmapped", "3d-printing-editors"];
    expect(resolveRoleFromGroups(groups, mappings, "viewer")).toBe("editor");
  });
});
