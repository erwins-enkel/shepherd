import { test, expect, spyOn } from "bun:test";
import {
  completedEpicScopeRepos,
  reconcileCompletedEpicsForRepo,
  type CompletedEpicsReconcileDeps,
} from "../src/completed-epics-reconcile";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import type { Epic, EpicChild, EpicRun } from "../src/epic-core";
import type { Issue } from "../src/forge/types";

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

function setup(o: { open: number[]; children?: EpicChild[] }) {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const cleared: unknown[] = [];
  events.subscribe((event, data) => {
    if (event === "epic:completed-cleared") cleared.push(data);
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
      }) as any,
  };
  return { store, deps, cleared };
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
