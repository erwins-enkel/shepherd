import { describe, it, expect } from "vitest";
import { deriveReadiness, type ReadinessInput } from "./readiness";

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    promptEmpty: false,
    issueSeeded: false,
    repoResolved: true,
    baseMissing: false,
    repairing: false,
    submitting: false,
    upstreamLoading: false,
    upstream: null,
    holdLikely: false,
    provider: "claude",
    ...over,
  };
}

describe("deriveReadiness blockers", () => {
  it("is ready with a prompt and a resolved repo", () => {
    expect(deriveReadiness(input())).toEqual({ canSubmit: true, blocker: null, advisories: [] });
  });

  // Table: one blocking condition at a time.
  it.each([
    ["empty_prompt", { promptEmpty: true }],
    ["no_repo", { repoResolved: false }],
    ["base_missing", { baseMissing: true }],
    ["repairing", { repairing: true }],
    ["submitting", { submitting: true }],
  ] as const)("blocks with %s", (blocker, over) => {
    const r = deriveReadiness(input(over));
    expect(r.canSubmit).toBe(false);
    expect(r.blocker).toBe(blocker);
  });

  // Precedence: transient work states outrank structural ones outrank the prompt.
  it("orders blockers submitting > repairing > no_repo > base_missing > empty_prompt", () => {
    expect(
      deriveReadiness(
        input({
          promptEmpty: true,
          repoResolved: false,
          baseMissing: true,
          repairing: true,
          submitting: true,
        }),
      ).blocker,
    ).toBe("submitting");
    expect(
      deriveReadiness(
        input({ promptEmpty: true, repoResolved: false, baseMissing: true, repairing: true }),
      ).blocker,
    ).toBe("repairing");
    expect(
      deriveReadiness(input({ promptEmpty: true, repoResolved: false, baseMissing: true })).blocker,
    ).toBe("no_repo");
    expect(deriveReadiness(input({ promptEmpty: true, baseMissing: true })).blocker).toBe(
      "base_missing",
    );
  });
});

describe("deriveReadiness issue-seeded prompt rule (repo-aware activeIssue predicate)", () => {
  it("a seeded same-repo issue satisfies an empty prompt", () => {
    const r = deriveReadiness(input({ promptEmpty: true, issueSeeded: true }));
    expect(r.canSubmit).toBe(true);
    expect(r.blocker).toBeNull();
  });

  it("a stale cross-repo attachment does NOT satisfy an empty prompt", () => {
    // The caller computes issueSeeded = issueRef && repoPath === attachedRepoPath,
    // so after a repo switch the input arrives as issueSeeded: false.
    const r = deriveReadiness(input({ promptEmpty: true, issueSeeded: false }));
    expect(r.canSubmit).toBe(false);
    expect(r.blocker).toBe("empty_prompt");
  });

  it("issueSeeded never unblocks non-prompt blockers", () => {
    expect(deriveReadiness(input({ issueSeeded: true, repoResolved: false })).blocker).toBe(
      "no_repo",
    );
  });
});

describe("deriveReadiness repoResolved cases", () => {
  it("initial: unresolved before listRepos lands, ready once the default pick resolves", () => {
    expect(deriveReadiness(input({ repoResolved: false })).blocker).toBe("no_repo");
    expect(deriveReadiness(input({ repoResolved: true })).canSubmit).toBe(true);
  });

  it("relaunch/hidden seeds are just resolved paths — same ready result", () => {
    // repoPath is only ever assigned concrete paths (seed, defaultRepoPath, picker,
    // shortcuts), so hidden or relaunch-seeded repos arrive as repoResolved: true.
    expect(deriveReadiness(input({ repoResolved: true })).canSubmit).toBe(true);
  });
});

describe("deriveReadiness advisories", () => {
  it("checking while upstream status is loading", () => {
    expect(deriveReadiness(input({ upstreamLoading: true })).advisories).toEqual(["checking"]);
  });

  it("diverged wins over behind", () => {
    expect(deriveReadiness(input({ upstream: { diverged: true, behind: 3 } })).advisories).toEqual([
      "diverged",
    ]);
    expect(deriveReadiness(input({ upstream: { diverged: false, behind: 3 } })).advisories).toEqual(
      ["behind"],
    );
    expect(deriveReadiness(input({ upstream: { diverged: false, behind: 0 } })).advisories).toEqual(
      [],
    );
  });

  it("advisories never block submission", () => {
    const r = deriveReadiness(input({ upstream: { diverged: true, behind: 2 }, holdLikely: true }));
    expect(r.canSubmit).toBe(true);
  });
});

describe("deriveReadiness provider-aware hold handling", () => {
  it("claude with a likely hold gets the hold_likely advisory (dual CTA)", () => {
    const r = deriveReadiness(input({ holdLikely: true, provider: "claude" }));
    expect(r.advisories).toEqual(["hold_likely"]);
    expect(r.canSubmit).toBe(true);
  });

  it("codex with the same likely hold stays single-CTA (no hold advisory)", () => {
    const r = deriveReadiness(input({ holdLikely: true, provider: "codex" }));
    expect(r.advisories).toEqual([]);
    expect(r.canSubmit).toBe(true);
  });
});
