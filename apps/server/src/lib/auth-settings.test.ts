import { describe, expect, it } from "vitest";
import {
  InvalidGroupNameError,
  InvalidRoleError,
  normalizeGroupName,
  parseRole,
} from "./auth-settings.js";

describe("normalizeGroupName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeGroupName("  3d-printing-admins  ")).toBe("3d-printing-admins");
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(() => normalizeGroupName("")).toThrow(InvalidGroupNameError);
    expect(() => normalizeGroupName("   ")).toThrow(InvalidGroupNameError);
  });

  it("rejects a name longer than 200 characters", () => {
    expect(() => normalizeGroupName("a".repeat(201))).toThrow(InvalidGroupNameError);
  });

  it("accepts a name at exactly the length limit", () => {
    expect(normalizeGroupName("a".repeat(200))).toBe("a".repeat(200));
  });
});

describe("parseRole", () => {
  it("accepts the three known roles", () => {
    expect(parseRole("admin")).toBe("admin");
    expect(parseRole("editor")).toBe("editor");
    expect(parseRole("viewer")).toBe("viewer");
  });

  it("rejects an unknown role", () => {
    expect(() => parseRole("superadmin")).toThrow(InvalidRoleError);
    expect(() => parseRole("")).toThrow(InvalidRoleError);
  });
});
