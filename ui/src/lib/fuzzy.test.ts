import { describe, it, expect } from "vitest";
import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("empty query matches everything with score 0 and no positions", () => {
    expect(fuzzyScore("", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "abc")).toBeNull();
  });

  it("respects order — chars must appear in sequence", () => {
    expect(fuzzyScore("ba", "abc")).toBeNull();
  });

  it("matches a contiguous substring and reports its positions", () => {
    expect(fuzzyScore("bc", "abc")).toEqual({ score: expect.any(Number), positions: [1, 2] });
  });

  it("matches a non-contiguous subsequence", () => {
    expect(fuzzyScore("ac", "abc")?.positions).toEqual([0, 2]);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("AB", "ab")?.positions).toEqual([0, 1]);
  });

  it("reports positions against the original text even when lowercasing changes length", () => {
    // "İ".toLowerCase() is two code units ("i̇"), so matching against a lowercased copy would
    // report index 2 for the "x"; against the original text it must be index 1.
    expect(fuzzyScore("x", "İx")?.positions).toEqual([1]);
  });

  it("ranks a prefix match above the same query matched mid-word", () => {
    // "deploy" is a whole-word prefix of "deploy" but starts mid-word in "redeploy".
    const exact = fuzzyScore("deploy", "deploy");
    const mid = fuzzyScore("deploy", "redeploy");
    expect(exact).not.toBeNull();
    expect(mid).not.toBeNull();
    expect(exact!.score).toBeGreaterThan(mid!.score);
  });

  it("rewards a word-boundary match over a mid-word one", () => {
    const boundary = fuzzyScore("h", "hello"); // index 0
    const midWord = fuzzyScore("o", "hello"); // index 4, no separator before
    expect(boundary!.score).toBeGreaterThan(midWord!.score);
  });

  it("rewards a match after a separator as a boundary", () => {
    const afterSep = fuzzyScore("w", "hello-world"); // 'w' preceded by '-'
    const midWord = fuzzyScore("e", "hello"); // 'e' mid-word
    expect(afterSep!.score).toBeGreaterThan(midWord!.score);
  });
});
