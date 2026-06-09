import { test, expect } from "bun:test";
import { computeHandoff, parseRoles, normalizeLogin } from "../src/repo-roles";
import type { PrStatus } from "../src/forge/types";

const approved: PrStatus["latestReview"] = { state: "approved", author: "scoop", submittedAt: 1 };

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
