import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEpicBody } from "../src/epic-parse";
import { EPIC_SHAPE_CONTRACT } from "../src/service";

const FENCED = [
  "intro",
  "```epic-dag",
  "#320",
  "#326",
  "#321 <- #326",
  "#322 <- #320",
  "#325 <- #320, #322",
  "#323 <- #320, #321, #322",
  "```",
  "- [ ] #320 EFI",
].join("\n");

describe("parseEpicBody", () => {
  test("fenced → members in order + edges", () => {
    const r = parseEpicBody(FENCED);
    expect(r.members).toEqual([320, 326, 321, 322, 325, 323]);
    expect(r.order).toEqual([320, 326, 321, 322, 325, 323]);
    expect(r.edges).toContainEqual({ dependent: 323, blocker: 320 });
    expect(r.edges.filter((e) => e.dependent === 325)).toEqual([
      { dependent: 325, blocker: 320 },
      { dependent: 325, blocker: 322 },
    ]);
  });
  test("checklist only → members, no edges", () => {
    const r = parseEpicBody("- [ ] #10 a\n- [x] #11 b\n");
    expect(r.members).toEqual([10, 11]);
    expect(r.edges).toEqual([]);
  });
  test("no structure → empty", () =>
    expect(parseEpicBody("prose")).toEqual({ members: [], order: [], edges: [] }));

  // A node listed on multiple `<-` lines to express several blockers (`#709 <- #707` then
  // `#709 <- #708`) must count as ONE member — a duplicate `order` entry flows into a
  // duplicate epic child and throws each_key_duplicate in EpicPanel's keyed {#each}.
  test("fenced multi-line blockers → member once, edges unioned", () => {
    const r = parseEpicBody(
      ["```epic-dag", "#707", "#708", "#709 <- #707", "#709 <- #708", "```"].join("\n"),
    );
    expect(r.members).toEqual([707, 708, 709]);
    expect(r.order).toEqual([707, 708, 709]);
    expect(r.edges).toEqual([
      { dependent: 709, blocker: 707 },
      { dependent: 709, blocker: 708 },
    ]);
  });

  test("checklist with a repeated member → member once", () => {
    const r = parseEpicBody("- [ ] #10 a\n- [ ] #11 b\n- [x] #10 a again\n");
    expect(r.members).toEqual([10, 11]);
    expect(r.order).toEqual([10, 11]);
  });
});

// #1391 — the injected epic-shape contract's embedded examples are the SOURCE OF TRUTH for the
// marker grammar this parser reads (same precedent as parseManualSteps(MANUAL_STEPS_NOTICE)).
// These pins fail if a wording edit ever breaks the taught grammar — e.g. replacing the literal
// digits with a `#<n>` placeholder line, which LINE_RE/CHECK_RE cannot parse.
describe("EPIC_SHAPE_CONTRACT stays parseable by parseEpicBody", () => {
  test("the embedded epic-dag fence example parses to its literal members + edge", () => {
    // The fence takes precedence over any checklist-shaped text in the same string, so the
    // contract as a whole parses to exactly the fence example.
    const r = parseEpicBody(EPIC_SHAPE_CONTRACT);
    expect(r.members).toEqual([12, 13]);
    expect(r.order).toEqual([12, 13]);
    expect(r.edges).toEqual([{ dependent: 13, blocker: 12 }]);
  });
  test("the taught checklist example is present verbatim and parses standalone", () => {
    expect(EPIC_SHAPE_CONTRACT).toContain("- [ ] #12");
    expect(parseEpicBody("- [ ] #12")).toEqual({ members: [12], order: [12], edges: [] });
  });
});

// #1393 — the shepherd-epic-authoring skill's canonical fence example is likewise a taught
// grammar this parser must accept. FENCE_RE is non-global (only the FIRST fence in a body
// parses), so the skill must carry exactly one fence — a second example would be silently
// unpinned and could drift into an unparseable shape without failing anything.
describe("shepherd-epic-authoring SKILL.md stays parseable by parseEpicBody", () => {
  const skill = readFileSync(
    join(import.meta.dir, "../.claude/skills/shepherd-epic-authoring/SKILL.md"),
    "utf8",
  );
  test("carries exactly one epic-dag fence", () => {
    expect(skill.split("```epic-dag").length - 1).toBe(1);
  });
  test("the canonical fence example parses to its literal members + edges", () => {
    const r = parseEpicBody(skill);
    expect(r.members).toEqual([12, 13, 14]);
    expect(r.order).toEqual([12, 13, 14]);
    expect(r.edges).toEqual([
      { dependent: 13, blocker: 12 },
      { dependent: 14, blocker: 12 },
      { dependent: 14, blocker: 13 },
    ]);
  });
  test("the taught checklist example is present verbatim and parses standalone", () => {
    expect(skill).toContain("- [ ] #12");
    expect(parseEpicBody("- [ ] #12")).toEqual({ members: [12], order: [12], edges: [] });
  });
});
