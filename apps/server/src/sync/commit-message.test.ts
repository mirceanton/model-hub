import { describe, expect, it } from "vitest";
import { generateAutoCommitMessage } from "./commit-message.js";

describe("generateAutoCommitMessage", () => {
  it("returns a generic message when no paths are given", () => {
    expect(generateAutoCommitMessage([])).toBe("Synced external changes");
  });

  it("lists changed paths when there are few", () => {
    expect(generateAutoCommitMessage(["a.stl", "b.3mf"])).toBe(
      "Synced external changes: a.stl, b.3mf",
    );
  });

  it("truncates and summarizes when there are many changed paths", () => {
    const paths = ["a", "b", "c", "d", "e", "f", "g"];
    expect(generateAutoCommitMessage(paths)).toBe(
      "Synced external changes: a, b, c, d, e, and 2 more",
    );
  });
});
