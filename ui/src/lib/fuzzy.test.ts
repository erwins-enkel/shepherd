import { describe, it, expect } from "vitest";
import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("empty query matches everything with score 0 and no positions", () => {
    expect(fuzzyScore("", "anything")).toEqual({
      score: 0,
      positions: [],
      kind: "empty",
      span: 0,
    });
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "abc")).toBeNull();
  });

  it("respects order — chars must appear in sequence", () => {
    expect(fuzzyScore("ba", "abc")).toBeNull();
  });

  it("matches a contiguous substring and reports its positions", () => {
    expect(fuzzyScore("bc", "abc")).toEqual({
      score: expect.any(Number),
      positions: [1, 2],
      kind: "substring",
      span: 2,
    });
  });

  it("matches a non-contiguous subsequence", () => {
    expect(fuzzyScore("ac", "abc")).toMatchObject({
      positions: [0, 2],
      kind: "fuzzy",
      span: 3,
    });
  });

  it("keeps compact fuzzy abbreviations", () => {
    expect(fuzzyScore("nwr", "newer")).toMatchObject({
      positions: [0, 2, 4],
      kind: "fuzzy",
      span: 5,
    });
  });

  it("rejects widely scattered subsequences", () => {
    expect(fuzzyScore("new", "attachment-hover-preview")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("AB", "ab")?.positions).toEqual([0, 1]);
  });

  it("reports positions against the original text even when lowercasing changes length", () => {
    // "İ".toLowerCase() is two code units ("i̇"), so matching against a lowercased copy would
    // report index 2 for the "x"; against the original text it must be index 1.
    expect(fuzzyScore("x", "İx")?.positions).toEqual([1]);
  });

  it("ranks exact, prefix, substring and fuzzy matches in that order", () => {
    const exact = fuzzyScore("new", "new")!;
    const prefix = fuzzyScore("new", "new-task")!;
    const substring = fuzzyScore("new", "renewed")!;
    const fuzzy = fuzzyScore("new", "n-e-w")!;

    expect(exact.kind).toBe("exact");
    expect(prefix.kind).toBe("prefix");
    expect(substring.kind).toBe("substring");
    expect(fuzzy.kind).toBe("fuzzy");
    expect(exact.score).toBeGreaterThan(prefix.score);
    expect(prefix.score).toBeGreaterThan(substring.score);
    expect(substring.score).toBeGreaterThan(fuzzy.score);
  });

  it("ranks a prefix match above the same query matched mid-word", () => {
    const prefix = fuzzyScore("deploy", "deployment");
    const mid = fuzzyScore("deploy", "redeploy");
    expect(prefix).not.toBeNull();
    expect(mid).not.toBeNull();
    expect(prefix!.score).toBeGreaterThan(mid!.score);
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

  it("ranks compact fuzzy spans above wider spans in the same tier", () => {
    const compact = fuzzyScore("abc", "a-b-c");
    const wide = fuzzyScore("abc", "a---b---c");
    expect(compact).not.toBeNull();
    expect(wide).not.toBeNull();
    expect(compact!.kind).toBe("fuzzy");
    expect(wide!.kind).toBe("fuzzy");
    expect(compact!.score).toBeGreaterThan(wide!.score);
  });
});
