import { describe, it, expect } from "vitest";
import type { EpicDraftChild } from "#lib/types.js";
import { childWaves, overlapHints, splitMarkdownSections } from "./epic-draft-outline";

function child(key: string, blockedBy: string[] = []): EpicDraftChild {
  return { key, title: key, body: "", acceptanceCriteria: [], blockedBy };
}

describe("splitMarkdownSections", () => {
  it("splits at # and ## headings and keeps the text before the first one", () => {
    expect(
      splitMarkdownSections("Intro line\n\n## Ziel\n\nGoal **text**\n\n# Decisions\n- a"),
    ).toEqual([
      { title: null, body: "Intro line" },
      { title: "Ziel", body: "Goal **text**" },
      { title: "Decisions", body: "- a" },
    ]);
  });

  it("keeps deeper headings inside their section", () => {
    expect(splitMarkdownSections("## Ziel\n### Detail\ntext")).toEqual([
      { title: "Ziel", body: "### Detail\ntext" },
    ]);
  });

  it("ignores heading-like lines inside fenced code", () => {
    const body = "## Setup\n```sh\n## not a heading\n```\n~~~\n# nor this\n~~~\n## Next\nx";
    expect(splitMarkdownSections(body).map((s) => s.title)).toEqual(["Setup", "Next"]);
    expect(splitMarkdownSections(body)[0].body).toContain("## not a heading");
  });

  it("strips optional closing hashes and keeps an empty titled section", () => {
    expect(splitMarkdownSections("## Ziel ##\n## Leer")).toEqual([
      { title: "Ziel", body: "" },
      { title: "Leer", body: "" },
    ]);
  });

  it("returns one untitled section for a body without headings, none for a blank one", () => {
    expect(splitMarkdownSections("Plain\n\ntext")).toEqual([
      { title: null, body: "Plain\n\ntext" },
    ]);
    expect(splitMarkdownSections("  \n")).toEqual([]);
  });

  it("does not treat #hashtags or #123 references as headings", () => {
    expect(splitMarkdownSections("#123 is blocked\n#tag")).toEqual([
      { title: null, body: "#123 is blocked\n#tag" },
    ]);
  });
});

describe("childWaves", () => {
  it("puts unblocked children in wave 1 and each child one wave after its longest blocker chain", () => {
    const waves = childWaves([
      child("c1"),
      child("c2"),
      child("c3", ["c1"]),
      child("c4", ["c1"]),
      child("c6", ["c2", "c3", "c4"]),
      child("c7", ["c6"]),
    ]);
    expect(Object.fromEntries(waves)).toEqual({ c1: 1, c2: 1, c3: 2, c4: 2, c6: 3, c7: 4 });
  });

  it("does not depend on input order and ignores blockers outside the draft", () => {
    const waves = childWaves([child("late", ["early"]), child("early", ["gone"])]);
    expect(Object.fromEntries(waves)).toEqual({ late: 2, early: 1 });
  });

  it("terminates on a malformed cyclic draft", () => {
    const waves = childWaves([child("a", ["b"]), child("b", ["a"])]);
    expect(waves.size).toBe(2);
  });
});

describe("overlapHints", () => {
  const touching = (key: string, touches: string[], blockedBy: string[] = []): EpicDraftChild => ({
    ...child(key, blockedBy),
    touches,
  });

  it("flags unordered siblings sharing an anchor", () => {
    expect(
      overlapHints([
        touching("c1", []),
        touching("c2", ["ui/messages/*.json", "src/a.ts"], ["c1"]),
        touching("c3", ["./ui/messages/*.json", "src/b.ts"], ["c1"]),
      ]),
    ).toEqual([{ a: "c2", b: "c3", anchors: ["ui/messages/*.json"] }]);
  });

  it("stays quiet when an edge orders the pair, even transitively", () => {
    expect(
      overlapHints([
        touching("c1", ["registry.ts"]),
        touching("c2", [], ["c1"]),
        touching("c3", ["registry.ts"], ["c2"]),
      ]),
    ).toEqual([]);
  });

  it("returns nothing without touches", () => {
    expect(overlapHints([child("c1"), child("c2")])).toEqual([]);
  });
});
