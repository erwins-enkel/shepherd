import { test, expect } from "bun:test";
import { annotateHandoff, computeHandoff, parseRoles, normalizeLogin } from "../src/repo-roles";
import type { GitState, PrStatus } from "../src/forge/types";

const approved: PrStatus["latestReview"] = { state: "approved", author: "scoop", submittedAt: 1 };

const gitState = (over: Partial<GitState> = {}): GitState =>
  ({ kind: "github", state: "open", checks: "none", deployConfigured: false, ...over }) as GitState;

test("annotateHandoff stamps noCi=true for a GitHub repo with no workflows", () => {
  const g = annotateHandoff(gitState(), "/no/such/repo", "kai");
  expect(g.noCi).toBe(true);
});

test("annotateHandoff stamps noCi=false for a non-GitHub forge", () => {
  const g = annotateHandoff(gitState({ kind: "gitea" }), "/no/such/repo", "kai");
  expect(g.noCi).toBe(false);
});

test("merger = self → self (today's 'your turn')", () => {
  const r = computeHandoff({ reviewer: null, merger: "kai" }, "kai", undefined);
  expect(r.handoff).toBe("self");
  expect(r.handoffWho).toBeNull();
});

test("merger = someone else → waiting on the merger", () => {
  const r = computeHandoff({ reviewer: null, merger: "scoop" }, "kai", undefined);
  expect(r.handoff).toBe("merger");
  expect(r.handoffWho).toBe("scoop");
});

test("foreign reviewer with no approval → waiting on the reviewer", () => {
  const r = computeHandoff({ reviewer: "scoop", merger: "scoop" }, "kai", undefined);
  expect(r.handoff).toBe("reviewer");
  expect(r.handoffWho).toBe("scoop");
});

test("foreign reviewer once approved falls through to the merger", () => {
  const r = computeHandoff({ reviewer: "scoop", merger: "scoop" }, "kai", approved);
  expect(r.handoff).toBe("merger");
  expect(r.handoffWho).toBe("scoop");
});

test("any human approve satisfies the reviewer step (human-in-the-loop)", () => {
  // approval by someone other than the configured reviewer still counts
  const byOther: PrStatus["latestReview"] = { state: "approved", author: "alice", submittedAt: 2 };
  const r = computeHandoff({ reviewer: "scoop", merger: "kai" }, "kai", byOther);
  expect(r.handoff).toBe("self");
});

test("login comparison is case-insensitive — own login in any casing is still self", () => {
  // GitHub logins are case-insensitive; a free-text "Kai" must match operator "kai".
  expect(computeHandoff({ reviewer: null, merger: "Kai" }, "kai", undefined).handoff).toBe("self");
  expect(computeHandoff({ reviewer: "KAI", merger: null }, "kai", undefined).handoff).toBe("self");
});

test("no roles → self", () => {
  expect(computeHandoff({ reviewer: null, merger: null }, "kai", undefined).handoff).toBe("self");
});

test("unknown me is defensive: a configured role still counts as 'other'", () => {
  const r = computeHandoff({ reviewer: null, merger: "scoop" }, null, undefined);
  expect(r.handoff).toBe("merger");
});

// ── inference path (no roles.json → infer a merger from the PR) ──────────────

const unconfigured = { reviewer: null, merger: null };

test("unconfigured + foreign pending requested reviewer → infer merger (#539 repro)", () => {
  // green PR, not yet approved, one foreign reviewer requested → "waiting on scoop",
  // NOT "your turn".
  const r = computeHandoff(unconfigured, "kai", undefined, ["scoop"]);
  expect(r.handoff).toBe("merger");
  expect(r.handoffWho).toBe("scoop");
  expect(r.inferred).toBe(true);
});

test("unconfigured + foreign approval, no pending request → infer merger = approver", () => {
  const r = computeHandoff(unconfigured, "kai", approved, []);
  expect(r.handoff).toBe("merger");
  expect(r.handoffWho).toBe("scoop"); // `approved` is authored by scoop
  expect(r.inferred).toBe(true);
});

test("unconfigured + multiple foreign requested reviewers → case-insensitively lowest", () => {
  const r = computeHandoff(unconfigured, "kai", undefined, ["Zed", "alice", "Bob"]);
  expect(r.handoff).toBe("merger");
  expect(r.handoffWho).toBe("alice"); // lowest folded, original casing returned
  expect(r.inferred).toBe(true);
});

test("unconfigured + requested reviewer == me (case-folded) → ignored → self", () => {
  const r = computeHandoff(unconfigured, "kai", undefined, ["KAI"]);
  expect(r.handoff).toBe("self");
  expect(r.handoffWho).toBeNull();
  expect(r.inferred).toBe(false);
});

test("unconfigured + no requested reviewer + no foreign approval → self", () => {
  expect(computeHandoff(unconfigured, "kai", undefined, []).handoff).toBe("self");
  expect(computeHandoff(unconfigured, "kai", undefined).handoff).toBe("self"); // default []
});

test("configured roles present → inference inert, inferred:false", () => {
  // requestedReviewers are present but ignored because roles are explicitly set.
  const r = computeHandoff({ reviewer: null, merger: "scoop" }, "kai", undefined, ["alice"]);
  expect(r.handoff).toBe("merger");
  expect(r.handoffWho).toBe("scoop"); // configured merger, not the requested reviewer
  expect(r.inferred).toBe(false);
});

test("parseRoles: valid, partial, empty, and garbage", () => {
  expect(parseRoles('{"reviewer":"scoop","merger":"scoop"}')).toEqual({
    reviewer: "scoop",
    merger: "scoop",
  });
  expect(parseRoles('{"merger":"@scoop"}')).toEqual({ reviewer: null, merger: "scoop" });
  expect(parseRoles("{}")).toEqual({ reviewer: null, merger: null });
  expect(() => parseRoles("not json")).toThrow();
});

test("normalizeLogin trims, drops a leading @, empties to null", () => {
  expect(normalizeLogin("  @scoop ")).toBe("scoop");
  expect(normalizeLogin("")).toBeNull();
  expect(normalizeLogin(42)).toBeNull();
});
