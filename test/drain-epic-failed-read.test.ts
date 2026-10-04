import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { EpicStructure, GitForge, Issue, PrStatus } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";

// A forge read that fails during a GitHub rate limit must never read as "every child closed":
// that auto-completed a live epic and stopped its run. With no complete structure cached yet, the
// GitHub forge serves a partial one whose failed sub-issue read is empty, so the drain reads the
// epic from the parent's markdown — where a failed open-issue listing made every member "closed".

const REPO = "/repo";
const PARENT = 67;

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

/** The partial structure: the parent (its body lists the children), no sub-issues read. */
const PARTIAL: EpicStructure = {
  parent: {
    number: PARENT,
    title: "Epic",
    body: "```epic-dag\n#29\n#30 <- #29\n```",
    url: `https://x/${PARENT}`,
    labels: [],
    createdAt: 0,
    assignees: [],
  },
  subIssues: [],
  blockedBy: new Map(),
};

function makeHarness(listIssues: () => Promise<Issue[]>) {
  const forge: GitForge = {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues,
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }) as PrStatus,
    openPr: async () => ({ state: "open", checks: "none", deployConfigured: false }) as PrStatus,
    defaultBranch: async () => "main",
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    closeIssue: async () => {},
    ensureIssueLink: async () => {},
    addIssueLabel: async () => {},
    removeIssueLabel: async () => {},
    getEpicStructure: async () => PARTIAL,
  };
  const store = new SessionStore(":memory:");
  store.setEpicRun({ repoPath: REPO, parentIssueNumber: PARENT, mode: "auto", status: "running" });
  const drain = new DrainService({
    store,
    service: { create: async () => ({}), archive: () => 1 } as never,
    resolveForge: () => forge,
    prCache: { snapshot: () => ({}) },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    emitEpic: () => {},
    rebaseCap: 5,
  });
  return { store, drain };
}

describe("a failed forge read never auto-completes a running epic", () => {
  test("a failed open-issue listing yields no epic, not an all-closed one", async () => {
    const h = makeHarness(async () => {
      throw new Error("GitHub rate limit backoff active on both buckets (…); skipped");
    });

    expect(await h.drain.buildEpic(REPO, h.store.getEpicRun(REPO)!)).toBeNull();
    await h.drain.pump(REPO);

    expect(h.store.listEpicCompleted(REPO)).toHaveLength(0);
    expect(h.store.getEpicRun(REPO)?.status).toBe("running");
  });

  test("a successful listing still resolves members missing from it as closed", async () => {
    const h = makeHarness(async () => [
      {
        number: 30,
        title: "child 30",
        url: "https://x/30",
        body: "",
        labels: [],
        createdAt: 0,
        assignees: [],
      },
    ]);

    const epic = await h.drain.buildEpic(REPO, h.store.getEpicRun(REPO)!);
    expect(epic?.children.map((c) => [c.number, c.issueClosed])).toEqual([
      [29, true],
      [30, false],
    ]);
  });
});
