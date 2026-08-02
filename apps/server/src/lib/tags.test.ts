import { describe, expect, it } from "vitest";
import { InvalidTagNameError, normalizeTagName } from "./tags.js";

describe("normalizeTagName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeTagName("  brackets  ")).toBe("brackets");
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(() => normalizeTagName("")).toThrow(InvalidTagNameError);
    expect(() => normalizeTagName("   ")).toThrow(InvalidTagNameError);
  });

  it("rejects a name longer than 50 characters", () => {
    expect(() => normalizeTagName("a".repeat(51))).toThrow(InvalidTagNameError);
  });

  it("accepts a name at exactly the length limit", () => {
    expect(normalizeTagName("a".repeat(50))).toBe("a".repeat(50));
  });
});
