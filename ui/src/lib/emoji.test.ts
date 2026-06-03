import { describe, it, expect } from "vitest";
import { EMOJI, isSingleEmoji, searchEmoji } from "./emoji";

describe("emoji helpers", () => {
  it("ships a non-trivial curated set", () => {
    expect(EMOJI.length).toBeGreaterThan(100);
    expect(EMOJI.every((e) => typeof e.char === "string" && e.char.length > 0)).toBe(true);
  });

  it("has no duplicate chars (picker keys the grid by char)", () => {
    const chars = EMOJI.map((e) => e.char);
    expect(new Set(chars).size).toBe(chars.length);
  });

  it("isSingleEmoji accepts a single emoji incl. ZWJ sequences", () => {
    expect(isSingleEmoji("📦")).toBe(true);
    expect(isSingleEmoji("👩‍💻")).toBe(true);
  });

  it("isSingleEmoji rejects empty, plain ascii, control chars and overlong input", () => {
    expect(isSingleEmoji("")).toBe(false);
    expect(isSingleEmoji("  ")).toBe(false);
    expect(isSingleEmoji("ab")).toBe(false);
    expect(isSingleEmoji("x")).toBe(false);
    expect(isSingleEmoji("📦📦📦📦📦")).toBe(false); // > 8 code points
  });

  it("searchEmoji filters by keyword, returns all on empty query", () => {
    expect(searchEmoji("").length).toBe(EMOJI.length);
    const rocket = searchEmoji("rocket");
    expect(rocket.some((e) => e.char === "🚀")).toBe(true);
  });

  it("searchEmoji ranks exact/prefix matches above mid-substring matches", () => {
    const r = searchEmoji("lock").map((e) => e.char);
    expect(r[0]).toBe("🔐"); // exact word "lock"
    // "locked" (prefix) outranks "unlocked" (mid-substring)
    expect(r.indexOf("🔒")).toBeLessThan(r.indexOf("🔓"));
  });
});
