import { test, expect } from "bun:test";
import {
  scopeBackstop,
  shouldSkipForPatchId,
  scopeFindings,
  normalizeDecision,
  normalizeFindings,
  buildVerdictCore,
  reviewPrompt,
  prReviewPrompt,
} from "../src/critic-core";

// ── prReviewPrompt (session-less) ───────────────────────────────────────────

test("prReviewPrompt frames bugs/security/quality with the PR intent as context, shares scope+output", () => {
  const p = prReviewPrompt("base123", "Add a feature", "does the thing");
  // diff base + intent threaded in
  expect(p).toContain("git diff base123...HEAD");
  expect(p).toContain("Add a feature");
  expect(p).toContain("does the thing");
  // session-less framing — NOT "satisfies that task"
  expect(p).toContain("bugs, security issues, and clear quality problems");
  expect(p).not.toContain("The task this PR is meant to accomplish");
  // shares the verdict-output contract + scope tail with reviewPrompt
  expect(p).toContain(".shepherd-review.json");
  expect(p).toContain("Never approve");
  expect(p).toContain("SCOPE — your review is limited to");
});

test("prReviewPrompt tolerates an empty body", () => {
  const p = prReviewPrompt("base123", "Title only", "   ");
  expect(p).toContain("(no description provided)");
});

test("reviewPrompt and prReviewPrompt share the identical scope+output tail", () => {
  // The shared tail starts at the SCOPE header; both prompts must carry it verbatim so the
  // server-side scope backstop + verdict parser behave identically for either critic.
  const a = reviewPrompt("b", "task").slice(reviewPrompt("b", "task").indexOf("SCOPE — "));
  const b = prReviewPrompt("b", "t", "body").slice(
    prReviewPrompt("b", "t", "body").indexOf("SCOPE — "),
  );
  // tails differ only on the single judge clause line; the output contract below it is identical.
  const outputContract = (s: string) => s.slice(s.indexOf("When done, write your verdict"));
  expect(outputContract(a)).toBe(outputContract(b));
});

// ── scopeBackstop (pure) ────────────────────────────────────────────────────

test("scopeBackstop drops out-of-diff path-attributed findings, keeps in-diff + unattributed", () => {
  const { decision, scoped } = scopeBackstop(
    "base-sha",
    ["src/a.ts"],
    "commented",
    ["src/a.ts: real", "src/other.ts: pre-existing", "general nit"],
    "s1",
  );
  expect(decision).toBe("commented");
  expect(scoped).toEqual(["src/a.ts: real", "general nit"]);
});

test("scopeBackstop flips request-changes → commented when emptied of findings", () => {
  const { decision, scoped } = scopeBackstop(
    "base-sha",
    ["src/a.ts"],
    "changes_requested",
    ["src/elsewhere.ts: out of diff"],
    "s1",
  );
  expect(decision).toBe("commented");
  expect(scoped).toEqual([]);
});

test("scopeBackstop keeps request-changes when at least one finding survives", () => {
  const { decision, scoped } = scopeBackstop(
    "base-sha",
    ["src/a.ts"],
    "changes_requested",
    ["src/a.ts: keep me", "src/gone.ts: drop me"],
    "s1",
  );
  expect(decision).toBe("changes_requested");
  expect(scoped).toEqual(["src/a.ts: keep me"]);
});

test("scopeBackstop skips filtering (keeps all) when baseSha is null", () => {
  const { decision, scoped } = scopeBackstop(
    null,
    ["src/a.ts"],
    "changes_requested",
    ["src/elsewhere.ts: would-drop"],
    "s1",
  );
  expect(decision).toBe("changes_requested");
  expect(scoped).toEqual(["src/elsewhere.ts: would-drop"]);
});

test("scopeBackstop skips filtering (keeps all) when files is empty", () => {
  const { decision, scoped } = scopeBackstop(
    "base-sha",
    [],
    "changes_requested",
    ["src/elsewhere.ts: would-drop"],
    "s1",
  );
  expect(decision).toBe("changes_requested");
  expect(scoped).toEqual(["src/elsewhere.ts: would-drop"]);
});

test("scopeBackstop keeps unattributed (no path prefix) findings", () => {
  const { scoped } = scopeBackstop(
    "base-sha",
    ["src/a.ts"],
    "commented",
    ["does not satisfy the task", "Note: something"],
    "s1",
  );
  expect(scoped).toEqual(["does not satisfy the task", "Note: something"]);
});

// ── shouldSkipForPatchId (pure) ─────────────────────────────────────────────

test("shouldSkipForPatchId: skips when patchId equals prior.patchId", () => {
  expect(shouldSkipForPatchId({ decision: "commented", patchId: "p1" }, "p1")).toBe(true);
});

test("shouldSkipForPatchId: skips when patchId is member of reviewedPatchIds set", () => {
  expect(
    shouldSkipForPatchId(
      { decision: "changes_requested", patchId: "p2", reviewedPatchIds: ["p0", "p1"] },
      "p1",
    ),
  ).toBe(true);
});

test("shouldSkipForPatchId: never skips past an error verdict", () => {
  expect(shouldSkipForPatchId({ decision: "error", patchId: "p1" }, "p1")).toBe(false);
});

test("shouldSkipForPatchId: empty patchId never skips", () => {
  expect(shouldSkipForPatchId({ decision: "commented", patchId: "" }, "")).toBe(false);
});

test("shouldSkipForPatchId: no prior never skips", () => {
  expect(shouldSkipForPatchId(null, "p1")).toBe(false);
});

test("shouldSkipForPatchId: unrelated patchId not in set does not skip", () => {
  expect(
    shouldSkipForPatchId({ decision: "commented", patchId: "p1", reviewedPatchIds: ["p0"] }, "p9"),
  ).toBe(false);
});

// ── scopeFindings (pure) ────────────────────────────────────────────────────

test("scopeFindings drops path-attributed out-of-diff findings, keeps in-diff + unattributed", () => {
  const { kept, dropped } = scopeFindings(
    ["src/a.ts: in", "src/b.ts: out", "just a note"],
    ["src/a.ts"],
  );
  expect(kept).toEqual(["src/a.ts: in", "just a note"]);
  expect(dropped).toEqual(["src/b.ts: out"]);
});

test("scopeFindings drops nothing when the file set is empty", () => {
  const { kept, dropped } = scopeFindings(["any/where.ts: x", "y"], []);
  expect(kept).toEqual(["any/where.ts: x", "y"]);
  expect(dropped).toEqual([]);
});

test("scopeFindings keeps a basename/partial-path-prefixed in-diff finding", () => {
  const { kept, dropped } = scopeFindings(
    ["Viewport.svelte: x", "lib/components/Viewport.svelte: y"],
    ["ui/src/lib/components/Viewport.svelte"],
  );
  expect(kept).toEqual(["Viewport.svelte: x", "lib/components/Viewport.svelte: y"]);
  expect(dropped).toEqual([]);
});

test("scopeFindings strips a :line suffix on the path token before matching", () => {
  const { kept, dropped } = scopeFindings(["src/a.ts:42: out-of-line"], ["src/a.ts"]);
  expect(kept).toEqual(["src/a.ts:42: out-of-line"]);
  expect(dropped).toEqual([]);
});

// ── normalizeDecision / normalizeFindings (pure) ────────────────────────────

test("normalizeDecision maps the critic's enum and rejects junk", () => {
  expect(normalizeDecision("request-changes")).toBe("changes_requested");
  expect(normalizeDecision("comment")).toBe("commented");
  expect(normalizeDecision("approve")).toBe(null);
  expect(normalizeDecision(undefined)).toBe(null);
  expect(normalizeDecision(42)).toBe(null);
});

test("normalizeFindings coerces to a clean trimmed string[], dropping junk", () => {
  expect(normalizeFindings(["  a  ", "", "b", 7, null, "  "])).toEqual(["a", "b"]);
  expect(normalizeFindings("not an array")).toEqual([]);
  expect(normalizeFindings(undefined)).toEqual([]);
});

// ── buildVerdictCore (pure) — the normalize+scope+fallback split ─────────────

test("buildVerdictCore: a clean comment verdict carries its patchId", () => {
  const core = buildVerdictCore(
    { decision: "comment", summary: "ok", body: "looks good", findings: [] },
    "base-sha",
    ["src/a.ts"],
    "p1",
    "s1",
  );
  expect(core.decision).toBe("commented");
  expect(core.findings).toEqual([]);
  expect(core.patchId).toBe("p1");
});

test("buildVerdictCore: missing raw → error verdict, no patchId, summary fallback", () => {
  const core = buildVerdictCore(null, "base-sha", ["src/a.ts"], "p1", "s1");
  expect(core.decision).toBe("error");
  expect(core.patchId).toBe("");
  expect(core.summary).toBe("critic did not produce a verdict");
});

test("buildVerdictCore: request-changes with no findings falls back to its summary", () => {
  const core = buildVerdictCore(
    { decision: "request-changes", summary: "needs work", body: "b", findings: [] },
    "base-sha",
    ["src/a.ts"],
    "p1",
    "s1",
  );
  expect(core.decision).toBe("changes_requested");
  expect(core.findings).toEqual(["needs work"]);
});
