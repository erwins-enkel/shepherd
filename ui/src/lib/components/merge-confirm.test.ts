import { describe, it, expect } from "vitest";
import {
  applyMergeGate,
  isMergeConfirmRefusal,
  isMergeTakeover,
  mergeConfirmFromGit,
  mergeConfirmFromPr,
  mergeConfirmPayload,
} from "./merge-confirm";
import type { GitState, PullRequest } from "$lib/types";

function git(over: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    number: 12,
    title: "fix: thing",
    checks: "success",
    deployConfigured: false,
    headSha: "abc123",
    baseRefName: "main",
    mergeMethod: "squash",
    ...over,
  };
}

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 12,
    title: "fix: thing",
    url: "https://example.test/pr/12",
    author: "alice",
    kind: "regular",
    createdAt: 0,
    isDraft: false,
    mergeable: true,
    checks: "success",
    jobs: [],
    headSha: "abc123",
    baseRefName: "main",
    mergeMethod: "squash",
    ...over,
  };
}

describe("mergeConfirmFromGit", () => {
  it("resolves what the confirmation must state", () => {
    expect(mergeConfirmFromGit(git(), "shepherd")).toEqual({
      repoLabel: "shepherd",
      number: 12,
      title: "fix: thing",
      baseBranch: "main",
      mergeMethod: "squash",
      headSha: "abc123",
      handoff: null,
      handoffWho: null,
      reviewBlockBy: null,
    });
  });

  it("carries the server's stamped responsibility", () => {
    const ctx = mergeConfirmFromGit(
      git({ mergeGate: { handoff: "merger", handoffWho: "scoop", reviewBlockBy: "scoop" } }),
    );
    expect(ctx).toMatchObject({ handoff: "merger", handoffWho: "scoop", reviewBlockBy: "scoop" });
  });

  it("reads mergeGate, never the herd's handoff readout", () => {
    // `handoff`/`reviewBlock` are the "waiting on" readout: stamped only on a GREEN PR and
    // inferred where no roles are configured. Deriving the confirmation from them disagreed with
    // the gate that validates it — neutral wording plus a 409 on the first confirm.
    const ctx = mergeConfirmFromGit(
      git({
        handoff: "merger",
        handoffWho: "scoop",
        reviewBlock: { reviewer: "scoop", state: "changes_requested", latestAt: 1 },
      }),
    )!;
    expect(ctx.handoff).toBeNull();
    expect(ctx.handoffWho).toBeNull();
    expect(ctx.reviewBlockBy).toBeNull();
    expect(isMergeTakeover(ctx)).toBe(false);
  });

  it("names the responsible person on a PR whose CI has not cleared", () => {
    // The readout is CI-gated (and never clears at all on a non-GitHub host); the stamped verdict
    // is not. A red-but-mergeable PR must still say whose merge it is.
    const ctx = mergeConfirmFromGit(
      git({ checks: "failure", mergeGate: { handoff: "merger", handoffWho: "scoop" } }),
    )!;
    expect(isMergeTakeover(ctx)).toBe(true);
    expect(ctx.handoffWho).toBe("scoop");
  });

  it("refuses to build a context without an open PR, so no dialog can open on one", () => {
    expect(mergeConfirmFromGit(undefined)).toBeNull();
    expect(mergeConfirmFromGit(null)).toBeNull();
    expect(mergeConfirmFromGit(git({ state: "merged" }))).toBeNull();
    expect(mergeConfirmFromGit(git({ number: undefined }))).toBeNull();
  });
});

describe("mergeConfirmFromPr", () => {
  it("prefers the real base ref over the non-default-base display field", () => {
    expect(mergeConfirmFromPr(pr({ nonDefaultBase: "epic/9" }), "shepherd").baseBranch).toBe(
      "main",
    );
  });

  it("falls back to the non-default base when the host reported no raw base ref", () => {
    expect(
      mergeConfirmFromPr(pr({ baseRefName: undefined, nonDefaultBase: "epic/9" }), "shepherd")
        .baseBranch,
    ).toBe("epic/9");
  });

  it("carries the server-stamped responsibility", () => {
    const ctx = mergeConfirmFromPr(
      pr({ mergeGate: { handoff: "reviewer", handoffWho: "scoop" } }),
      "shepherd",
    );
    expect(ctx).toMatchObject({ handoff: "reviewer", handoffWho: "scoop" });
  });
});

describe("isMergeTakeover", () => {
  it("is true for a foreign handoff or an outstanding review block, false otherwise", () => {
    expect(isMergeTakeover({ handoff: null, reviewBlockBy: null })).toBe(false);
    expect(isMergeTakeover({ handoff: "merger", reviewBlockBy: null })).toBe(true);
    expect(isMergeTakeover({ handoff: null, reviewBlockBy: "scoop" })).toBe(true);
    expect(isMergeTakeover({})).toBe(false);
  });
});

describe("isMergeConfirmRefusal", () => {
  it("recognises both refusal codes and nothing else", () => {
    expect(isMergeConfirmRefusal({ code: "merge_confirm_required" })).toBe(true);
    expect(isMergeConfirmRefusal({ code: "merge_confirm_stale" })).toBe(true);
    // An in-flight async merge is NOT a refused confirmation — retrying that one is correct.
    expect(isMergeConfirmRefusal({ code: "merge_pending" })).toBe(false);
    expect(isMergeConfirmRefusal(new Error("boom"))).toBe(false);
    expect(isMergeConfirmRefusal(null)).toBe(false);
    expect(isMergeConfirmRefusal(undefined)).toBe(false);
  });
});

describe("mergeConfirmPayload", () => {
  it("echoes exactly the fields the server re-derives and compares", () => {
    expect(
      mergeConfirmPayload(
        mergeConfirmFromGit(git({ mergeGate: { handoff: "merger", handoffWho: "scoop" } }))!,
      ),
    ).toEqual({
      headSha: "abc123",
      baseRefName: "main",
      handoff: "merger",
      handoffWho: "scoop",
      reviewBlockBy: null,
    });
  });
});

describe("applyMergeGate", () => {
  it("replaces the responsibility wholesale, so a cleared one cannot linger", () => {
    const ctx = mergeConfirmFromGit(
      git({ mergeGate: { handoff: "merger", handoffWho: "scoop" } }),
    )!;
    const next = applyMergeGate(ctx, {}, {});
    expect(next).toMatchObject({ handoff: null, handoffWho: null, reviewBlockBy: null });
  });

  it("adopts the server's fresh revision and target branch", () => {
    const ctx = mergeConfirmFromGit(git())!;
    const next = applyMergeGate(
      ctx,
      { handoff: "reviewer", handoffWho: "dana" },
      { headSha: "def456", baseRefName: "epic/9" },
    );
    expect(next).toMatchObject({
      headSha: "def456",
      baseBranch: "epic/9",
      handoff: "reviewer",
      handoffWho: "dana",
    });
  });

  it("adopts an unresolved revision verbatim, so a re-confirmation converges", () => {
    // The server sends null for "I could not resolve this". Re-adopting the client's own value
    // there would re-submit the same mismatching sha and loop on the same refusal.
    const ctx = mergeConfirmFromGit(git())!;
    const next = applyMergeGate(ctx, {}, { headSha: null, baseRefName: null });
    expect(next.headSha).toBeNull();
    expect(next.baseBranch).toBeNull();
  });

  it("keeps the shown revision when the refusal carried no revision fields at all", () => {
    const ctx = mergeConfirmFromGit(git())!;
    expect(applyMergeGate(ctx, {}).headSha).toBe("abc123");
  });
});
