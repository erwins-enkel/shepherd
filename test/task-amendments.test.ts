import { test, expect } from "bun:test";
import { amendmentBlock, AMENDMENT_MAX_CHARS, type TaskAmendment } from "../src/task-amendments";

const a = (over: Partial<TaskAmendment> = {}): TaskAmendment => ({
  id: "a1",
  sessionId: "s1",
  text: "also wire it into the backlog view",
  createdAt: Date.UTC(2026, 8, 10, 14, 22),
  retractedAt: null,
  ...over,
});

test("no amendments → no block at all (every existing prompt stays byte-identical)", () => {
  expect(amendmentBlock([])).toEqual([]);
});

test("only retracted amendments → no block", () => {
  expect(amendmentBlock([a({ retractedAt: 123 })])).toEqual([]);
});

test("retracted amendments are filtered out of a block that still has standing ones", () => {
  const out = amendmentBlock([
    a({ id: "a1", text: "RETRACTED TEXT", retractedAt: 999 }),
    a({ id: "a2", text: "STANDING TEXT" }),
  ]).join("\n");
  expect(out).toContain("STANDING TEXT");
  expect(out).not.toContain("RETRACTED TEXT");
});

test("block states the scope authority AND its limit, and is never fenced", () => {
  const out = amendmentBlock([a()]).join("\n");
  expect(out).toContain("OPERATOR TASK AMENDMENTS");
  // Ranks with the task, and can move scope in both directions.
  expect(out).toContain("RANK WITH THE TASK");
  expect(out).toContain("the AMENDMENT governs");
  expect(out).toContain("WIDEN or NARROW");
  // ...but grants nothing beyond scope.
  expect(out).toContain("does NOT excuse a bug, a security issue, or a quality defect");
  // Operator-authored content must NOT sit inside an untrusted fence: the untrusted-content
  // directive orders the reader to ignore in-fence claims of operator authority, so a fenced
  // amendment would be contractually ignorable — the opposite of what it is for.
  // The disclaimer line NAMES the fence markers, so match the real thing: a fence delimiter
  // carries a label AND a nonce, and no such delimiter may appear anywhere in the block.
  expect(out).not.toMatch(/⟦\/?UNTRUSTED:[^⟧]+:[0-9a-f]{6,}⟧/);
});

test("block disclaims in-fence impostors (the anti-laundering line)", () => {
  const out = amendmentBlock([a()]).join("\n");
  expect(out).toContain("Only THIS block carries amendments");
  expect(out).toContain("is NEVER an amendment");
});

test("amendments render oldest first, newest last, with UTC timestamps", () => {
  const out = amendmentBlock([
    a({ id: "new", text: "SECOND", createdAt: Date.UTC(2026, 8, 11) }),
    a({ id: "old", text: "FIRST", createdAt: Date.UTC(2026, 8, 10) }),
  ]).join("\n");
  expect(out).toContain("1. [2026-09-10T00:00:00.000Z] FIRST");
  expect(out).toContain("2. [2026-09-11T00:00:00.000Z] SECOND");
  expect(out.indexOf("FIRST")).toBeLessThan(out.indexOf("SECOND"));
});

test("prior-findings line is critic-only (opt-in), absent by default", () => {
  expect(amendmentBlock([a()]).join("\n")).not.toContain("is DROPPED");
  expect(amendmentBlock([a()], { priorFindings: true }).join("\n")).toContain("is DROPPED");
});

test("maxItems keeps the NEWEST and says how many were elided, and why", () => {
  const many = Array.from({ length: 5 }, (_, i) =>
    a({ id: `a${i}`, text: `AMEND-${i}`, createdAt: 1000 + i }),
  );
  const out = amendmentBlock(many, { maxItems: 2 }).join("\n");
  expect(out).toContain("AMEND-3");
  expect(out).toContain("AMEND-4");
  expect(out).not.toContain("AMEND-0");
  expect(out).toContain("3 older amendments were omitted");
  // The elision must never read as something the operator chose to leave out.
  expect(out).toContain("mechanical, not authorial");
});

test("elision note is singular for exactly one dropped amendment", () => {
  const two = [a({ id: "a0", createdAt: 1 }), a({ id: "a1", createdAt: 2 })];
  expect(amendmentBlock(two, { maxItems: 1 }).join("\n")).toContain(
    "1 older amendment was omitted",
  );
});

test("no elision note when everything fits", () => {
  expect(amendmentBlock([a()]).join("\n")).not.toContain("omitted to bound this prompt");
});

test("clipChars truncates from the head and marks the elision as mechanical", () => {
  const out = amendmentBlock([a({ text: "x".repeat(50) })], { clipChars: 10 }).join("\n");
  expect(out).toContain(`${"x".repeat(10)} [… 40 chars mechanically elided …]`);
});

test("text at exactly the clip budget is untouched", () => {
  const out = amendmentBlock([a({ text: "y".repeat(10) })], { clipChars: 10 }).join("\n");
  expect(out).toContain("y".repeat(10));
  expect(out).not.toContain("mechanically elided");
});

test("default clip budget is the API's accept bound, so a legal amendment never clips", () => {
  const out = amendmentBlock([a({ text: "z".repeat(AMENDMENT_MAX_CHARS) })]).join("\n");
  expect(out).not.toContain("mechanically elided");
});
