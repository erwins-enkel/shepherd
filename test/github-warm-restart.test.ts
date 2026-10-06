import { afterEach, describe, expect, test } from "bun:test";
import {
  GithubReadCache,
  type GithubCacheRow,
  type GithubCacheStore,
} from "../src/github-read-cache";
import { GithubForge, type GhRunner } from "../src/forge/github";
import { RepoFingerprintService, type FingerprintObservation } from "../src/repo-fingerprint";
import { graphRateLimit } from "../src/forge/rate-limit";
import { setIssuesFreshness } from "../src/forge/repo-freshness";
import type { RepoFingerprint } from "../src/forge/github-fingerprint";
import { OpenPrSnapshotService } from "../src/open-pr-snapshot";
import { SessionStore } from "../src/store";
import { CountsService } from "../src/backlog";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

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

const FP: RepoFingerprint = {
  openIssues: 2,
  issuesUpdatedAt: "2026-10-06T10:00:00Z",
  openPrs: 1,
  prsUpdatedAt: "2026-10-06T09:00:00Z",
  ciState: "SUCCESS",
};
const ISSUE = {
  number: 10,
  title: "Epic",
  body: "",
  url: "u10",
  createdAt: "2026-10-01T00:00:00Z",
  labels: [],
  assignees: [],
};
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
            blockedBy: { nodes: [{ number: 12, state: "OPEN" }] },
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
        ...ISSUE,
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
              blockedBy: { nodes: [{ number: 12 }] },
            },
          ],
        },
      },
    },
  },
};

function harness(store: GithubCacheStore = new MemoryStore()) {
  let now = 1_800_000_000_000;
  let blocked = false;
  let remaining = 4_000;
  let current = { ...FP };
  const calls: string[][] = [];
  const observations: FingerprintObservation[] = [];
  let fingerprintCalls = 0;
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify([ISSUE]);
    if (args[0] === "issue") return "";
    if (args[0] === "pr") return "";
    if (args[0] === "api" && args[1] === "user") return "alice";
    if (args.includes("--jq")) return "123";
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    if (query.includes("closingIssuesReferences"))
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  number: 4,
                  author: { login: "alice" },
                  closingIssuesReferences: { nodes: [{ number: 11 }] },
                },
              ],
            },
          },
        },
      });
    if (query.includes("subIssuesSummary")) return JSON.stringify(RELATIONS);
    if (query.includes("issue(number:")) return JSON.stringify(EPIC);
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const boot = () => {
    const cache: GithubReadCache = new GithubReadCache(store, {
      now: () => now,
      canRefresh: () => svc.backgroundReady(),
    });
    const svc = new RepoFingerprintService({
      cache,
      now: () => now,
      listTargets: () => [{ slug: "o/r", paths: ["/r"] }],
      fetch: async () => {
        fingerprintCalls++;
        return { fingerprints: new Map([["o/r", { ...current }]]), rateLimit: null };
      },
      rateLimit: () => ({ blocked, remaining, resetAt: now + 3_600_000, pausedUntil: null }),
      onObserved: (o) => {
        observations.push(o);
      },
    });
    setIssuesFreshness((slug) => svc.issuesKey(slug));
    const forge = new GithubForge("o/r", {}, run, undefined, undefined, cache);
    return { cache, svc, forge };
  };
  return {
    boot,
    store,
    calls,
    observations,
    fingerprintCalls: () => fingerprintCalls,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    block: (b: boolean) => {
      blocked = b;
    },
    remaining: (n: number) => {
      remaining = n;
    },
    change: () => {
      current = { ...current, issuesUpdatedAt: "2026-10-06T11:00:00Z" };
    },
    changeCounts: () => {
      current = { ...current, ciState: "FAILURE" };
    },
    changePrs: () => {
      current = { ...current, prsUpdatedAt: "2026-10-06T12:00:00Z" };
    },
  };
}

describe("GitHub warm restart", () => {
  afterEach(() => {
    setIssuesFreshness(null);
    graphRateLimit.note({ remaining: 4_000, resetAt: Date.now() + 60_000 });
  });

  async function readIssues(forge: GithubForge) {
    return {
      issues: await forge.listIssues(),
      summaries: await forge.listSubIssueSummaries(),
      blockers: await forge.listBlockedByOpen(),
      epic: await forge.getEpicStructure(10),
      viewer: await forge.currentUser(),
      links: await forge.listOpenPrLinkedIssues(),
    };
  }

  test("restart serves all issue read caches for five minutes with only unchanged fingerprints", async () => {
    const h = harness();
    const cold = h.boot();
    await cold.svc.tick();
    const expected = await readIssues(cold.forge);
    h.calls.length = 0;
    h.advance(600_000);
    const warm = h.boot();
    expect(warm.svc.covered("o/r")).toBe(true);
    expect(await readIssues(warm.forge)).toEqual(expected);
    for (let i = 0; i < 5; i++) {
      await warm.svc.tick();
      expect(await readIssues(warm.forge)).toEqual(expected);
      h.advance(60_000);
    }
    expect(h.observations.at(-1)?.changed).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("restart during backoff keeps coverage through reset without a second listing wave", async () => {
    const h = harness();
    const cold = h.boot();
    await cold.svc.tick();
    const expected = await readIssues(cold.forge);
    h.calls.length = 0;
    h.block(true);
    h.advance(3_600_000);
    const warm = h.boot();
    for (let i = 0; i < 3; i++) {
      await warm.svc.tick();
      h.advance(120_000);
      expect(await readIssues(warm.forge)).toEqual(expected);
      expect(warm.svc.covered("o/r")).toBe(true);
    }
    expect(h.fingerprintCalls()).toBe(1);
    h.block(false);
    expect(warm.svc.covered("o/r")).toBe(true);
    await warm.svc.tick();
    expect(h.observations.at(-1)?.changed).toEqual([]);
    expect(await readIssues(warm.forge)).toEqual(expected);
    expect(h.calls).toEqual([]);
  });

  test("normal TTL fallback resumes if fingerprint coverage lapses after a successful run", async () => {
    const h = harness();
    const cold = h.boot();
    await cold.svc.tick();
    await cold.forge.listIssues();
    h.calls.length = 0;
    h.advance(3 * 120_000);
    expect(cold.svc.covered("o/r")).toBe(false);
    await cold.forge.listIssues();
    expect(h.calls.filter((a) => a[0] === "issue" && a[1] === "list")).toHaveLength(1);
  });

  test("a changed issue key while down refreshes issues, relations and epics after the first fingerprint", async () => {
    const h = harness();
    const cold = h.boot();
    await cold.svc.tick();
    await readIssues(cold.forge);
    h.calls.length = 0;
    h.change();
    const warm = h.boot();
    await warm.svc.tick();
    await readIssues(warm.forge);
    expect(h.observations.at(-1)?.changed[0]).toMatchObject({ first: false, issues: true });
    expect(h.calls.filter((a) => a[0] === "issue" && a[1] === "list")).toHaveLength(1);
    expect(h.calls.filter((a) => a[1] === "graphql")).toHaveLength(2);
  });

  test("own issue writes invalidate disk rows and another forge's cached reads", async () => {
    const h = harness();
    const cold = h.boot();
    await cold.svc.tick();
    await readIssues(cold.forge);
    const other = new GithubForge(
      "o/r",
      {},
      async (args) => {
        if (args[0] === "issue" && args[1] === "list") return "[]";
        return "";
      },
      undefined,
      undefined,
      cold.cache,
    );
    expect(await other.listIssues()).toHaveLength(1);
    await cold.forge.closeIssue(10);
    expect(await other.listIssues()).toEqual([]);
    h.calls.length = 0;
    expect(await h.boot().forge.listIssues()).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("old entries answer immediately while a single background refresh runs", async () => {
    const h = harness();
    const cold = h.boot();
    await cold.svc.tick();
    await cold.forge.listIssues();
    h.advance(86_400_000);
    const warm = h.boot();
    await warm.svc.tick();
    let resolve!: (out: string) => void;
    let reads = 0;
    const forge = new GithubForge(
      "o/r",
      {},
      async () => {
        reads++;
        return new Promise<string>((r) => {
          resolve = r;
        });
      },
      undefined,
      undefined,
      warm.cache,
    );
    expect(await forge.listIssues()).toHaveLength(1);
    expect(await forge.listIssues()).toHaveLength(1);
    expect(reads).toBe(1);
    resolve("[]");
    await new Promise((r) => setTimeout(r, 0));
    expect(await forge.listIssues()).toEqual([]);
  });

  test("shared invalidation prevents a late pre-write fetch from surviving restart", async () => {
    const h = harness();
    const cold = h.boot();
    await cold.svc.tick();
    let resolve!: (out: string) => void;
    const other = new GithubForge(
      "o/r",
      {},
      () =>
        new Promise((r) => {
          resolve = r;
        }),
      undefined,
      undefined,
      cold.cache,
    );
    const pending = other.listIssues();
    await cold.forge.closeIssue(10);
    resolve(JSON.stringify([ISSUE]));
    await pending;
    h.calls.length = 0;
    await h.boot().forge.listIssues();
    expect(h.calls.filter((a) => a[1] === "list")).toHaveLength(1);
  });

  test("SQLite rehydration restores Maps and Sets and drops incompatible or malformed rows", async () => {
    const store = new SessionStore(":memory:");
    const h = harness(store);
    const cold = h.boot();
    await cold.svc.tick();
    const expected = await readIssues(cold.forge);
    store.putGithubReadCache({
      slug: "bad",
      kind: "issues",
      entryKey: "",
      version: 999,
      contentKey: "2|old",
      fetchedAt: h.now(),
      dataJson: "[]",
    });
    store.putGithubReadCache({
      slug: "broken",
      kind: "issues",
      entryKey: "",
      version: 1,
      contentKey: "2|old",
      fetchedAt: h.now(),
      dataJson: "{",
    });
    h.calls.length = 0;
    const warm = h.boot();
    expect(await readIssues(warm.forge)).toEqual(expected);
    expect(warm.cache.get("issues", "bad")).toBeNull();
    expect(warm.cache.get("issues", "broken")).toBeNull();
    expect(store.listGithubReadCache().some((r) => ["bad", "broken"].includes(r.slug))).toBe(false);
    expect(h.calls).toEqual([]);
  });

  test("read data survives reopening shepherd.db with a new SQLite connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-warm-db-"));
    try {
      const path = join(dir, "shepherd.db");
      const h = harness(new SessionStore(path));
      const cold = h.boot();
      await cold.svc.tick();
      const expected = await readIssues(cold.forge);
      h.calls.length = 0;
      const cache = new GithubReadCache(new SessionStore(path), { now: h.now });
      const forge = new GithubForge(
        "o/r",
        {},
        async (args) => {
          h.calls.push(args);
          throw new Error("unexpected cold read");
        },
        undefined,
        undefined,
        cache,
      );
      expect(await readIssues(forge)).toEqual(expected);
      expect(h.calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an incomplete epic fallback is not persisted as a usable structure", async () => {
    const h = harness();
    const cold = h.boot();
    await cold.svc.tick();
    const forge = new GithubForge(
      "o/r",
      {},
      async () => {
        throw new Error("unavailable");
      },
      undefined,
      undefined,
      cold.cache,
    );
    expect((await forge.getEpicStructure(10)).parent).toBeNull();
    expect(h.boot().cache.get("epic", "o/r", "10")).toBeNull();
  });

  test("malformed structured cache rows are dropped rather than losing blockers or branches", () => {
    const store = new MemoryStore();
    for (const kind of ["epic", "prs", "relations"] as const)
      store.putGithubReadCache({
        slug: "o/r",
        kind,
        entryKey: "",
        version: 1,
        contentKey: "old",
        fetchedAt: 1,
        dataJson: "{}",
      });
    const cache = new GithubReadCache(store);
    expect(cache.get("epic", "o/r")).toBeNull();
    expect(cache.get("prs", "o/r")).toBeNull();
    expect(cache.get("relations", "o/r")).toBeNull();
    expect(store.rows).toEqual([]);
  });

  test.each([
    [
      "relations",
      { summaries: [], subIssueNumbers: [], childrenByParent: [[1, null]], blockedByOpen: [] },
    ],
    [
      "relations",
      {
        summaries: [["bad", { total: 1, completed: 0 }]],
        subIssueNumbers: [],
        childrenByParent: [],
        blockedByOpen: [],
      },
    ],
    ["issues", [null]],
    ["counts", { openIssues: "bad", openPRs: 0, ciStatus: null, prKinds: null }],
    [
      "prs",
      {
        prs: [],
        statuses: [["a", { state: "open", checks: [], deployConfigured: false }]],
        capped: false,
      },
    ],
    ["links", [[1, [{ prNumber: 4, author: null }]]]],
    ["epic", { parent: null, subIssues: [null], blockedBy: [[11, null]] }],
  ] as const)("malformed nested %s data is deleted on rehydration", (kind, value) => {
    const store = new MemoryStore();
    store.putGithubReadCache({
      slug: "o/r",
      kind,
      entryKey: "",
      version: 1,
      contentKey: "old",
      fetchedAt: 1,
      dataJson: JSON.stringify(value),
    });
    const cache = new GithubReadCache(store);
    expect(cache.get(kind, "o/r")).toBeNull();
    expect(store.rows).toEqual([]);
  });

  test("a partially failed first fingerprint keeps coverage of rehydrated repositories it did not observe", async () => {
    const h = harness();
    const cold = h.boot();
    await cold.svc.tick();
    cold.cache.put("fingerprint", "o/other", null, FP);
    h.advance(600_000);
    const warm = h.boot();
    await warm.svc.tick();
    expect(warm.svc.covered("o/other")).toBe(true);
    h.advance(600_000);
    expect(warm.svc.issuesKey("o/other")).toBe("2|2026-10-06T10:00:00Z");
  });

  test("broad boot work waits for a successful fingerprint and pauses below reserve", async () => {
    const h = harness();
    const cold = h.boot();
    expect(cold.svc.backgroundReady()).toBe(false);
    await cold.svc.tick();
    expect(cold.svc.backgroundReady()).toBe(true);
    h.remaining(900);
    expect(cold.svc.backgroundReady()).toBe(false);
    h.block(true);
    h.remaining(4000);
    expect(cold.svc.backgroundReady()).toBe(false);
    h.block(false);
    expect(cold.svc.backgroundReady()).toBe(true);
    const warm = h.boot();
    expect(warm.svc.backgroundReady()).toBe(false);
  });

  test("open PR snapshots and their branch Maps are reused across restart and invalidated on writes", async () => {
    const h = harness();
    const cold = h.boot();
    await cold.svc.tick();
    const forge = cold.forge;
    let reads = 0;
    forge.listOpenPrSnapshot = async () => {
      reads++;
      return {
        prs: [],
        statuses: new Map([
          ["topic", { state: "open", number: 4, checks: "none", deployConfigured: false }],
        ]),
        capped: false,
      };
    };
    const snapshots = new OpenPrSnapshotService(h.now, 6, cold.cache);
    await snapshots.get(forge);
    h.advance(600_000);
    const warm = h.boot();
    const rehydrated = new OpenPrSnapshotService(h.now, 6, warm.cache);
    expect((await rehydrated.get(forge))?.statuses.get("topic")?.number).toBe(4);
    expect(reads).toBe(1);
    rehydrated.invalidate(forge);
    expect(new OpenPrSnapshotService(h.now, 6, h.boot().cache).peek(forge)).toBeNull();
  });

  test("own PR writes remove persisted snapshots and counts", async () => {
    const h = harness();
    const cold = h.boot();
    await cold.svc.tick();
    cold.cache.put("prs", "o/r", "1|2026-10-06T09:00:00Z", {
      prs: [],
      statuses: new Map(),
      capped: false,
    });
    cold.cache.put("counts", "o/r", "2|1|2026-10-06T09:00:00Z|SUCCESS", {
      openIssues: 2,
      openPRs: 1,
      ciStatus: "success",
      prKinds: null,
    });
    await cold.forge.closePr(4);
    const warm = h.boot();
    expect(warm.cache.get("prs", "o/r")).toBeNull();
    expect(warm.cache.get("counts", "o/r")).toBeNull();
  });

  test.each(["rerun", "cancel", "createStack", "addToStack", "unstack"] as const)(
    "own %s writes invalidate PR data across restart",
    async (write) => {
      const h = harness();
      const cold = h.boot();
      await cold.svc.tick();
      cold.cache.put("prs", "o/r", "1|2026-10-06T09:00:00Z", {
        prs: [],
        statuses: new Map(),
        capped: false,
      });
      const forge = new GithubForge(
        "o/r",
        {},
        async () => JSON.stringify({ number: 1, baseRef: "main", prNumbers: [4] }),
        undefined,
        undefined,
        cold.cache,
      );
      if (write === "rerun") await forge.rerunWorkflowRun(4, { failedOnly: false });
      else if (write === "cancel") await forge.cancelWorkflowRun(4);
      else if (write === "createStack") await forge.createStack([4]);
      else if (write === "addToStack") await forge.addToStack(1, 4);
      else await forge.unstack(1);
      expect(h.boot().cache.get("prs", "o/r")).toBeNull();
    },
  );

  test("a moved PR fingerprint bypasses even a snapshot younger than its TTL", async () => {
    const h = harness();
    const cold = h.boot();
    await cold.svc.tick();
    let reads = 0;
    cold.forge.listOpenPrSnapshot = async () => ({
      prs: [],
      statuses: new Map(),
      capped: ++reads > 1,
    });
    const svc = new OpenPrSnapshotService(h.now, 6, cold.cache);
    expect((await svc.get(cold.forge))?.capped).toBe(false);
    h.advance(1_000);
    h.changePrs();
    const warm = h.boot();
    await warm.svc.tick();
    expect((await new OpenPrSnapshotService(h.now, 6, warm.cache).get(cold.forge))?.capped).toBe(
      true,
    );
    expect(reads).toBe(2);
  });

  test("backlog counts rehydrate before the first fingerprint and refresh only on a changed counts key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-warm-counts-"));
    try {
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/r.git"]);
      const h = harness();
      let reads = 0;
      const run: GhRunner = async (args) => {
        expect(args.join(" ")).toContain("pullRequests(states:OPEN, first:100)");
        reads++;
        return JSON.stringify({
          data: {
            repository: {
              issues: { totalCount: 2 },
              pullRequests: { totalCount: reads, nodes: [] },
              defaultBranchRef: { target: { statusCheckRollup: { state: "SUCCESS" } } },
            },
          },
        });
      };
      const cold = h.boot();
      await cold.svc.tick();
      const counts = new CountsService({}, run, fetch, undefined, undefined, undefined, cold.cache);
      expect((await counts.counts(dir)).openPRs).toBe(1);
      h.advance(30 * 60_000);
      const warm = h.boot();
      const rehydrated = new CountsService(
        {},
        run,
        fetch,
        undefined,
        undefined,
        undefined,
        warm.cache,
      );
      expect(rehydrated.peek(dir)?.openPRs).toBe(1);
      expect((await rehydrated.counts(dir)).openPRs).toBe(1);
      await warm.svc.tick();
      for (let i = 0; i < 5; i++) {
        h.advance(60_000);
        expect((await rehydrated.counts(dir)).openPRs).toBe(1);
      }
      expect(reads).toBe(1);
      h.changeCounts();
      await warm.svc.tick();
      expect((await rehydrated.counts(dir)).openPRs).toBe(2);
      expect(reads).toBe(2);
      await warm.forge.closeIssue(10);
      expect(rehydrated.peek(dir)).toBeNull();
      expect((await rehydrated.counts(dir)).openPRs).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
