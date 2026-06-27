import { test, expect, describe } from "bun:test";
import { UpNextService, startSerially, type UpNextDeps } from "../src/up-next";
import type { Epic, EpicRun } from "../src/epic-core";
import type { GitForge, Issue } from "../src/forge/types";

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `t${number}`,
    body: "",
    url: `https://x/${number}`,
    labels: [],
    createdAt: number,
    assignees: [],
    ...over,
  };
}

/** Minimal forge stub — only the methods UpNextService calls. */
function fakeForge(over: Partial<GitForge> & { issues?: Issue[] } = {}): GitForge {
  const issues = over.issues ?? [];
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => issues,
    ...over,
  } as unknown as GitForge;
}

function svc(deps: Partial<UpNextDeps> = {}): UpNextService {
  return new UpNextService({
    listForgeRepos: () => [{ repoPath: "/r/a", repoSlug: "o/a", repoLabel: "a" }],
    resolveForge: () => fakeForge({ issues: [issue(1), issue(2)] }),
    lastUsedByRepo: () => ({}),
    buildEpic: async () => null,
    getEpicRun: () => null,
    onChange: () => {},
    now: () => 1000,
    ...deps,
  });
}

describe("UpNextService.refresh", () => {
  test("computes a snapshot from listIssues and emits onChange", async () => {
    let emitted = 0;
    const s = svc({ onChange: () => emitted++ });
    const snap = await s.refresh();
    expect(snap.repoCount).toBe(1);
    expect(snap.sections.find((x) => x.kind === "repo")!.items.map((i) => i.number)).toEqual([
      1, 2,
    ]);
    expect(emitted).toBe(1);
    expect(s.snapshot()).toBe(snap);
  });

  test("a repo whose listIssues throws is dropped (no section)", async () => {
    const s = svc({
      resolveForge: () =>
        fakeForge({
          listIssues: async () => {
            throw new Error("boom");
          },
        }),
    });
    const snap = await s.refresh();
    expect(snap.sections).toEqual([]);
  });

  test("refresh is single-flight (concurrent callers share one compute)", async () => {
    let computes = 0;
    const s = svc({
      resolveForge: () => {
        computes++;
        return fakeForge({ issues: [issue(1)] });
      },
    });
    await Promise.all([s.refresh(), s.refresh(), s.refresh()]);
    expect(computes).toBe(1);
  });

  test("epic is resolved via buildEpic + selectEpicCandidates and collapsed to one unit", async () => {
    const epic: Epic = {
      repoPath: "/r/a",
      parentIssueNumber: 100,
      parentTitle: "epic",
      source: "native",
      run: { repoPath: "/r/a", parentIssueNumber: 100, mode: "auto", status: "idle" } as EpicRun,
      warnings: [],
      children: [
        {
          number: 2,
          title: "child-2",
          url: "https://x/2",
          order: 0,
          body: "b2",
          blockedBy: [],
          state: "ready",
          sessionId: null,
          prNumber: null,
          issueClosed: false,
          integrationMerged: false,
          claimed: false,
        },
        {
          number: 3,
          title: "child-3",
          url: "https://x/3",
          order: 1,
          body: "b3",
          blockedBy: [2],
          state: "blocked",
          sessionId: null,
          prNumber: null,
          issueClosed: false,
          integrationMerged: false,
          claimed: false,
        },
      ],
    };
    const s = svc({
      resolveForge: () =>
        fakeForge({
          issues: [
            issue(1),
            issue(2),
            issue(3),
            issue(100, { body: "```epic-dag\n#2\n#3 <- #2\n```" }),
          ],
        }),
      buildEpic: async () => epic,
    });
    const snap = await s.refresh();
    const items = snap.sections.find((x) => x.kind === "repo")!.items;
    const epicItems = items.filter((i) => i.kind === "epic");
    expect(epicItems).toHaveLength(1);
    expect(epicItems[0]!.number).toBe(2); // ready child is the unit's start target
    expect(epicItems[0]!.epicParent).toEqual({ number: 100, title: "t100" });
    // children #2,#3 and the parent #100 are all removed from the flat standalone list.
    expect(
      items
        .filter((i) => i.kind !== "epic")
        .map((i) => i.number)
        .sort(),
    ).toEqual([1]);
  });
});

describe("startSerially", () => {
  test("never overlaps spawns (max concurrency 1)", async () => {
    let active = 0;
    let maxActive = 0;
    const spawn = async (n: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    };
    const out = await startSerially([1, 2, 3, 4], spawn);
    expect(out).toEqual([2, 4, 6, 8]);
    expect(maxActive).toBe(1);
  });

  test("a throwing spawn aborts the remainder", async () => {
    const seen: number[] = [];
    const spawn = async (n: number) => {
      seen.push(n);
      if (n === 2) throw new Error("nope");
      return n;
    };
    await expect(startSerially([1, 2, 3], spawn)).rejects.toThrow("nope");
    expect(seen).toEqual([1, 2]); // #3 never attempted
  });
});
