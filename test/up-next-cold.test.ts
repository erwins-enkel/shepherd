import { afterEach, expect, test } from "bun:test";
import {
  GithubReadCache,
  type GithubCacheRow,
  type GithubCacheStore,
} from "../src/github-read-cache";
import { GithubForge, type GhRunner } from "../src/forge/github";
import { graphRateLimit } from "../src/forge/rate-limit";
import { OpenPrSnapshotService } from "../src/open-pr-snapshot";
import { UpNextService } from "../src/up-next";
import { inLiveColdRead } from "../src/repo-warmth";
import type { OpenPrSnapshot, PullRequest } from "../src/forge/types";

class MemoryStore implements GithubCacheStore {
  rows: GithubCacheRow[] = [];
  listGithubReadCache() {
    return this.rows.map((r) => ({ ...r }));
  }
  putGithubReadCache(row: GithubCacheRow) {
    this.deleteGithubReadCache(row.slug, row.kind, row.entryKey);
    this.rows.push({ ...row });
  }
  deleteGithubReadCache(slug: string, kind: string, entryKey?: string) {
    this.rows = this.rows.filter(
      (r) =>
        r.slug !== slug || r.kind !== kind || (entryKey !== undefined && r.entryKey !== entryKey),
    );
  }
}

const issueRow = (number: number, title: string) => ({
  number,
  title,
  body: "",
  url: `u${number}`,
  createdAt: "2026-10-01T00:00:00Z",
  labels: [],
  assignees: [],
});

const RELATIONS = {
  data: {
    repository: {
      issues: {
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            number: 10,
            subIssuesSummary: { total: 1, completed: 0 },
            parent: null,
            blockedBy: { nodes: [] },
          },
          {
            number: 11,
            subIssuesSummary: { total: 0, completed: 0 },
            parent: { number: 10 },
            blockedBy: { nodes: [] },
          },
        ],
      },
    },
  },
};

const EPIC = {
  data: {
    repository: {
      issue: {
        ...issueRow(10, "Epic"),
        state: "OPEN",
        labels: { nodes: [] },
        assignees: { nodes: [] },
        subIssues: {
          nodes: [
            {
              number: 11,
              title: "Child",
              body: "",
              url: "u11",
              state: "OPEN",
              labels: { nodes: [] },
              blockedBy: { nodes: [] },
            },
          ],
        },
      },
    },
  },
};

const openPr = (number: number): PullRequest =>
  ({
    number,
    title: `pr${number}`,
    url: `https://x/pull/${number}`,
    author: "alice",
    kind: "regular",
    createdAt: 1,
    isDraft: false,
    mergeable: true,
    mergeStateStatus: "clean",
    checks: "success",
    jobs: [],
    baseRefName: "main",
    headRefName: `b${number}`,
    headSha: `sha${number}`,
    headPushable: true,
  }) as unknown as PullRequest;

const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
  graphRateLimit.noteSuccess();
});

test("a cold repo comes from cache with asOf and costs no gh call; the manual refresh reads it live (#2837)", async () => {
  let now = 1_800_000_000_000;
  Date.now = () => now; // allowedMergeMethods' 10-min memo runs on the wall clock
  let warm = true;
  const calls: string[] = [];
  const run: GhRunner = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "issue" && args[1] === "list")
      return JSON.stringify([issueRow(10, "Epic"), issueRow(20, "Standalone")]);
    if (args[0] === "api" && args[1] === "user") return "alice";
    if (args[0] === "api" && args[1] === "repos/o/r")
      return JSON.stringify({
        allow_merge_commit: false,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    if (query.includes("closingIssuesReferences"))
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
          },
        },
      });
    if (query.includes("subIssuesSummary")) return JSON.stringify(RELATIONS);
    if (query.includes("issue(number:")) return JSON.stringify(EPIC);
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const cache = new GithubReadCache(new MemoryStore(), {
    now: () => now,
    frozen: () => !warm && !inLiveColdRead(),
  });
  const forge = new GithubForge("o/r", {}, run, undefined, undefined, cache);
  let snapshotReads = 0;
  forge.listOpenPrSnapshot = async (): Promise<OpenPrSnapshot> => {
    snapshotReads++;
    calls.push("pr snapshot");
    return { prs: [openPr(4)], statuses: new Map(), capped: false };
  };
  const snapshots = new OpenPrSnapshotService(
    () => now,
    6,
    cache,
    () => {},
  );
  const coldUncached = new GithubForge("o/x", {}, run, undefined, undefined, cache);
  const svc = new UpNextService({
    listForgeRepos: () => [
      { repoPath: "/r/r", repoSlug: "o/r", repoLabel: "r" },
      { repoPath: "/r/x", repoSlug: "o/x", repoLabel: "x" },
    ],
    resolveForge: (p) => (p === "/r/r" ? forge : coldUncached),
    lastUsedByRepo: () => ({ "/r/r": 1 }),
    buildEpic: async () => {
      await forge.getEpicStructure(10);
      return null;
    },
    getEpicRun: () => null,
    onChange: () => {},
    now: () => now,
    openPrSnapshot: snapshots,
    isWarm: (p) => warm && p === "/r/r",
    cachedIssuesAt: (slug) => cache.get("issues", slug)?.at ?? null,
    realpath: (p) => p,
  });

  // Warm: o/r is read live and cached. o/x is cold from the start with nothing cached.
  const first = await svc.refresh();
  const fetchedAt = now;
  expect(first.sections.flatMap((s) => s.items).some((i) => i.number === 20)).toBe(true);
  expect(first.coldSkippedCount).toBe(1);
  const warmCalls = calls.length;
  expect(calls.some((c) => c.includes("repos/o/r"))).toBe(true);
  expect(snapshotReads).toBe(1);

  // Cold: two background computes, more than 10 min apart, make no gh call at all.
  warm = false;
  for (let i = 0; i < 2; i++) {
    now += 11 * 60_000;
    const snap = await svc.refresh();
    const items = snap.sections.flatMap((s) => s.items);
    expect(items.find((it) => it.number === 20)?.asOf).toBe(fetchedAt);
    expect(snap.pullRequests?.length).toBe(1);
    expect(snap.coldSkippedCount).toBe(2 - 1); // o/x still has nothing cached
  }
  expect(calls.slice(warmCalls)).toEqual([]);

  // The manual refresh reads cold repos live, including the uncached one.
  await svc.refreshLive();
  const live = calls.slice(warmCalls);
  expect(live.some((c) => c.includes("repos/o/r"))).toBe(true);
  expect(live.some((c) => c.startsWith("issue list") && c.includes("o/x"))).toBe(true);
});
