import { test, expect } from "bun:test";
import { computeMerge, type MergeRepoState, type MergeSessionView } from "../src/automerge-core";

function sess(o: Partial<MergeSessionView> = {}): MergeSessionView {
  return {
    id: "s1",
    desig: "TASK-01",
    state: "open",
    checks: "success",
    mergeable: true,
    number: 7,
    headSha: "h1",
    behind: false,
    reviewDecision: null,
    reviewHeadSha: null,
    rebaseCount: 0,
    rebaseSteeredHead: null,
    mergeBlocked: false,
    ...o,
  };
}
function state(sessions: MergeSessionView[], o: Partial<MergeRepoState> = {}): MergeRepoState {
  return { enabled: true, criticEnabled: false, rebaseCap: 5, sessions, ...o };
}

test("disabled → hold", () => {
  expect(computeMerge(state([sess()], { enabled: false })).kind).toBe("hold");
});

test("open+green+mergeable+current → merge (critic off)", () => {
  const d = computeMerge(state([sess()]));
  expect(d).toEqual({ kind: "merge", sessionId: "s1", prNumber: 7, headSha: "h1" });
});

test("behind → rebase", () => {
  expect(computeMerge(state([sess({ behind: true })]))).toEqual({
    kind: "rebase",
    sessionId: "s1",
    headSha: "h1",
  });
});

test("conflicting (mergeable false) → rebase", () => {
  expect(computeMerge(state([sess({ mergeable: false })]))).toEqual({
    kind: "rebase",
    sessionId: "s1",
    headSha: "h1",
  });
});

test("behind unknown (null) → hold, never merge", () => {
  const d = computeMerge(state([sess({ behind: null })]));
  expect(d).toEqual({ kind: "hold", reason: { code: "idle" } });
});

test("not green → hold", () => {
  expect(computeMerge(state([sess({ checks: "pending" })])).kind).toBe("hold");
});

test("rebase cap exceeded → hold with reason", () => {
  const d = computeMerge(state([sess({ behind: true, rebaseCount: 5 })]));
  expect(d).toEqual({
    kind: "hold",
    reason: { code: "rebase_cap", detail: "TASK-01", sessionId: "s1" },
  });
});

test("critic on: no clean verdict for head → hold", () => {
  expect(computeMerge(state([sess()], { criticEnabled: true })).kind).toBe("hold"); // reviewDecision null
  expect(
    computeMerge(
      state([sess({ reviewDecision: "commented", reviewHeadSha: "h1" })], { criticEnabled: true }),
    ),
  ).toEqual({ kind: "merge", sessionId: "s1", prNumber: 7, headSha: "h1" });
});

test("critic blocking → hold", () => {
  expect(
    computeMerge(
      state([sess({ reviewDecision: "changes_requested", reviewHeadSha: "h1" })], {
        criticEnabled: true,
      }),
    ).kind,
  ).toBe("hold");
});

test("next-in-line: merge first eligible, others ignored this tick", () => {
  const d = computeMerge(state([sess({ id: "a", behind: true }), sess({ id: "b" })]));
  // 'a' needs rebase but 'b' is ready → we prefer merges, so 'b' merges.
  expect(d).toEqual({ kind: "merge", sessionId: "b", prNumber: 7, headSha: "h1" });
});

test("critic on: verdict for a stale head → hold (must not merge)", () => {
  const d = computeMerge(
    state([sess({ reviewDecision: "commented", reviewHeadSha: "OLD" })], { criticEnabled: true }),
  );
  expect(d.kind).toBe("hold"); // verdict is for an older head than headSha "h1"
});

test("critic on: behind but verdict pending for new head → hold (let critic settle, no rebase yet)", () => {
  const d = computeMerge(
    state([sess({ behind: true, reviewDecision: "commented", reviewHeadSha: "OLD" })], {
      criticEnabled: true,
    }),
  );
  expect(d.kind).toBe("hold"); // not "rebase": a re-review is pending for the current head
});

// ── rebase-outstanding guard (Fix 1) ────────────────────────────────────────────

test("rebase already steered for this head → hold idle (no re-steer)", () => {
  const d = computeMerge(state([sess({ behind: true, headSha: "h1", rebaseSteeredHead: "h1" })]));
  expect(d).toEqual({ kind: "hold", reason: { code: "idle" } });
});

test("rebase steered for an OLD head + still behind → rebase the new head", () => {
  const d = computeMerge(state([sess({ behind: true, headSha: "h2", rebaseSteeredHead: "h1" })]));
  expect(d).toEqual({ kind: "rebase", sessionId: "s1", headSha: "h2" });
});

// ── merge-blocked backoff (Fix 6) ───────────────────────────────────────────────

test("mergeBlocked → skipped; a ready sibling merges instead", () => {
  const d = computeMerge(
    state([sess({ id: "a", mergeBlocked: true }), sess({ id: "b", headSha: "hB" })]),
  );
  expect(d).toEqual({ kind: "merge", sessionId: "b", prNumber: 7, headSha: "hB" });
});

test("mergeBlocked lone session → hold (not merged)", () => {
  const d = computeMerge(state([sess({ mergeBlocked: true })]));
  expect(d.kind).toBe("hold");
});
