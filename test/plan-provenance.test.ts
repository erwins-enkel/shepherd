import { describe, expect, test } from "bun:test";
import {
  agentPlanChanges,
  operatorEditsBetween,
  operatorEditsReviewerBlock,
  planProvenance,
  planProvenanceCriticBlock,
  standingOperatorEdits,
} from "../src/plan-provenance";
import type { OperatorPassage, PlanEdit, PlanRevision } from "../src/types";

const rev = (
  revision: number,
  author: PlanRevision["author"],
  plan: string,
  edits: PlanEdit[] = [],
): PlanRevision => ({
  sessionId: "s1",
  revision,
  author,
  planHash: `h${revision}`,
  plan,
  edits,
  createdAt: 1000 + revision,
});
const replace = (id: string, before: string, after: string, reason?: string): PlanEdit => ({
  id,
  kind: "replace",
  section: "Approach",
  before,
  after,
  ...(reason ? { reason } : {}),
});
const passage = (over: Partial<OperatorPassage> = {}): OperatorPassage => ({
  ...replace("e1", "old text", "new text"),
  revision: 2,
  createdAt: 1002,
  inPlan: true,
  ...over,
});

describe("standingOperatorEdits", () => {
  test("carries revision and date, and ignores agent revisions", () => {
    const revisions = [
      rev(1, "agent", "A"),
      rev(2, "operator", "B", [replace("e1", "A", "B")]),
      rev(3, "agent", "B and more"),
    ];
    expect(standingOperatorEdits(revisions, "B and more")).toEqual([
      { ...replace("e1", "A", "B"), revision: 2, createdAt: 1002, inPlan: true },
    ]);
  });

  test("text the agent reverted stays listed, not in the plan", () => {
    const revisions = [rev(2, "operator", "B", [replace("e1", "A", "B")])];
    expect(standingOperatorEdits(revisions, "A")[0]?.inPlan).toBe(false);
  });

  test("a delete and a comment always read as in the plan", () => {
    const edits: PlanEdit[] = [
      { id: "d", kind: "delete", section: "", before: "gone", after: "" },
      { id: "c", kind: "comment", section: "", before: "here", after: "", reason: "why" },
    ];
    const standing = standingOperatorEdits([rev(2, "operator", "x", edits)], "gone again");
    expect(standing.map((p) => p.inPlan)).toEqual([true, true]);
  });

  test("a later operator edit of the same text supersedes the earlier one", () => {
    const revisions = [
      rev(2, "operator", "B", [replace("e1", "A", "B")]),
      rev(3, "operator", "C", [replace("e2", "B", "C")]),
    ];
    expect(standingOperatorEdits(revisions, "C").map((p) => p.id)).toEqual(["e2"]);
  });

  test("a later edit quoting the same words elsewhere supersedes nothing", () => {
    const revisions = [
      rev(2, "operator", "Timeouts: 60s\nRetry after 60s on failure", [
        replace("timeout", "30s", "60s"),
      ]),
      rev(3, "operator", "Timeouts: 60s\nNo retries", [
        replace("retry", "Retry after 60s on failure", "No retries"),
      ]),
    ];
    const standing = standingOperatorEdits(revisions, "Timeouts: 60s\nNo retries");
    expect(standing.map((p) => p.id)).toEqual(["timeout", "retry"]);
    expect(standing[0]?.inPlan).toBe(true);
  });

  test("identical befores at different places both stand", () => {
    const revisions = [
      rev(2, "operator", "a 60s\nb 30s", [replace("first", "30s", "60s")]),
      rev(3, "operator", "a 60s\nb 45s", [replace("second", "30s", "45s")]),
    ];
    expect(standingOperatorEdits(revisions, "a 60s\nb 45s").map((p) => p.id)).toEqual([
      "first",
      "second",
    ]);
  });

  test("an unrelated operator edit on top of an agent revert supersedes nothing", () => {
    const revisions = [
      rev(2, "operator", "B\nC", [replace("kept", "A", "B")]),
      rev(3, "agent", "A\nC"),
      rev(4, "operator", "A\nD", [replace("other", "C", "D")]),
    ];
    const standing = standingOperatorEdits(revisions, "A\nD");
    expect(standing.map((p) => [p.id, p.inPlan])).toEqual([
      ["kept", false],
      ["other", true],
    ]);
  });

  test("a deletion stands until the operator writes the text again", () => {
    const del: PlanEdit = { id: "d", kind: "delete", section: "", before: "gone", after: "" };
    const put: PlanEdit = { id: "i", kind: "insert", section: "", before: "", after: "gone back" };
    const deleted = [rev(2, "operator", "x", [del])];
    expect(standingOperatorEdits(deleted, "x").map((p) => p.id)).toEqual(["d"]);
    const restored = [...deleted, rev(3, "operator", "x gone back", [put])];
    expect(standingOperatorEdits(restored, "x gone back").map((p) => p.id)).toEqual(["i"]);
  });

  test("the deleted words written under another heading take nothing back", () => {
    const del: PlanEdit = {
      id: "d",
      kind: "delete",
      section: "Retries",
      before: "optional",
      after: "",
    };
    const put: PlanEdit = {
      id: "i",
      kind: "insert",
      section: "Telemetry",
      before: "",
      after: "Telemetry is optional.",
    };
    const plan = "The retry step\nTelemetry is optional.";
    const revisions = [
      rev(2, "operator", "The retry step", [del]),
      rev(3, "operator", plan, [put]),
    ];
    expect(standingOperatorEdits(revisions, plan).map((p) => p.id)).toEqual(["d", "i"]);
    // The same words back in the deletion's own section do.
    const restored = [
      revisions[0]!,
      rev(3, "operator", "The optional retry step", [{ ...put, section: "Retries" }]),
    ];
    expect(standingOperatorEdits(restored, "The optional retry step").map((p) => p.id)).toEqual([
      "i",
    ]);
  });

  test("edits of the same revision and later comments supersede nothing", () => {
    const comment: PlanEdit = {
      id: "c",
      kind: "comment",
      section: "",
      before: "B",
      after: "",
      reason: "why",
    };
    const revisions = [
      rev(2, "operator", "B C", [replace("e1", "A", "B"), replace("e2", "B x", "C")]),
      rev(3, "operator", "B C", [comment]),
    ];
    expect(standingOperatorEdits(revisions, "B C").map((p) => p.id)).toEqual(["e1", "e2", "c"]);
  });
});

describe("operatorEditsBetween", () => {
  test("takes the operator revisions in the range, oldest first", () => {
    const revisions = [
      rev(1, "operator", "a", [replace("e1", "x", "a")]),
      rev(2, "operator", "b", [replace("e2", "a", "b")]),
      rev(3, "agent", "c"),
      rev(4, "operator", "d", [replace("e4", "c", "d")]),
      rev(5, "operator", "e", [replace("e5", "d", "e")]),
    ];
    expect(operatorEditsBetween(revisions, 2, 4).map((e) => e.id)).toEqual(["e2", "e4"]);
  });
});

describe("agentPlanChanges", () => {
  test("lists only what changed since the last operator revision", () => {
    const revisions = [
      rev(1, "agent", "gone\nkeep"),
      rev(2, "operator", "keep\nop\nold", [replace("e1", "gone", "op")]),
    ];
    expect(agentPlanChanges(revisions, "keep\nop\nnew\n\n")).toEqual({
      removed: ["old"],
      added: ["new"],
    });
  });

  test("counts repeated lines", () => {
    const revisions = [rev(2, "operator", "x", [])];
    expect(agentPlanChanges(revisions, "x\nx").added).toEqual(["x"]);
  });

  test("empty without an operator revision", () => {
    expect(agentPlanChanges([rev(1, "agent", "A")], "B")).toEqual({ removed: [], added: [] });
  });
});

describe("planProvenance", () => {
  test("null without operator edits", () => {
    expect(planProvenance([rev(1, "agent", "A")], "A", null)).toBeNull();
  });
});

describe("operatorEditsReviewerBlock", () => {
  test("empty without passages", () => {
    expect(operatorEditsReviewerBlock([])).toEqual([]);
  });

  test("keeps the rules outside the fence and the passages inside it", () => {
    const block = operatorEditsReviewerBlock([
      passage({ reason: "because" }),
      passage({ id: "e2", inPlan: false, after: "reverted" }),
    ]).join("\n");
    const fenceStart = block.indexOf("⟦UNTRUSTED:operator edits");
    expect(block.startsWith("OPERATOR EDITS (binding)")).toBe(true);
    expect(block.indexOf("Do NOT report an operator entry")).toBeLessThan(fenceStart);
    expect(block.indexOf("Report only a CONTRADICTION")).toBeLessThan(fenceStart);
    expect(block.indexOf("[replace · revision 2 · origin: operator] Approach")).toBeGreaterThan(
      fenceStart,
    );
    expect(block).toContain("- old text\n+ new text\nwhy: because");
    expect(block).toContain("[replace · revision 2 · origin: operator NOT FOUND VERBATIM]");
  });

  test("names the drop rule only on a re-review", () => {
    const rule = "A prior point below that asks to change";
    expect(operatorEditsReviewerBlock([passage()]).join("\n")).not.toContain(rule);
    expect(operatorEditsReviewerBlock([passage()], { priorFindings: true }).join("\n")).toContain(
      rule,
    );
  });

  test("labels a comment's text as the note", () => {
    const block = operatorEditsReviewerBlock([
      passage({ kind: "comment", before: "here", after: "", reason: "tighten" }),
    ]).join("\n");
    expect(block).toContain("- here\nnote: tighten");
  });

  test("bounds itself: long sides are clipped, the oldest entries give way", () => {
    const long = "x".repeat(5000);
    const clipped = operatorEditsReviewerBlock([passage({ after: long })]).join("\n");
    expect(clipped).toContain("[… 3800 chars elided …]");
    const many = Array.from({ length: 40 }, (_, i) =>
      passage({ id: `e${i}`, section: `S${i}`, before: long, after: long }),
    );
    const block = operatorEditsReviewerBlock(many).join("\n");
    expect(block).toContain("older entries were omitted");
    expect(block).toContain("S39");
    expect(block).not.toContain("origin: operator] S0\n");
    expect(block.length).toBeLessThan(20_000);
  });
});

describe("planProvenanceCriticBlock", () => {
  const changes = { removed: ["old"], added: ["new"] };

  test("empty without provenance", () => {
    expect(planProvenanceCriticBlock(null)).toEqual([]);
  });

  test("separates operator entries from agent changes", () => {
    const block = planProvenanceCriticBlock({
      passages: [passage()],
      agentChanges: changes,
      operatorReleasedRevision: null,
    }).join("\n");
    const operatorFence = block.indexOf("⟦UNTRUSTED:operator edits");
    const agentFence = block.indexOf("⟦UNTRUSTED:agent plan changes");
    expect(operatorFence).toBeGreaterThan(-1);
    expect(agentFence).toBeGreaterThan(operatorFence);
    expect(block.indexOf("origin: operator] Approach")).toBeGreaterThan(operatorFence);
    expect(block.indexOf("origin: operator] Approach")).toBeLessThan(agentFence);
    expect(block.indexOf("- old\n+ new")).toBeGreaterThan(agentFence);
    expect(block).toContain("they ARE authorized");
    expect(block).toContain("carries no operator authority");
    expect(block).toContain("does NOT excuse a bug");
    expect(block).not.toContain("The operator released revision");
  });

  test("says which revision no reviewer saw", () => {
    const block = planProvenanceCriticBlock({
      passages: [passage()],
      agentChanges: { removed: [], added: [] },
      operatorReleasedRevision: 2,
    }).join("\n");
    expect(block).toContain("The operator released revision 2 directly");
    expect(block).not.toContain("agent plan changes");
  });

  test("bounds the agent changes", () => {
    const added = Array.from({ length: 200 }, (_, i) => `line ${i} ${"y".repeat(100)}`);
    const block = planProvenanceCriticBlock({
      passages: [passage()],
      agentChanges: { removed: [], added },
      operatorReleasedRevision: null,
    }).join("\n");
    expect(block).toContain("line changes were omitted");
    expect(block).toContain("line 0 ");
    expect(block).not.toContain("line 199 ");
  });
});
