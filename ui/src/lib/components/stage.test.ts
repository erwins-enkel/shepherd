import { describe, it, expect } from "vitest";
import { deriveStage, STAGE_ORDER, PR_INDEX, REVIEW_INDEX } from "./stage";
import type { GitState, ReviewVerdict, ChecksState } from "$lib/types";

function git(over: Partial<GitState>): GitState {
  return {
    kind: "github",
    state: "none",
    checks: "none",
    deployConfigured: false,
    ...over,
  };
}

const verdict: ReviewVerdict = {
  sessionId: "s1",
  headSha: "abc",
  decision: "commented",
  summary: "",
  body: "",
  findings: [],
  addressRound: 0,
  addressCap: 3,
  finalRoundPending: false,
  finalRoundTimeoutMs: 0,
  updatedAt: 0,
};

describe("STAGE_ORDER + exported indices", () => {
  it("order is planning→implementing→pr→review→ready", () => {
    expect(STAGE_ORDER).toEqual(["planning", "implementing", "pr", "review", "ready"]);
  });

  it("PR_INDEX matches indexOf pr", () => {
    expect(PR_INDEX).toBe(STAGE_ORDER.indexOf("pr"));
    expect(PR_INDEX).toBe(2);
  });

  it("REVIEW_INDEX matches indexOf review", () => {
    expect(REVIEW_INDEX).toBe(STAGE_ORDER.indexOf("review"));
    expect(REVIEW_INDEX).toBe(3);
  });
});

describe("deriveStage — planning / implementing stages", () => {
  it("planning: planPhase='planning' → index 0", () => {
    const s = deriveStage({ planPhase: "planning", reviewing: false, readyToMerge: false });
    expect(s.index).toBe(0);
    expect(s.reached).toBe("planning");
    expect(s.planningSkipped).toBe(false);
  });

  it("implementing: planPhase='executing' → index 1", () => {
    const s = deriveStage({ planPhase: "executing", reviewing: false, readyToMerge: false });
    expect(s.index).toBe(1);
    expect(s.reached).toBe("implementing");
    expect(s.planningSkipped).toBe(false);
  });

  it("implementing: planPhase=null (gate off) → index 1, planningSkipped=true", () => {
    const s = deriveStage({ planPhase: null, reviewing: false, readyToMerge: false });
    expect(s.index).toBe(1);
    expect(s.reached).toBe("implementing");
    expect(s.planningSkipped).toBe(true);
  });

  it("implementing: no planPhase key at all → index 1, planningSkipped=true", () => {
    // planPhase absent is equivalent to null (gate off)
    const s = deriveStage({ reviewing: false, readyToMerge: false });
    expect(s.index).toBe(1);
    expect(s.reached).toBe("implementing");
    expect(s.planningSkipped).toBe(true);
  });
});

describe("deriveStage — pr stage", () => {
  it("pr: open + checks none → index 2, ci='none'", () => {
    const s = deriveStage({
      git: git({ state: "open", checks: "none" }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBe(2);
    expect(s.reached).toBe("pr");
    expect(s.ci).toBe("none");
  });

  for (const checks of ["pending", "success", "failure"] as ChecksState[]) {
    it(`pr: open + checks ${checks} → still index 2 (CI folds into pr), ci passthrough`, () => {
      const s = deriveStage({
        git: git({ state: "open", checks }),
        reviewing: false,
        readyToMerge: false,
      });
      expect(s.index).toBe(2);
      expect(s.reached).toBe("pr");
      expect(s.ci).toBe(checks);
    });
  }

  it("no-PR session: ci='none'", () => {
    const s = deriveStage({ reviewing: false, readyToMerge: false });
    expect(s.ci).toBe("none");
  });
});

describe("deriveStage — review stage", () => {
  it("reviewing=true bumps to index 3", () => {
    const s = deriveStage({
      git: git({ state: "open", checks: "success" }),
      reviewing: true,
      readyToMerge: false,
    });
    expect(s.index).toBe(3);
    expect(s.reached).toBe("review");
  });

  it("verdict present bumps to index 3", () => {
    const s = deriveStage({
      git: git({ state: "open", checks: "none" }),
      verdict,
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBe(3);
  });

  it("git.latestReview present bumps to index 3", () => {
    const s = deriveStage({
      git: git({
        state: "open",
        checks: "none",
        latestReview: { state: "commented", author: "x", submittedAt: 0 },
      }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBe(3);
  });

  it("review does not pull a no-PR session below implementing", () => {
    // no git, but reviewing → review still wins via max()
    const s = deriveStage({ reviewing: true, readyToMerge: false });
    expect(s.index).toBe(3);
  });
});

describe("deriveStage — review tint", () => {
  it("review.review='none' by default (no PR)", () => {
    const s = deriveStage({ reviewing: false, readyToMerge: false });
    expect(s.review).toBe("none");
  });

  it("reviewing=true → 'reviewing'", () => {
    const s = deriveStage({
      git: git({ state: "open" }),
      reviewing: true,
      readyToMerge: false,
    });
    expect(s.review).toBe("reviewing");
  });

  it("reviewing=true beats stale changes_requested verdict", () => {
    const staleChanges: ReviewVerdict = {
      ...verdict,
      headSha: "old",
      decision: "changes_requested",
    };
    const s = deriveStage({
      git: git({ state: "open", headSha: "new" }),
      verdict: staleChanges,
      reviewing: true,
      readyToMerge: false,
    });
    expect(s.review).toBe("reviewing");
  });

  it("verdict changes_requested → 'changes'", () => {
    const changesVerdict: ReviewVerdict = { ...verdict, decision: "changes_requested" };
    const s = deriveStage({
      git: git({ state: "open" }),
      verdict: changesVerdict,
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.review).toBe("changes");
  });

  it("git.latestReview changes_requested → 'changes'", () => {
    const s = deriveStage({
      git: git({
        state: "open",
        latestReview: { state: "changes_requested", author: "x", submittedAt: 0 },
      }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.review).toBe("changes");
  });

  it("git.latestReview approved → 'approved'", () => {
    const s = deriveStage({
      git: git({
        state: "open",
        latestReview: { state: "approved", author: "x", submittedAt: 0 },
      }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.review).toBe("approved");
  });

  it("verdict commented on matching headSha → 'approved'", () => {
    const s = deriveStage({
      git: git({ state: "open", headSha: "abc" }),
      verdict: { ...verdict, decision: "commented", headSha: "abc" },
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.review).toBe("approved");
  });

  it("verdict commented on mismatched headSha → 'none'", () => {
    const s = deriveStage({
      git: git({ state: "open", headSha: "xyz" }),
      verdict: { ...verdict, decision: "commented", headSha: "abc" },
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.review).toBe("none");
  });

  it("verdict commented, git.headSha undefined → 'none' (headSha guard)", () => {
    // Both headShas undefined: pins the git?.headSha != null guard — without it,
    // undefined===undefined would pass and return "approved" instead of "none".
    // ReviewVerdict.headSha is typed required but arrives as wire JSON where it can be absent.
    // (Parallel safe-fail test in derived-ready suite cross-references this comment.)
    const s = deriveStage({
      git: git({ state: "open" }), // headSha not set
      verdict: { ...verdict, decision: "commented", headSha: undefined as unknown as string },
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.review).toBe("none");
  });

  it("verdict error → 'error'", () => {
    const errVerdict: ReviewVerdict = { ...verdict, decision: "error" };
    const s = deriveStage({
      git: git({ state: "open" }),
      verdict: errVerdict,
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.review).toBe("error");
  });

  it("git.latestReview commented alone → 'none'", () => {
    const s = deriveStage({
      git: git({
        state: "open",
        latestReview: { state: "commented", author: "x", submittedAt: 0 },
      }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.review).toBe("none");
  });

  it("verdict changes_requested on a STALE head (open PR at a newer head) → NOT 'changes'", () => {
    // Rework pushed, PR now at "new"; the verdict reviewed "old" → superseded, don't paint red.
    const s = deriveStage({
      git: git({ state: "open", headSha: "new" }),
      verdict: { ...verdict, decision: "changes_requested", headSha: "old" },
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.review).toBe("none");
  });

  it("verdict error on a STALE head → NOT 'error'", () => {
    const s = deriveStage({
      git: git({ state: "open", headSha: "new" }),
      verdict: { ...verdict, decision: "error", headSha: "old" },
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.review).toBe("none");
  });

  it("verdict changes_requested at the CURRENT head → still 'changes'", () => {
    const s = deriveStage({
      git: git({ state: "open", headSha: "same" }),
      verdict: { ...verdict, decision: "changes_requested", headSha: "same" },
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.review).toBe("changes");
  });

  it("human latestReview changes_requested still tints 'changes' even on a stale critic head", () => {
    // The forge fact (human requested changes) is independent of critic-verdict staleness.
    const s = deriveStage({
      git: git({
        state: "open",
        headSha: "new",
        latestReview: { state: "changes_requested", author: "x", submittedAt: 0 },
      }),
      verdict: { ...verdict, decision: "changes_requested", headSha: "old" },
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.review).toBe("changes");
  });
});

describe("deriveStage — derived-ready predicate", () => {
  const readyBase = {
    state: "open" as const,
    checks: "success" as const,
    mergeable: true as const,
    isDraft: false,
    headSha: "sha1",
  };

  it("lights ready: open+success+mergeable+!draft+approved", () => {
    const s = deriveStage({
      git: git({
        ...readyBase,
        latestReview: { state: "approved", author: "x", submittedAt: 0 },
      }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBe(4);
    expect(s.reached).toBe("ready");
  });

  it("lights ready: open+success+mergeable+!draft+critic commented matching headSha", () => {
    const s = deriveStage({
      git: git({ ...readyBase }),
      verdict: { ...verdict, decision: "commented", headSha: "sha1" },
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBe(4);
    expect(s.reached).toBe("ready");
  });

  it("NOT ready: mergeable=false", () => {
    const s = deriveStage({
      git: git({
        ...readyBase,
        mergeable: false,
        latestReview: { state: "approved", author: "x", submittedAt: 0 },
      }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBeLessThan(4);
  });

  it("NOT ready: mergeable=null (unknown)", () => {
    const s = deriveStage({
      git: git({
        ...readyBase,
        mergeable: null,
        latestReview: { state: "approved", author: "x", submittedAt: 0 },
      }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBeLessThan(4);
  });

  it("NOT ready: mergeable=undefined", () => {
    const s = deriveStage({
      git: git({
        ...readyBase,
        mergeable: undefined,
        latestReview: { state: "approved", author: "x", submittedAt: 0 },
      }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBeLessThan(4);
  });

  it("NOT ready: isDraft=true", () => {
    const s = deriveStage({
      git: git({
        ...readyBase,
        isDraft: true,
        latestReview: { state: "approved", author: "x", submittedAt: 0 },
      }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBeLessThan(4);
  });

  it("NOT ready: checks=pending", () => {
    const s = deriveStage({
      git: git({
        ...readyBase,
        checks: "pending",
        latestReview: { state: "approved", author: "x", submittedAt: 0 },
      }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBeLessThan(4);
  });

  it("NOT ready: checks=failure", () => {
    const s = deriveStage({
      git: git({
        ...readyBase,
        checks: "failure",
        latestReview: { state: "approved", author: "x", submittedAt: 0 },
      }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBeLessThan(4);
  });

  it("NOT ready: headSha mismatch on critic verdict", () => {
    const s = deriveStage({
      git: git({ ...readyBase, headSha: "sha1" }),
      verdict: { ...verdict, decision: "commented", headSha: "old" },
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBeLessThan(4);
  });

  it("NOT ready (pinned safe-fail): git.headSha undefined + verdict.headSha undefined — undefined===undefined must not pass", () => {
    // Cross-reference: see the headSha guard explanation in the review-tint suite above.
    const s = deriveStage({
      git: git({ ...readyBase, headSha: undefined }),
      verdict: { ...verdict, decision: "commented", headSha: undefined as unknown as string },
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBeLessThan(4);
  });
});

describe("deriveStage — ready: manual paths", () => {
  it("readyToMerge=true → index 4", () => {
    const s = deriveStage({
      git: git({ state: "open", checks: "success" }),
      reviewing: false,
      readyToMerge: true,
    });
    expect(s.index).toBe(4);
    expect(s.reached).toBe("ready");
    expect(s.terminal).toBeNull();
  });

  it("merged → index 4 + terminal='merged'", () => {
    const s = deriveStage({
      git: git({ state: "merged", checks: "success" }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBe(4);
    expect(s.reached).toBe("ready");
    expect(s.terminal).toBe("merged");
  });
});

describe("deriveStage — terminal", () => {
  it("closed → terminal='closed'", () => {
    const s = deriveStage({
      git: git({ state: "closed", checks: "failure" }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.terminal).toBe("closed");
    expect(s.ci).toBe("failure");
    // closed never enters the open branch → implementing
    expect(s.index).toBe(1);
    expect(s.reached).toBe("implementing");
  });

  it("no git → terminal=null", () => {
    const s = deriveStage({ reviewing: false, readyToMerge: false });
    expect(s.terminal).toBeNull();
  });
});

describe("deriveStage — STAGE_ORDER invariant", () => {
  it("index matches reached in STAGE_ORDER", () => {
    const s = deriveStage({
      git: git({ state: "open", checks: "pending" }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(STAGE_ORDER[s.index]).toBe(s.reached);
  });
});

describe("deriveStage — furthest-wins interactions", () => {
  it("planPhase='planning' + git.state='open' → index===PR_INDEX (Math.max furthest-wins)", () => {
    // Planning is index 0, pr is index 2 — open PR must win via Math.max.
    const s = deriveStage({
      planPhase: "planning",
      git: git({ state: "open", checks: "none" }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBe(PR_INDEX);
    expect(s.reached).toBe("pr");
  });

  it("derived-ready conditions met + reviewing=true → index 4 AND review tint 'reviewing'", () => {
    // Running review wins the tint but doesn't un-light the ready segment.
    const s = deriveStage({
      git: git({
        state: "open",
        checks: "success",
        mergeable: true,
        isDraft: false,
        headSha: "sha1",
        latestReview: { state: "approved", author: "x", submittedAt: 0 },
      }),
      reviewing: true,
      readyToMerge: false,
    });
    expect(s.index).toBe(4);
    expect(s.reached).toBe("ready");
    expect(s.review).toBe("reviewing");
  });
});
