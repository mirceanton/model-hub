import { describe, expect, it } from "vitest";
import {
  InvalidTagColorError,
  InvalidTagNameError,
  normalizeTagColor,
  normalizeTagName,
  randomTagColor,
} from "./tags.js";

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

describe("normalizeTagColor", () => {
  it("accepts a hex color and lowercases it", () => {
    expect(normalizeTagColor("#3B82F6")).toBe("#3b82f6");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeTagColor("  #3b82f6  ")).toBe("#3b82f6");
  });

  it("rejects a non-hex string", () => {
    expect(() => normalizeTagColor("blue")).toThrow(InvalidTagColorError);
  });

  it("rejects a hex string with the wrong length", () => {
    expect(() => normalizeTagColor("#fff")).toThrow(InvalidTagColorError);
  });

  it("rejects a hex string missing the leading #", () => {
    expect(() => normalizeTagColor("3b82f6")).toThrow(InvalidTagColorError);
  });
});

describe("randomTagColor", () => {
  it("always returns a valid hex color", () => {
    for (let i = 0; i < 20; i++) {
      const color = randomTagColor();
      expect(() => normalizeTagColor(color)).not.toThrow();
    }
  });
});
