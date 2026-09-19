import { test, expect } from "bun:test";
import {
  evaluateMergeGate,
  mergeResponsibility,
  parseMergeConfirm,
  validateMergeConfirm,
  type MergeConfirm,
  type MergeGateVerdict,
} from "../src/merge-gate";
import type { PrReviewerState } from "../src/forge/types";

const approved = (author: string) => ({ state: "approved", author, submittedAt: 1 }) as const;
const states = (m: Record<string, PrReviewerState["state"]>): Record<string, PrReviewerState> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { state: v, latestAt: 1 }]));

test("an unconfigured repo is never gated", () => {
  expect(evaluateMergeGate({ roles: { reviewer: null, merger: null }, me: "patrick" })).toEqual({
    handoff: null,
    handoffWho: null,
    reviewBlockBy: null,
    requiresConfirm: false,
  });
});

test("inferred handoff never gates — only the committed roles file does", () => {
  // A pending review request + a foreign approver is what computeHandoff INFERS a merger from.
  // The gate ignores all of it, because the repo configured no roles.
  const v = evaluateMergeGate({
    roles: { reviewer: null, merger: null },
    me: "patrick",
    latestReview: approved("scoop"),
    reviewerStates: states({ scoop: "approved" }),
  });
  expect(v.requiresConfirm).toBe(false);
});

test("a foreign reviewer who has not approved gates as 'reviewer'", () => {
  const v = evaluateMergeGate({ roles: { reviewer: "scoop", merger: null }, me: "patrick" });
  expect(v).toEqual({
    handoff: "reviewer",
    handoffWho: "scoop",
    reviewBlockBy: null,
    requiresConfirm: true,
  });
});

test("a foreign merger gates as 'merger' once the reviewer approved", () => {
  const v = evaluateMergeGate({
    roles: { reviewer: "scoop", merger: "scoop" },
    me: "patrick",
    latestReview: approved("scoop"),
  });
  expect(v).toEqual({
    handoff: "merger",
    handoffWho: "scoop",
    reviewBlockBy: null,
    requiresConfirm: true,
  });
});

test("the operator's own roles do not gate", () => {
  const v = evaluateMergeGate({
    roles: { reviewer: "Patrick", merger: "patrick" },
    me: "patrick",
    latestReview: approved("patrick"),
  });
  expect(v.requiresConfirm).toBe(false);
});

test("logins compare case-insensitively, so casing drift never reads as 'someone else'", () => {
  const v = evaluateMergeGate({ roles: { reviewer: null, merger: "PATRICK" }, me: "patrick" });
  expect(v.requiresConfirm).toBe(false);
});

test("an unresolvable operator login fails closed — every configured role reads as foreign", () => {
  const v = evaluateMergeGate({ roles: { reviewer: null, merger: "patrick" }, me: null });
  expect(v).toEqual({
    handoff: "merger",
    handoffWho: "patrick",
    reviewBlockBy: null,
    requiresConfirm: true,
  });
});

test("the configured reviewer's active changes_requested gates even when another human approved", () => {
  // annotateHandoff/configuredHandoff deliberately call this state "your turn" (act on the
  // feedback). For an EXECUTION check that is exactly the state a merge must not skip past.
  const v = evaluateMergeGate({
    roles: { reviewer: "scoop", merger: null },
    me: "patrick",
    latestReview: approved("dana"),
    reviewerStates: states({ scoop: "changes_requested", dana: "approved" }),
  });
  expect(v.handoff).toBeNull();
  expect(v.reviewBlockBy).toBe("scoop");
  expect(v.requiresConfirm).toBe(true);
});

test("a review block is reported alongside a handoff, not instead of it", () => {
  const v = evaluateMergeGate({
    roles: { reviewer: "scoop", merger: "dana" },
    me: "patrick",
    reviewerStates: states({ scoop: "changes_requested" }),
  });
  expect(v).toEqual({
    handoff: "reviewer",
    handoffWho: "scoop",
    reviewBlockBy: "scoop",
    requiresConfirm: true,
  });
});

test("changes the operator requested themselves are not a takeover", () => {
  const v = evaluateMergeGate({
    roles: { reviewer: "patrick", merger: null },
    me: "patrick",
    reviewerStates: states({ patrick: "changes_requested" }),
  });
  expect(v.requiresConfirm).toBe(false);
  expect(v.reviewBlockBy).toBeNull();
});

test("a stale review from a since-replaced reviewer does not gate", () => {
  const v = evaluateMergeGate({
    roles: { reviewer: "scoop", merger: null },
    me: "patrick",
    latestReview: approved("scoop"),
    reviewerStates: states({ dana: "changes_requested", scoop: "approved" }),
  });
  expect(v.requiresConfirm).toBe(false);
});

// ── validateMergeConfirm ────────────────────────────────────────────────────────────────────

const GATED: MergeGateVerdict = {
  handoff: "merger",
  handoffWho: "scoop",
  reviewBlockBy: null,
  requiresConfirm: true,
};
const OPEN: MergeGateVerdict = {
  handoff: null,
  handoffWho: null,
  reviewBlockBy: null,
  requiresConfirm: false,
};
const CURRENT = { headSha: "abc123", baseRefName: "main" };
const CONFIRM: MergeConfirm = {
  headSha: "abc123",
  baseRefName: "main",
  handoff: "merger",
  handoffWho: "scoop",
  reviewBlockBy: null,
};

test("no confirmation is required when nothing is being taken over", () => {
  expect(validateMergeConfirm(OPEN, CURRENT, null)).toBe("ok");
});

test("a gated merge without a confirmation is refused", () => {
  expect(validateMergeConfirm(GATED, CURRENT, null)).toBe("confirm_required");
});

test("a matching confirmation passes", () => {
  expect(validateMergeConfirm(GATED, CURRENT, CONFIRM)).toBe("ok");
});

// ── the dialog's view and the gate's view legitimately differ ────────────────────────────────
//
// The client builds its confirmation from GitState's DISPLAY annotation, which follows other
// rules than this gate. Reading those differences as drift would refuse the FIRST deliberate
// confirmation on ordinary repos — one confirmation must produce one merge.

test("an inferred handoff the gate does not share is not drift", () => {
  // Unconfigured repo: annotateHandoff infers a merger from the PR's reviewers, the gate gates on
  // nothing. Before, this 409'd every first merge on a repo with no roles file.
  expect(
    validateMergeConfirm(OPEN, CURRENT, {
      ...CONFIRM,
      handoff: "merger",
      handoffWho: "scoop",
    }),
  ).toBe("ok");
});

test("a fork's inferred handoff and review block are not drift either", () => {
  expect(
    validateMergeConfirm(OPEN, CURRENT, {
      ...CONFIRM,
      handoff: "reviewer",
      handoffWho: null,
      reviewBlockBy: "maintainer",
    }),
  ).toBe("ok");
});

test("a review block the dialog showed satisfies a handoff the gate derived from it", () => {
  // configuredHandoff collapses an active changes_requested to "your turn", so the dialog shows
  // only the block; the gate reports the reviewer. Same fact, two derivations — not drift.
  expect(
    validateMergeConfirm(
      { handoff: "reviewer", handoffWho: "scoop", reviewBlockBy: "scoop", requiresConfirm: true },
      CURRENT,
      { ...CONFIRM, handoff: null, handoffWho: null, reviewBlockBy: "scoop" },
    ),
  ).toBe("ok");
});

test("the handoff role flipping on the same person is not drift", () => {
  // The reviewer approved between dialog and confirm: reviewer → merger, same @scoop. The
  // responsibility was discharged, not handed to somebody else.
  expect(validateMergeConfirm(GATED, CURRENT, { ...CONFIRM, handoff: "reviewer" })).toBe("ok");
});

// ── what IS drift ───────────────────────────────────────────────────────────────────────────

test("a confirmation is stale once the responsible person changed", () => {
  expect(validateMergeConfirm({ ...GATED, handoffWho: "dana" }, CURRENT, CONFIRM)).toBe(
    "confirm_stale",
  );
});

test("a confirmation is stale once the review blocker changed", () => {
  expect(
    validateMergeConfirm({ ...GATED, reviewBlockBy: "dana" }, CURRENT, {
      ...CONFIRM,
      reviewBlockBy: "scoop",
    }),
  ).toBe("confirm_stale");
});

test("responsibility appearing after the dialog opened is re-asked, not treated as stale", () => {
  // The operator was never told anyone else was on the hook, so there is nothing to call stale.
  expect(
    validateMergeConfirm(GATED, CURRENT, {
      ...CONFIRM,
      handoff: null,
      handoffWho: null,
      reviewBlockBy: null,
    }),
  ).toBe("confirm_required");
});

test("responsible logins compare folded, so host casing is not drift", () => {
  expect(validateMergeConfirm({ ...GATED, handoffWho: "Scoop" }, CURRENT, CONFIRM)).toBe("ok");
});

// ── revision binding ────────────────────────────────────────────────────────────────────────

test("a confirmation is stale once the head moved", () => {
  expect(validateMergeConfirm(GATED, { ...CURRENT, headSha: "def456" }, CONFIRM)).toBe(
    "confirm_stale",
  );
});

test("a confirmation is stale once the target branch moved", () => {
  expect(validateMergeConfirm(GATED, { ...CURRENT, baseRefName: "epic/9" }, CONFIRM)).toBe(
    "confirm_stale",
  );
});

test("a head the server could not resolve is unknown, not moved", () => {
  // Hosts with no open-PR snapshot (Gitea) resolve nothing here. Refusing on that would 409 every
  // manual merge on those repos; GitHub still binds the revision host-side via --match-head-commit.
  expect(validateMergeConfirm(OPEN, { baseRefName: "main" }, CONFIRM)).toBe("ok");
  expect(validateMergeConfirm(OPEN, {}, CONFIRM)).toBe("ok");
});

test("parseMergeConfirm keeps only well-formed fields and rejects non-objects", () => {
  expect(parseMergeConfirm(undefined)).toBeNull();
  expect(parseMergeConfirm("yes")).toBeNull();
  expect(
    parseMergeConfirm({ headSha: "abc", handoff: "owner", handoffWho: 7, baseRefName: "" }),
  ).toEqual({
    headSha: "abc",
    baseRefName: null,
    handoff: null,
    handoffWho: null,
    reviewBlockBy: null,
  });
});

test("a malformed confirmation cannot satisfy a gate", () => {
  expect(validateMergeConfirm(GATED, CURRENT, parseMergeConfirm({ handoff: "nonsense" }))).toBe(
    "confirm_required",
  );
});

// ── mergeResponsibility (the stamped shape) ─────────────────────────────────────────────────

test("mergeResponsibility is absent when nothing is taken over", () => {
  expect(mergeResponsibility(OPEN)).toBeUndefined();
});

test("mergeResponsibility carries the handoff with its login, and a review block", () => {
  expect(mergeResponsibility(GATED)).toEqual({ handoff: "merger", handoffWho: "scoop" });
  expect(mergeResponsibility({ ...GATED, reviewBlockBy: "dana" })).toEqual({
    handoff: "merger",
    handoffWho: "scoop",
    reviewBlockBy: "dana",
  });
});

test("mergeResponsibility is absent when the verdict names nobody", () => {
  // A fork's unnamed maintainer: requiresConfirm with no login to show. Stamping an object that
  // reads as present while naming nobody would escalate the dialog's wording with nothing in it.
  expect(
    mergeResponsibility({
      handoff: "reviewer",
      handoffWho: null,
      reviewBlockBy: null,
      requiresConfirm: true,
    }),
  ).toBeUndefined();
});
