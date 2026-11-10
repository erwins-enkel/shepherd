import { test, expect, spyOn } from "bun:test";
import {
  completedEpicScopeRepos,
  reconcileCompletedEpicsForRepo,
  type CompletedEpicsReconcileDeps,
} from "../src/completed-epics-reconcile";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import type { Epic, EpicChild, EpicRun } from "../src/epic-core";
import type { Issue, PrStatus } from "../src/forge/types";

const REPO = "/repos/app";

function child(number: number, state: EpicChild["state"]): EpicChild {
  return {
    number,
    title: `Child #${number}`,
    url: `https://x/issues/${number}`,
    order: number,
    body: "",
    blockedBy: [],
    state,
    sessionId: null,
    prNumber: null,
    issueClosed: state === "merged",
    integrationMerged: state === "merged",
    claimed: true,
  };
}

function issue(number: number): Issue {
  return {
    number,
    title: `#${number}`,
    body: "",
    url: "u",
    labels: [],
    createdAt: 0,
    assignees: [],
  };
}

function setup(o: {
  open: number[];
  children?: EpicChild[];
  closeIssue?: () => Promise<void>;
  prStatus?: (branch: string) => Promise<Partial<PrStatus>>;
}) {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const cleared: unknown[] = [];
  const pushed: { parentIssueNumber: number; outcome?: unknown; landingState: string }[] = [];
  const closed: number[] = [];
  events.subscribe((event, data) => {
    if (event === "epic:completed-cleared") cleared.push(data);
    if (event === "epic:completed") pushed.push(data as (typeof pushed)[number]);
  });
  const deps: CompletedEpicsReconcileDeps = {
    store,
    events,
    drain: {
      buildEpic: async (repoPath: string, run: EpicRun): Promise<Epic> => {
        return {
          repoPath,
          parentIssueNumber: run.parentIssueNumber,
          parentTitle: "Parent",
          source: "native",
          children: o.children ?? [],
          warnings: [],
          run,
        };
      },
    },
    resolveForge: () =>
      ({
        listIssues: async () => o.open.map(issue),
        closeIssue: async (n: number) => {
          closed.push(n);
          await o.closeIssue?.();
        },
        prStatus: async (branch: string) => (o.prStatus ? o.prStatus(branch) : { state: "none" }),
      }) as any,
  };
  return { store, deps, cleared, pushed, closed };
}

test("auto-dismisses a completed epic whose parent left the open set", async () => {
  const { store, deps, cleared } = setup({ open: [2] });
  store.recordEpicCompleted({
    repoPath: REPO,
    parentIssueNumber: 1,
    parentTitle: "Closed",
    completedAt: 1,
    childrenJson: "[]",
  });
  await reconcileCompletedEpicsForRepo(deps, REPO);
  expect(cleared).toEqual([{ repoPath: REPO, parentIssueNumber: 1 }]);
  expect(store.listEpicCompleted(REPO)).toEqual([]);
});

test("backfills an idle run whose children are all merged", async () => {
  const { store, deps } = setup({ open: [9], children: [child(1, "merged"), child(2, "merged")] });
  store.setEpicRun({ repoPath: REPO, parentIssueNumber: 9, mode: "auto", status: "idle" });
  await reconcileCompletedEpicsForRepo(deps, REPO);
  const rows = store.listEpicCompleted(REPO);
  expect(rows.map((r) => [r.parentIssueNumber, r.landingState])).toEqual([[9, "pending"]]);
});

test("#3191/#3838: an idle all-merged incremental epic closes its open parent and records its success", async () => {
  const { store, deps, closed } = setup({
    open: [9],
    children: [child(1, "merged"), child(2, "merged")],
  });
  store.setEpicRun({
    repoPath: REPO,
    parentIssueNumber: 9,
    mode: "auto",
    status: "idle",
    landing: "incremental",
  });
  await reconcileCompletedEpicsForRepo(deps, REPO);
  expect(closed).toEqual([9]);
  expect(store.listEpicCompleted(REPO)).toMatchObject([
    { parentIssueNumber: 9, landingState: "none", outcome: "incremental", acknowledgedAt: null },
  ]);
});

test("#3191: a closed parent or an unmerged child never triggers the close", async () => {
  const done = setup({ open: [], children: [child(1, "merged")] });
  done.store.setEpicRun({
    repoPath: REPO,
    parentIssueNumber: 9,
    mode: "auto",
    status: "idle",
    landing: "incremental",
  });
  await reconcileCompletedEpicsForRepo(done.deps, REPO);
  expect(done.closed).toEqual([]);

  const partial = setup({ open: [9], children: [child(1, "merged"), child(2, "in-review")] });
  partial.store.setEpicRun({
    repoPath: REPO,
    parentIssueNumber: 9,
    mode: "auto",
    status: "idle",
    landing: "incremental",
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await reconcileCompletedEpicsForRepo(partial.deps, REPO);
  } finally {
    warn.mockRestore();
  }
  expect(partial.closed).toEqual([]);
  expect(partial.store.listEpicCompleted(REPO)).toEqual([]);
});

test("#3191: a failing close only logs; the success is still recorded", async () => {
  const { store, deps, closed } = setup({
    open: [9],
    children: [child(1, "merged")],
    closeIssue: async () => {
      throw new Error("boom");
    },
  });
  store.setEpicRun({
    repoPath: REPO,
    parentIssueNumber: 9,
    mode: "auto",
    status: "idle",
    landing: "incremental",
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await reconcileCompletedEpicsForRepo(deps, REPO);
    expect(warn.mock.calls[0]?.[0]).toContain("closing incremental epic");
  } finally {
    warn.mockRestore();
  }
  expect(closed).toEqual([9]);
  expect(store.listEpicCompleted(REPO).map((r) => r.outcome)).toEqual(["incremental"]);
});

test("skips (and says so) an idle run with unmerged children", async () => {
  const { store, deps } = setup({
    open: [9],
    children: [child(1, "merged"), child(2, "in-review")],
  });
  store.setEpicRun({ repoPath: REPO, parentIssueNumber: 9, mode: "auto", status: "idle" });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await reconcileCompletedEpicsForRepo(deps, REPO);
    expect(warn.mock.calls[0]?.[0]).toContain("backfill skipped");
  } finally {
    warn.mockRestore();
  }
  expect(store.listEpicCompleted(REPO)).toEqual([]);
});

test("a forge error skips the repo; no forge skips it without a call", async () => {
  const { store, deps, cleared } = setup({ open: [] });
  store.recordEpicCompleted({
    repoPath: REPO,
    parentIssueNumber: 1,
    parentTitle: "Kept",
    completedAt: 1,
    childrenJson: "[]",
  });
  await reconcileCompletedEpicsForRepo(
    {
      ...deps,
      resolveForge: () =>
        ({
          listIssues: async () => {
            throw new Error("boom");
          },
        }) as any,
    },
    REPO,
  );
  await reconcileCompletedEpicsForRepo({ ...deps, resolveForge: () => null }, REPO);
  expect(cleared).toEqual([]);
  expect(store.listEpicCompleted(REPO)).toHaveLength(1);
});

test("completedEpicScopeRepos: repos with a completed row plus repos with an idle run, once each", () => {
  const { store } = setup({ open: [] });
  store.recordEpicCompleted({
    repoPath: "/a",
    parentIssueNumber: 1,
    parentTitle: "A",
    completedAt: 1,
    childrenJson: "[]",
  });
  store.setEpicRun({ repoPath: "/a", parentIssueNumber: 2, mode: "auto", status: "idle" });
  store.setEpicRun({ repoPath: "/b", parentIssueNumber: 3, mode: "auto", status: "idle" });
  store.setEpicRun({ repoPath: "/c", parentIssueNumber: 4, mode: "auto", status: "running" });
  expect(completedEpicScopeRepos(store).sort()).toEqual(["/a", "/b"]);
});

// ── #3838: a success stays visible until the operator acknowledges it ──

/** sevdesk-mcp #23's shape: an integration epic whose open landing PR #45 merged, which closed
 *  the parent before the drain observed the merge. */
function seedLandingEpic(store: SessionStore, parent: number): string {
  store.recordEpicCompleted({
    repoPath: REPO,
    parentIssueNumber: parent,
    parentTitle: "M0: Code-Mode spine",
    completedAt: 1_000,
    childrenJson: JSON.stringify([
      {
        number: 3,
        title: "docs",
        url: "https://x/issues/3",
        prNumber: 25,
        prUrl: "https://x/pull/25",
        mergedAt: 900,
        integrated: true,
      },
    ]),
  });
  store.setEpicLandingPr(REPO, parent, {
    state: "open",
    prNumber: 45,
    prUrl: "https://x/pull/45",
    attempts: 1,
  });
  return store.getOrInitEpicIntegrationBranch(REPO, parent, `epic/${parent}-m0`);
}

function session(store: SessionStore, name: string) {
  return store.create({
    name,
    prompt: name,
    repoPath: REPO,
    baseBranch: "main",
    branch: `shepherd/${name}`,
    worktreePath: `/wt/${name}`,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: `term_${name}`,
  });
}

test("#3838 sevdesk-mcp #23: landed epic stays visible with its child sessions gone and only the draft session left", async () => {
  let branchRead = "";
  const { store, deps, cleared, pushed } = setup({
    open: [],
    prStatus: async (branch) => {
      branchRead = branch;
      return { state: "merged", number: 45, url: "https://x/pull/45" };
    },
  });
  const branch = seedLandingEpic(store, 23);
  const child = session(store, "child-3");
  store.archive(child.id, "merged");
  const draft = session(store, "backlog-epic-entwurf");

  await reconcileCompletedEpicsForRepo(deps, REPO);

  expect(branchRead).toBe(branch);
  expect(cleared).toEqual([]);
  const [row] = store.listEpicCompleted(REPO);
  expect(row).toMatchObject({
    parentIssueNumber: 23,
    landingState: "merged",
    landingPrNumber: 45,
    outcome: "landed",
    acknowledgedAt: null,
  });
  expect(row!.succeededAt).toBeNumber();
  expect(pushed).toMatchObject([
    { parentIssueNumber: 23, landingState: "merged", outcome: "landed" },
  ]);

  // Archiving the draft session, a reload (a fresh read) and a later reconcile never acknowledge.
  store.archive(draft.id, "operator");
  await reconcileCompletedEpicsForRepo(deps, REPO);
  expect(store.listEpicCompleted(REPO).map((r) => [r.parentIssueNumber, r.acknowledgedAt])).toEqual(
    [[23, null]],
  );
  expect(cleared).toEqual([]);

  // Only the explicit acknowledgement takes it out of the band; history keeps it.
  expect(store.acknowledgeEpicCompleted(REPO, 23)).toBe(true);
  expect(store.listEpicCompleted(REPO)).toEqual([]);
  const [past] = store.listEpicHistory(REPO);
  expect(past).toMatchObject({ parentIssueNumber: 23, outcome: "landed", landingPrNumber: 45 });
  expect(past!.acknowledgedAt).toBeNumber();
  expect(past!.succeededAt).toBe(row!.succeededAt);
});

test("#3838: a closed parent whose landing never merged settles as closed-unlanded and leaves the band", async () => {
  const { store, deps, cleared, pushed } = setup({
    open: [],
    prStatus: async () => ({ state: "closed" }),
  });
  seedLandingEpic(store, 24);
  await reconcileCompletedEpicsForRepo(deps, REPO);
  expect(cleared).toEqual([{ repoPath: REPO, parentIssueNumber: 24 }]);
  expect(pushed).toEqual([]);
  expect(store.listEpicCompleted(REPO)).toEqual([]);
  expect(store.listEpicHistory(REPO)).toMatchObject([
    { parentIssueNumber: 24, outcome: "closed-unlanded", succeededAt: null, acknowledgedAt: null },
  ]);
  expect(store.acknowledgeEpicCompleted(REPO, 24)).toBe(false);
});

test("#3838: an unreadable landing PR leaves the row for the next reconcile", async () => {
  const { store, deps, cleared } = setup({
    open: [],
    prStatus: async () => {
      throw new Error("rate limited");
    },
  });
  seedLandingEpic(store, 25);
  await reconcileCompletedEpicsForRepo(deps, REPO);
  expect(cleared).toEqual([]);
  expect(store.listEpicCompleted(REPO)).toMatchObject([
    { parentIssueNumber: 25, landingState: "open", outcome: null },
  ]);
});

test("#3838: integrated children with the landing still open are no success", async () => {
  const { store, deps, cleared } = setup({ open: [26] });
  seedLandingEpic(store, 26);
  await reconcileCompletedEpicsForRepo(deps, REPO);
  expect(cleared).toEqual([]);
  expect(store.listEpicCompleted(REPO)).toMatchObject([
    { parentIssueNumber: 26, landingState: "open", outcome: null, succeededAt: null },
  ]);
  expect(store.listEpicHistory(REPO)).toEqual([]);
});
