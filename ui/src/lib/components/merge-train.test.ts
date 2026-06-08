import { describe, it, expect, test } from "vitest";
import {
  collectReadyPrs,
  formatReadyPrs,
  pickTrainRepo,
  isMerging,
  MERGE_STALE_MS,
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
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotQuestion: null,
    auto: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
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
      { number: 11, title: "feat: a", url: "https://h/pull/11", repoPath: "/repo/a" },
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
      { number: 9, title: "", url: "", repoPath: "/repo/a" },
    ]);
  });
});

describe("formatReadyPrs", () => {
  it("formats one bullet per PR with number, title and url", () => {
    const out = formatReadyPrs([
      { number: 11, title: "feat: a", url: "https://h/pull/11", repoPath: "/r" },
      { number: 22, title: "fix: b", url: "https://h/pull/22", repoPath: "/r" },
    ]);
    expect(out).toBe("- #11 feat: a — https://h/pull/11\n- #22 fix: b — https://h/pull/22");
  });

  it("omits an empty title and an empty url gracefully", () => {
    expect(formatReadyPrs([{ number: 9, title: "", url: "", repoPath: "/r" }])).toBe("- #9");
    expect(formatReadyPrs([{ number: 9, title: "t", url: "", repoPath: "/r" }])).toBe("- #9 t");
    expect(formatReadyPrs([{ number: 9, title: "", url: "u", repoPath: "/r" }])).toBe("- #9 — u");
  });
});

describe("pickTrainRepo", () => {
  it("picks the repo with the most ready PRs and scopes to it", () => {
    const prs = [
      { number: 1, title: "a", url: "u1", repoPath: "/repo/a" },
      { number: 2, title: "b", url: "u2", repoPath: "/repo/b" },
      { number: 3, title: "c", url: "u3", repoPath: "/repo/a" },
    ];
    const r = pickTrainRepo(prs);
    expect(r.repoPath).toBe("/repo/a");
    expect(r.prs.map((p) => p.number)).toEqual([1, 3]);
    expect(r.otherRepoCount).toBe(1);
  });

  it("reports zero other-repo PRs when all share a repo", () => {
    const prs = [
      { number: 1, title: "a", url: "u1", repoPath: "/repo/a" },
      { number: 2, title: "b", url: "u2", repoPath: "/repo/a" },
    ];
    const r = pickTrainRepo(prs);
    expect(r.repoPath).toBe("/repo/a");
    expect(r.otherRepoCount).toBe(0);
  });

  it("returns null repo for an empty list", () => {
    expect(pickTrainRepo([])).toEqual({ repoPath: null, prs: [], otherRepoCount: 0 });
  });
});

test("isMerging: true when marked and within TTL, false when null or stale", () => {
  const now = 1_000_000_000;
  const make = (mergingSince: number | null) => ({
    ...session({ id: "m" }),
    mergingSince,
    mergingTrainId: mergingSince ? "t" : null,
  });
  expect(isMerging(make(null), now)).toBe(false);
  expect(isMerging(make(now - 1000), now)).toBe(true);
  expect(isMerging(make(now - MERGE_STALE_MS - 1), now)).toBe(false);
});
