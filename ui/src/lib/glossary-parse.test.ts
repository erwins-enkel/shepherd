import { describe, it, expect } from "vitest";
import { parseGlossary } from "./glossary-parse";

describe("parseGlossary", () => {
  it("plain text with no markers → single text segment", () => {
    expect(parseGlossary("just plain text")).toEqual([{ t: "text", value: "just plain text" }]);
  });

  it("one marker in the middle → text / term / text split", () => {
    expect(parseGlossary("before [[epic|Epic]] after")).toEqual([
      { t: "text", value: "before " },
      { t: "term", id: "epic", label: "Epic" },
      { t: "text", value: " after" },
    ]);
  });

  it("multiple markers → correct interleaving", () => {
    expect(parseGlossary("run [[ci|CI]] and open a [[pr|PR]]")).toEqual([
      { t: "text", value: "run " },
      { t: "term", id: "ci", label: "CI" },
      { t: "text", value: " and open a " },
      { t: "term", id: "pr", label: "PR" },
    ]);
  });

  it("adjacent markers (no text between) → two consecutive term segments", () => {
    expect(parseGlossary("[[epic|Epic]][[ci|CI]]")).toEqual([
      { t: "term", id: "epic", label: "Epic" },
      { t: "term", id: "ci", label: "CI" },
    ]);
  });

  it("marker with a multi-word label → label preserved", () => {
    expect(parseGlossary("see the [[critic|Critic Agent]] for details")).toEqual([
      { t: "text", value: "see the " },
      { t: "term", id: "critic", label: "Critic Agent" },
      { t: "text", value: " for details" },
    ]);
  });

  it("unknown id → emitted as plain text with label as value", () => {
    expect(parseGlossary("this is a [[nonexistent-term|Unknown Thing]]")).toEqual([
      { t: "text", value: "this is a " },
      { t: "text", value: "Unknown Thing" },
    ]);
  });

  it("surrounding whitespace and punctuation preserved", () => {
    expect(parseGlossary("  [[pr|PR]],  ")).toEqual([
      { t: "text", value: "  " },
      { t: "term", id: "pr", label: "PR" },
      { t: "text", value: ",  " },
    ]);
  });
});
