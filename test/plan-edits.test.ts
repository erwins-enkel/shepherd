import { describe, expect, test } from "bun:test";
import { checkPlanEdits, parsePlanEditsRequest, planEditSteerText } from "../src/plan-gate";
import type { PlanEdit } from "../src/types";

const replace: PlanEdit = {
  id: "e1",
  kind: "replace",
  section: "Approach",
  before: "Use a new table.",
  after: "Reuse the column.",
  reason: "Less migration risk",
};
const comment: PlanEdit = {
  id: "c1",
  kind: "comment",
  section: "Risks",
  before: "Races are rare.",
  after: "",
  reason: "Name the race.",
};
const body = (over: Record<string, unknown> = {}) => ({
  baseHash: "h",
  plan: "# Plan\nReuse the column.\n",
  edits: [replace],
  ...over,
});

describe("parsePlanEditsRequest", () => {
  test("accepts a well-formed body, defaulting before/after and dropping a blank reason", () => {
    const out = parsePlanEditsRequest(
      body({
        mode: "resubmit",
        edits: [{ id: "i1", kind: "insert", section: "", after: "New line", reason: "  " }],
      }),
    );
    expect(out).toEqual({
      baseHash: "h",
      plan: "# Plan\nReuse the column.\n",
      edits: [{ id: "i1", kind: "insert", section: "", before: "", after: "New line" }],
    });
  });

  test.each([
    ["not an object", "nope"],
    ["missing baseHash", body({ baseHash: undefined })],
    ["blank plan", body({ plan: "  \n" })],
    ["unknown mode", body({ mode: "go" })],
    ["empty edits", body({ edits: [] })],
    ["edit without id", body({ edits: [{ ...replace, id: "" }] })],
    ["unknown kind", body({ edits: [{ ...replace, kind: "move" }] })],
    ["section not a string", body({ edits: [{ ...replace, section: 3 }] })],
    ["non-string reason", body({ edits: [{ ...replace, reason: 1 }] })],
    ["duplicate ids", body({ edits: [replace, { ...replace }] })],
    ["replace with no change", body({ edits: [{ ...replace, after: replace.before }] })],
    ["insert with a before", body({ edits: [{ ...replace, kind: "insert" }] })],
    ["delete with an after", body({ edits: [{ ...replace, kind: "delete" }] })],
    ["comment without a note", body({ edits: [{ ...comment, reason: undefined }] })],
    ["comment with an after", body({ edits: [{ ...comment, after: "x" }] })],
  ])("rejects %s", (_, raw) => {
    expect(parsePlanEditsRequest(raw)).toHaveProperty("error");
  });
});

describe("checkPlanEdits", () => {
  const current = "# Plan\nUse a new table.\n\n## Risks\nRaces are rare.\n";
  const next = "# Plan\nReuse the column.\n\n## Risks\nRaces are rare.\n";

  test("accepts edits that describe the change, and comments on an unchanged plan", () => {
    expect(checkPlanEdits(current, next, [replace, comment])).toBeNull();
    expect(checkPlanEdits(current, `${current}\n`, [comment])).toBeNull();
  });

  test("a changed plan needs a text edit, and text edits need a changed plan", () => {
    expect(checkPlanEdits(current, next, [comment])).toEqual({
      editId: null,
      error: expect.any(String),
    });
    expect(checkPlanEdits(current, current, [replace])?.editId).toBeNull();
  });

  test("names the edit whose before or after is not where it should be", () => {
    expect(checkPlanEdits(current, next, [{ ...replace, before: "Not there." }])?.editId).toBe(
      "e1",
    );
    expect(checkPlanEdits(current, next, [{ ...replace, after: "Not there." }])?.editId).toBe("e1");
    expect(checkPlanEdits(current, next, [replace, { ...comment, before: "Gone." }])?.editId).toBe(
      "c1",
    );
  });
});

describe("planEditSteerText", () => {
  const edits: PlanEdit[] = [
    replace,
    comment,
    { id: "d1", kind: "delete", section: "", before: "Line one\n\nLine two", after: "" },
  ];

  test("carries every edit, comment and reason as binding operator decisions", () => {
    const text = planEditSteerText({ from: 2, to: 3, edits, executing: false });
    expect(text).toStartWith(
      "The operator edited `.shepherd-plan.md` directly (revision 2 → 3: 2 edits, 1 comment).",
    );
    expect(text).toContain("These edits are the operator's decisions. Keep them: do not revert");
    expect(text).toContain("Rewrite each commented passage yourself");
    expect(text).toContain("Don't start implementing yet.");
    expect(text).not.toContain("STOP implementing");
    expect(text).toContain(
      "[edit 1] Approach\n- Use a new table.\n+ Reuse the column.\nwhy: Less migration risk",
    );
    expect(text).toContain(
      '[comment 1] on "Races are rare." (Risks)\nName the race.\n→ rewrite this passage yourself.',
    );
    expect(text).toContain("[edit 2]\n- Line one\n-\n- Line two");
  });

  test("fences the edits once, with the instructions outside the fence", () => {
    const text = planEditSteerText({ from: 2, to: 3, edits, executing: false });
    expect(text.match(/⟦UNTRUSTED:operator plan edits:/g)).toHaveLength(1);
    expect(text.indexOf("⟦UNTRUSTED")).toBeGreaterThan(text.indexOf("Don't start implementing"));
  });

  test("an executing session is told to stop implementing", () => {
    const text = planEditSteerText({ from: 4, to: 5, edits: [replace], executing: true });
    expect(text).toContain("(revision 4 → 5: 1 edit)");
    expect(text).toContain("This session was executing: STOP implementing.");
    expect(text).not.toContain("commented passage");
  });

  test("a comment-only edit asks for rewrites and claims no decisions", () => {
    const text = planEditSteerText({ from: 1, to: 2, edits: [comment], executing: false });
    expect(text).toContain("(revision 1 → 2: 1 comment)");
    expect(text).not.toContain("These edits are the operator's decisions");
  });
});
