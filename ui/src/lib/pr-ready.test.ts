import { describe, expect, it } from "vitest";
import { prReadinessBlock, prRailHue, prBadgeStaleMarker } from "./pr-ready";
import { isConflicting } from "./pr-conflict";
import { prMergeAvailable } from "./components/pr-badge";
import type { GitState, MergeStateStatus } from "./types";

function git(over: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    checks: "success",
    deployConfigured: false,
    number: 1534,
    ...over,
  };
}

describe("prReadinessBlock", () => {
  it("a clean green PR blocks on nothing", () => {
    expect(prReadinessBlock(git({ mergeStateStatus: "clean", mergeable: true }))).toBeNull();
    expect(prReadinessBlock(git({ mergeStateStatus: "has_hooks", mergeable: true }))).toBeNull();
  });

  it("behind is a block even with green checks — the #1551 case", () => {
    expect(prReadinessBlock(git({ mergeStateStatus: "behind", mergeable: true }))).toBe("behind");
  });

  it("blocked (branch protection) is a block", () => {
    expect(prReadinessBlock(git({ mergeStateStatus: "blocked", mergeable: true }))).toBe("blocked");
  });

  it("dirty and mergeable:false report a conflict", () => {
    expect(prReadinessBlock(git({ mergeStateStatus: "dirty" }))).toBe("conflict");
    expect(prReadinessBlock(git({ mergeable: false }))).toBe("conflict");
  });

  it("draft wins over behind — GitHub's DRAFT masks BEHIND", () => {
    expect(prReadinessBlock(git({ isDraft: true, mergeStateStatus: "draft" }))).toBe("draft");
    expect(prReadinessBlock(git({ isDraft: true, mergeStateStatus: "behind" }))).toBe("draft");
  });

  it("a dirty draft still reports draft (draft is checked first)", () => {
    expect(prReadinessBlock(git({ isDraft: true, mergeStateStatus: "dirty" }))).toBe("draft");
  });

  it("no usable mergeStateStatus (Gitea / unknown) blocks on nothing", () => {
    expect(prReadinessBlock(git({ kind: "gitea", mergeStateStatus: undefined }))).toBeNull();
    expect(prReadinessBlock(git({ mergeStateStatus: "unknown" }))).toBeNull();
    expect(prReadinessBlock(git({ mergeStateStatus: "unstable" }))).toBeNull();
  });

  it("a Gitea draft's mergeable:false is not a conflict (WIP-title artifact)", () => {
    expect(prReadinessBlock(git({ kind: "gitea", isDraft: true, mergeable: false }))).toBe("draft");
  });

  it("non-open PRs never block", () => {
    expect(prReadinessBlock(git({ state: "merged", mergeStateStatus: "behind" }))).toBeNull();
    expect(prReadinessBlock(git({ state: "closed", mergeStateStatus: "dirty" }))).toBeNull();
    expect(prReadinessBlock(git({ state: "none" }))).toBeNull();
    expect(prReadinessBlock(undefined)).toBeNull();
  });
});

describe("prRailHue", () => {
  const hue = (over: Partial<GitState>, reviewing = false) =>
    prRailHue({ git: git(over), reviewing });

  it("green + clean + no requested changes is clear", () => {
    expect(hue({ mergeStateStatus: "clean", mergeable: true })).toBe("clear");
  });

  it("green + behind is attention, NOT clear — the regression guard", () => {
    expect(hue({ mergeStateStatus: "behind", mergeable: true })).toBe("attention");
  });

  it("green + dirty / blocked are attention", () => {
    expect(hue({ mergeStateStatus: "dirty" })).toBe("attention");
    expect(hue({ mergeStateStatus: "blocked", mergeable: true })).toBe("attention");
  });

  it("a green draft is neutral — parked, never amber and never green", () => {
    expect(hue({ isDraft: true, mergeStateStatus: "draft" })).toBe("neutral");
  });

  it("CI failure and requested changes stay attention", () => {
    expect(hue({ checks: "failure", mergeStateStatus: "clean" })).toBe("attention");
    expect(
      hue({
        mergeStateStatus: "clean",
        latestReview: { state: "changes_requested", author: "a", submittedAt: 0 },
      }),
    ).toBe("attention");
  });

  it("an approving review does not block clear", () => {
    expect(
      hue({
        mergeStateStatus: "clean",
        mergeable: true,
        latestReview: { state: "approved", author: "a", submittedAt: 0 },
      }),
    ).toBe("clear");
  });

  it("a review in flight suppresses attention but not clear (today's behaviour)", () => {
    expect(hue({ checks: "failure", mergeStateStatus: "clean" }, true)).toBe("neutral");
    expect(hue({ mergeStateStatus: "behind" }, true)).toBe("neutral");
    expect(hue({ mergeStateStatus: "clean", mergeable: true }, true)).toBe("clear");
  });

  it("pending CI is neutral; non-open PRs are neutral", () => {
    expect(hue({ checks: "pending", mergeStateStatus: "clean" })).toBe("neutral");
    expect(prRailHue({ git: git({ state: "merged" }), reviewing: false })).toBe("neutral");
    expect(prRailHue({ git: undefined, reviewing: false })).toBe("neutral");
  });

  it("Gitea (no mergeStateStatus) keeps its green — staleness is unknowable there", () => {
    expect(hue({ kind: "gitea", mergeStateStatus: undefined })).toBe("clear");
  });
});

describe("prBadgeStaleMarker", () => {
  it("marks behind and conflict only", () => {
    expect(prBadgeStaleMarker(git({ mergeStateStatus: "behind" }))).toBe("behind");
    expect(prBadgeStaleMarker(git({ mergeStateStatus: "dirty" }))).toBe("conflict");
    expect(prBadgeStaleMarker(git({ mergeable: false }))).toBe("conflict");
  });

  it("leaves blocked and draft to their own surfaces", () => {
    expect(prBadgeStaleMarker(git({ mergeStateStatus: "blocked" }))).toBeNull();
    expect(prBadgeStaleMarker(git({ isDraft: true, mergeStateStatus: "draft" }))).toBeNull();
  });

  it("is silent on clean and on non-open PRs", () => {
    expect(prBadgeStaleMarker(git({ mergeStateStatus: "clean", mergeable: true }))).toBeNull();
    expect(prBadgeStaleMarker(git({ state: "merged", mergeStateStatus: "behind" }))).toBeNull();
  });
});

// ── prMergeAvailable parity ───────────────────────────────────────────────────
// prMergeAvailable now delegates its draft/conflict/behind/blocked terms to prReadinessBlock.
// `reference` is a verbatim copy of the pre-#1551 implementation; the matrix below asserts the
// delegating version answers identically for every combination, so the rewrite cannot silently
// change which PRs offer a Merge action.
function reference(g: GitState | undefined): boolean {
  if (!g || (g.kind !== "github" && g.kind !== "gitea")) return false;
  if (g.state !== "open" || !g.number) return false;
  if (g.isDraft === true || isConflicting(g)) return false;
  return g.mergeStateStatus && g.mergeStateStatus !== "unknown"
    ? g.mergeStateStatus !== "blocked" && g.mergeStateStatus !== "behind"
    : g.checks !== "failure";
}

describe("prMergeAvailable parity with the pre-#1551 implementation", () => {
  const states: (MergeStateStatus | undefined)[] = [
    undefined,
    "behind",
    "blocked",
    "clean",
    "dirty",
    "draft",
    "has_hooks",
    "unknown",
    "unstable",
  ];
  const matrix: GitState[] = [];
  for (const kind of ["github", "gitea", "local"] as const)
    for (const state of ["none", "open", "merged", "closed"] as const)
      for (const mergeStateStatus of states)
        for (const mergeable of [true, false, null])
          for (const isDraft of [true, false, undefined])
            for (const checks of ["none", "pending", "success", "failure"] as const)
              for (const number of [1534, undefined])
                matrix.push({
                  kind,
                  state,
                  checks,
                  deployConfigured: false,
                  number,
                  mergeStateStatus,
                  mergeable,
                  isDraft,
                });

  it("agrees on every combination of kind × state × mergeStateStatus × mergeable × draft × checks", () => {
    const drift = matrix.filter((g) => prMergeAvailable(g) !== reference(g));
    expect(drift).toEqual([]);
  });

  it("covers the whole matrix (guards against an empty-loop false pass)", () => {
    expect(matrix.length).toBe(3 * 4 * 9 * 3 * 3 * 4 * 2);
  });

  it("still refuses a behind PR and still allows a clean one", () => {
    expect(prMergeAvailable(git({ mergeStateStatus: "behind", mergeable: true }))).toBe(false);
    expect(prMergeAvailable(git({ mergeStateStatus: "clean", mergeable: true }))).toBe(true);
  });
});
