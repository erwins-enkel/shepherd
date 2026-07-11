import { describe, it, expect, test } from "vitest";
import {
  collectReadyPrs,
  formatReadyPrs,
  mergeTrainCreateInput,
  pickTrainRepo,
  isMerging,
  MERGE_MARK_BACKSTOP_MS,
} from "./merge-train";
import type { Session, GitState } from "$lib/types";

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-01",
    name: "n",
    prompt: "p",
    repoPath: "/repo/a",
    baseBranch: "main",
    branch: null,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "ha",
    claudeSessionId: "cs",
    model: null,
    status: "idle",
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    ...partial,
  };
}

function openPr(number: number, title: string, url: string): GitState {
  return {
    kind: "github",
    state: "open",
    number,
    url,
    title,
    mergeable: true,
    checks: "success",
    deployConfigured: false,
  };
}

describe("collectReadyPrs", () => {
  it("returns ready-to-merge sessions that have an open PR", () => {
    const sessions = [
      session({ id: "a", readyToMerge: true, repoPath: "/repo/a" }),
      session({ id: "b", readyToMerge: false, repoPath: "/repo/a" }),
      session({ id: "c", readyToMerge: true, repoPath: "/repo/a" }),
    ];
    const git: Record<string, GitState> = {
      a: openPr(11, "feat: a", "https://h/pull/11"),
      b: openPr(22, "feat: b", "https://h/pull/22"),
      // c has no PR
    };
    const prs = collectReadyPrs(sessions, git);
    expect(prs).toEqual([
      {
        sessionId: "a",
        number: 11,
        title: "feat: a",
        url: "https://h/pull/11",
        repoPath: "/repo/a",
      },
    ]);
  });

  it("excludes ready sessions whose PR already merged", () => {
    const sessions = [session({ id: "a", readyToMerge: true })];
    const git: Record<string, GitState> = {
      a: { ...openPr(11, "t", "u"), state: "merged" },
    };
    expect(collectReadyPrs(sessions, git)).toEqual([]);
  });

  it("tolerates a missing title/url", () => {
    const sessions = [session({ id: "a", readyToMerge: true, repoPath: "/repo/a" })];
    const git: Record<string, GitState> = {
      a: { kind: "github", state: "open", number: 9, checks: "success", deployConfigured: false },
    };
    expect(collectReadyPrs(sessions, git)).toEqual([
      { sessionId: "a", number: 9, title: "", url: "", repoPath: "/repo/a" },
    ]);
  });

  it("excludes an in-review ready-to-merge session with an open PR", () => {
    const sessions = [session({ id: "a", readyToMerge: true, repoPath: "/repo/a" })];
    const git: Record<string, GitState> = { a: openPr(11, "feat: a", "https://h/pull/11") };
    // review in flight → not settled, drop it even though the PR is open
    expect(collectReadyPrs(sessions, git, (id) => id === "a")).toEqual([]);
  });

  it("includes the same session once its review clears (predicate false)", () => {
    const sessions = [session({ id: "a", readyToMerge: true, repoPath: "/repo/a" })];
    const git: Record<string, GitState> = { a: openPr(11, "feat: a", "https://h/pull/11") };
    expect(collectReadyPrs(sessions, git, () => false)).toEqual([
      {
        sessionId: "a",
        number: 11,
        title: "feat: a",
        url: "https://h/pull/11",
        repoPath: "/repo/a",
      },
    ]);
  });

  it("count==action: display subset and full set agree on dropping the in-review PR", () => {
    // display path (Herd.svelte) collects from a filtered `shown` subset; the
    // action path (+page.svelte) collects from the full session list. With the
    // same predicate both must drop the in-review session so the link can never
    // advertise a train target the click then merges.
    const inReview = session({ id: "a", readyToMerge: true, repoPath: "/repo/a" });
    const settled = session({ id: "b", readyToMerge: true, repoPath: "/repo/a" });
    const full = [inReview, settled];
    const subset = [settled]; // `a` filtered out of the displayed list
    const git: Record<string, GitState> = {
      a: openPr(11, "feat: a", "https://h/pull/11"),
      b: openPr(22, "feat: b", "https://h/pull/22"),
    };
    const isReviewing = (id: string) => id === "a";
    const expected = [
      {
        sessionId: "b",
        number: 22,
        title: "feat: b",
        url: "https://h/pull/22",
        repoPath: "/repo/a",
      },
    ];
    expect(collectReadyPrs(full, git, isReviewing)).toEqual(expected);
    expect(collectReadyPrs(subset, git, isReviewing)).toEqual(expected);
  });

  it("default 2-arg call keeps current behavior (no review exclusion)", () => {
    const sessions = [session({ id: "a", readyToMerge: true, repoPath: "/repo/a" })];
    const git: Record<string, GitState> = { a: openPr(11, "feat: a", "https://h/pull/11") };
    // omitting the predicate defaults to () => false → in-review state irrelevant
    expect(collectReadyPrs(sessions, git)).toEqual([
      {
        sessionId: "a",
        number: 11,
        title: "feat: a",
        url: "https://h/pull/11",
        repoPath: "/repo/a",
      },
    ]);
  });
});

describe("formatReadyPrs", () => {
  it("formats one bullet per PR with number, title and url", () => {
    const out = formatReadyPrs([
      { number: 11, title: "feat: a", url: "https://h/pull/11" },
      { number: 22, title: "fix: b", url: "https://h/pull/22" },
    ]);
    expect(out).toBe("- #11 feat: a — https://h/pull/11\n- #22 fix: b — https://h/pull/22");
  });

  it("omits an empty title and an empty url gracefully", () => {
    expect(formatReadyPrs([{ number: 9, title: "", url: "" }])).toBe("- #9");
    expect(formatReadyPrs([{ number: 9, title: "t", url: "" }])).toBe("- #9 t");
    expect(formatReadyPrs([{ number: 9, title: "", url: "u" }])).toBe("- #9 — u");
  });
});

describe("pickTrainRepo", () => {
  it("picks the repo with the most ready PRs and scopes to it", () => {
    const prs = [
      { sessionId: "s1", number: 1, title: "a", url: "u1", repoPath: "/repo/a" },
      { sessionId: "s2", number: 2, title: "b", url: "u2", repoPath: "/repo/b" },
      { sessionId: "s3", number: 3, title: "c", url: "u3", repoPath: "/repo/a" },
    ];
    const r = pickTrainRepo(prs);
    expect(r.repoPath).toBe("/repo/a");
    expect(r.prs.map((p) => p.number)).toEqual([1, 3]);
    expect(r.otherRepoCount).toBe(1);
  });

  it("reports zero other-repo PRs when all share a repo", () => {
    const prs = [
      { sessionId: "s1", number: 1, title: "a", url: "u1", repoPath: "/repo/a" },
      { sessionId: "s2", number: 2, title: "b", url: "u2", repoPath: "/repo/a" },
    ];
    const r = pickTrainRepo(prs);
    expect(r.repoPath).toBe("/repo/a");
    expect(r.otherRepoCount).toBe(0);
  });

  it("returns null repo for an empty list", () => {
    expect(pickTrainRepo([])).toEqual({ repoPath: null, prs: [], otherRepoCount: 0 });
  });
});

describe("mergeTrainCreateInput", () => {
  const prs = [
    {
      sessionId: "s1",
      number: 11,
      title: "feat: a",
      url: "https://h/pull/11",
      repoPath: "/repo/a",
    },
    { sessionId: "s2", number: 22, title: "fix: b", url: "https://h/pull/22", repoPath: "/repo/a" },
  ];

  it("always skips the plan gate (planGateEnabled === false)", () => {
    expect(mergeTrainCreateInput("/repo/a", "main", prs).planGateEnabled).toBe(false);
  });

  it("always launches the driver with autopilot off (autopilotEnabled === false)", () => {
    expect(mergeTrainCreateInput("/repo/a", "main", prs).autopilotEnabled).toBe(false);
  });

  it("passes through repoPath/baseBranch with null model and a non-empty prompt", () => {
    const input = mergeTrainCreateInput("/repo/a", "main", prs);
    expect(input.repoPath).toBe("/repo/a");
    expect(input.baseBranch).toBe("main");
    expect(input.model).toBeNull();
    expect(typeof input.prompt).toBe("string");
    expect(input.prompt.length).toBeGreaterThan(0);
  });

  it("includes mergeTrainPrs as the PR numbers (default call)", () => {
    expect(mergeTrainCreateInput("/repo/a", "main", prs).mergeTrainPrs).toEqual([11, 22]);
  });

  it("includes mergeTrainPrs as the PR numbers (handpicked call)", () => {
    expect(mergeTrainCreateInput("/repo/a", "main", prs, true).mergeTrainPrs).toEqual([11, 22]);
  });
});

test("isMerging: marked + within backstop true; null/aged-past-backstop false; 30-min cliff gone", () => {
  const now = 1_000_000_000;
  const make = (mergingSince: number | null) => ({
    ...session({ id: "m" }),
    mergingSince,
    mergingTrainId: mergingSince ? "t" : null,
  });
  expect(isMerging(make(null), now)).toBe(false);
  expect(isMerging(make(now - 1000), now)).toBe(true);
  // 31 min old is now still merging — proves the old 30-min cliff is gone.
  expect(isMerging(make(now - 31 * 60_000), now)).toBe(true);
  // Past the 24h safety backstop → no longer merging.
  expect(isMerging(make(now - MERGE_MARK_BACKSTOP_MS - 1), now)).toBe(false);
});

describe("mergeTrainCreateInput with handpicked param", () => {
  // A session-less item (e.g. a PullRequest from the PRs panel with no sessionId)
  const prsNoSession = [
    { number: 11, title: "feat: a", url: "https://h/pull/11" },
    { number: 22, title: "fix: b", url: "https://h/pull/22" },
  ];

  it("accepts Pick<ReadyPr> items without sessionId", () => {
    const input = mergeTrainCreateInput("/repo/a", "main", prsNoSession);
    expect(typeof input.prompt).toBe("string");
    expect(input.prompt.length).toBeGreaterThan(0);
  });

  it("default (handpicked=false) uses herd framing (flagged ready)", () => {
    const input = mergeTrainCreateInput("/repo/a", "main", prsNoSession, false);
    expect(input.prompt).toContain("flagged ready to merge");
    expect(input.prompt).toContain("Ready-to-merge PRs:");
  });

  it("handpicked=true uses selected framing", () => {
    const input = mergeTrainCreateInput("/repo/a", "main", prsNoSession, true);
    expect(input.prompt).toContain("I've selected");
    expect(input.prompt).toContain("Selected PRs:");
  });

  it("handpicked=true and false produce different prompts", () => {
    const defaultInput = mergeTrainCreateInput("/repo/a", "main", prsNoSession, false);
    const handpickedInput = mergeTrainCreateInput("/repo/a", "main", prsNoSession, true);
    expect(defaultInput.prompt).not.toBe(handpickedInput.prompt);
  });

  it("always skips plan gate regardless of handpicked", () => {
    expect(mergeTrainCreateInput("/repo/a", "main", prsNoSession, false).planGateEnabled).toBe(
      false,
    );
    expect(mergeTrainCreateInput("/repo/a", "main", prsNoSession, true).planGateEnabled).toBe(
      false,
    );
  });

  it("always launches with autopilot off regardless of handpicked", () => {
    expect(mergeTrainCreateInput("/repo/a", "main", prsNoSession, false).autopilotEnabled).toBe(
      false,
    );
    expect(mergeTrainCreateInput("/repo/a", "main", prsNoSession, true).autopilotEnabled).toBe(
      false,
    );
  });
});
