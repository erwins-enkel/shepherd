import { describe, it, expect } from "vitest";
import { planOutline, splitReviewerNotes } from "./plan-outline";

describe("planOutline", () => {
  it("takes a leading # heading as the title and splits the rest at its sections", () => {
    const out = planOutline("\n# Plan: Mythos\n\n## Goal\nShip it.\n\n## Risks\n- r");
    expect(out.title).toBe("Plan: Mythos");
    expect(out.sections.map((s) => s.title)).toEqual(["Goal", "Risks"]);
    expect(out.sections[0].body).toBe("Ship it.");
  });

  it("has no title when the first line is not a # heading", () => {
    expect(planOutline("Intro\n# Later").title).toBeNull();
    expect(planOutline("## Goal\nx").title).toBeNull();
    expect(planOutline("").title).toBeNull();
  });

  it("lists a section's top-level numbered steps, labelled by their bold lead", () => {
    const [steps] = planOutline(
      "## Steps\n1. **Server detection** module and tests.\n2. Contract and `clients`.\n   1. nested, ignored\n\n3) Docs",
    ).sections;
    expect(steps.steps).toEqual([
      { kind: "item", label: "Server detection", index: 0, number: 1 },
      { kind: "item", label: "Contract and clients.", index: 1, number: 2 },
      { kind: "item", label: "Docs", index: 2, number: 3 },
    ]);
  });

  it("prefers ### headings over numbered steps", () => {
    const [s] = planOutline(
      "## Approach\n### Server\n1. **a**\n### 2. API (`contracts/openapi.yaml`)\n2. b",
    ).sections;
    expect(s.steps).toEqual([
      { kind: "heading", label: "Server", index: 0, number: null },
      { kind: "heading", label: "2. API (contracts/openapi.yaml)", index: 1, number: null },
    ]);
  });

  it("ignores headings and numbers inside fenced code", () => {
    const [s] = planOutline("## Setup\n```md\n### not\n1. not\n```\n1. real").sections;
    expect(s.steps.map((x) => x.label)).toEqual(["real"]);
  });

  it("keeps snake_case identifiers and drops link markup in labels", () => {
    const [s] = planOutline(
      "## Steps\n1. Rename `plan_gates` per [the spec](https://x.y)",
    ).sections;
    expect(s.steps[0].label).toBe("Rename plan_gates per the spec");
  });
});

describe("splitReviewerNotes", () => {
  const verdict = [
    "## Verdict",
    "The plan holds.",
    "",
    "Suggestions (non-blocking):",
    "- First `note`.",
    "- Second note that",
    "  wraps onto a second line.",
    "",
    "Anchor staleness (informational, non-blocking): two files moved.",
  ].join("\n");

  it("pulls the suggestion items out and leaves the rest of the write-up", () => {
    expect(splitReviewerNotes(verdict)).toEqual({
      notes: ["First `note`.", "Second note that wraps onto a second line."],
      rest: "## Verdict\nThe plan holds.\n\nAnchor staleness (informational, non-blocking): two files moved.",
    });
  });

  it("accepts the heading, bold and German forms of the section header", () => {
    for (const head of [
      "## Suggestions (non-blocking):",
      "**Suggestions (non-blocking):**",
      "**Suggestions (non-blocking)**:",
      "Vorschläge (nicht blockierend):",
    ])
      expect(splitReviewerNotes(`Ok.\n\n${head}\n1. one\n2. two`).notes).toEqual(["one", "two"]);
  });

  it("reads a loose list across blank lines and stops at the next prose", () => {
    const out = splitReviewerNotes("Suggestions (non-blocking):\n\n- a\n\n- b\n\nClosing words.");
    expect(out.notes).toEqual(["a", "b"]);
    expect(out.rest).toBe("Closing words.");
  });

  it("returns the body whole when there is no section, or it is prose", () => {
    expect(splitReviewerNotes("All good.")).toEqual({ notes: [], rest: "All good." });
    const prose = "Ok.\n\nSuggestions (non-blocking):\nNone worth raising.";
    expect(splitReviewerNotes(prose)).toEqual({ notes: [], rest: prose });
  });

  it("ignores a header line inside fenced code", () => {
    const body = "```\nSuggestions (non-blocking):\n- x\n```";
    expect(splitReviewerNotes(body)).toEqual({ notes: [], rest: body });
  });
});
