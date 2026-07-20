import { describe, it, expect } from "vitest";
import { matchIssueTrigger } from "./issue-trigger";

describe("matchIssueTrigger", () => {
  it("bare # at the start opens with an empty query", () => {
    expect(matchIssueTrigger("#", 1)).toEqual({ query: "", start: 0 });
  });

  it("digits and text after # form the query", () => {
    expect(matchIssueTrigger("#18", 3)).toEqual({ query: "18", start: 0 });
    expect(matchIssueTrigger("#recap", 6)).toEqual({ query: "recap", start: 0 });
  });

  it("triggers mid-prompt after whitespace (incl. newline)", () => {
    expect(matchIssueTrigger("fix #re", 7)).toEqual({ query: "re", start: 4 });
    expect(matchIssueTrigger("ctx\n#18", 7)).toEqual({ query: "18", start: 4 });
  });

  it("does not trigger mid-word (anchors, C# and friends)", () => {
    expect(matchIssueTrigger("a#1", 3)).toBeNull();
    expect(matchIssueTrigger("C#", 2)).toBeNull();
  });

  it("a token-start # in prose still triggers — the plain-text fallback handles it", () => {
    // "#fff" opens the (empty) menu while typing; picking nothing leaves the text
    // as typed, so prose hash-tokens never block typing or submission.
    expect(matchIssueTrigger("color: #fff", 11)).toEqual({ query: "fff", start: 7 });
  });

  it("a space ends the token — earlier # tokens never re-open the menu", () => {
    expect(matchIssueTrigger("#18 now", 7)).toBeNull();
  });

  it("a second # ends the query (## is not a token)", () => {
    expect(matchIssueTrigger("##", 2)).toBeNull();
  });

  it("respects the caret: only text before it counts", () => {
    expect(matchIssueTrigger("#18 tail", 3)).toEqual({ query: "18", start: 0 });
  });
});
