import { expect, test } from "bun:test";
import { GithubForge } from "../../src/forge/github";
import { GithubReadCache } from "../../src/github-read-cache";
import costFixture from "../fixtures/github-open-pr-snapshot-cost.json";

function readCache() {
  return new GithubReadCache({
    listGithubReadCache: () => [],
    putGithubReadCache: () => undefined,
    deleteGithubReadCache: () => undefined,
  });
}

function fingerprint(cache: GithubReadCache, openPrs: number, openIssues = 0) {
  cache.put("fingerprint", "o/r", null, {
    openPrs,
    openIssues,
    prsUpdatedAt: "2026-10-06T10:00:00Z",
    issuesUpdatedAt: "2026-10-06T10:00:00Z",
    ciState: "SUCCESS",
  });
}

/** Emulates gh's result limit at the process boundary, including auxiliary reads. */
function listing(cache: GithubReadCache, total: number, failAt?: number) {
  const limits: number[] = [];
  const fields: string[] = [];
  const nodes = Array.from({ length: total }, (_, i) => ({
    number: i + 1,
    title: `Item ${i + 1}`,
    url: `https://github.com/o/r/pull/${i + 1}`,
    state: "OPEN",
    headRefName: `branch-${i + 1}`,
    createdAt: "2026-10-06T10:00:00Z",
    labels: [],
  }));
  const run = async (args: string[]) => {
    if ((args[0] === "pr" || args[0] === "issue") && args[1] === "list") {
      const limit = Number(args[args.indexOf("--limit") + 1]);
      limits.push(limit);
      fields.push(args[args.indexOf("--json") + 1]!);
      if (limit === failAt) throw new Error("listing failed");
      return JSON.stringify(nodes.slice(0, limit));
    }
    if (args[0] === "repo" && args[1] === "view")
      return JSON.stringify({ defaultBranchRef: { name: "main" } });
    if (args[0] === "run" && args[1] === "list") return "[]";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { forge: new GithubForge("o/r", {}, run, undefined, undefined, cache), limits, fields };
}

test("#2845: small snapshot matches the one-point GitHub dry-run fixture", async () => {
  const cache = readCache();
  fingerprint(cache, 11);
  const { forge, limits, fields } = listing(cache, 11);
  await forge.listOpenPrSnapshot();
  expect(fields).toEqual([costFixture.fields]);
  const costs: Record<string, number> = costFixture.costByLimit;
  expect(limits[0]).toBeLessThanOrEqual(20);
  expect(costs[String(limits[0])]).toBe(1);
});

for (const [count, limit] of [
  [0, 20],
  [2, 20],
  [11, 20],
  [15, 20],
  [16, 30],
  [25, 30],
  [26, 50],
  [46, 100],
  [96, 200],
] as const) {
  test(`#2845: snapshot with ${count} known open PRs uses limit ${limit}`, async () => {
    const cache = readCache();
    fingerprint(cache, count);
    const { forge, limits } = listing(cache, count);
    const snapshot = await forge.listOpenPrSnapshot();
    expect(limits).toEqual([limit]);
    expect(snapshot.prs).toHaveLength(count);
    expect(snapshot.statuses.size).toBe(count);
    expect(snapshot.capped).toBe(false);
  });
}

test("#2845: snapshot uses backlog count when no fingerprint exists", async () => {
  const cache = readCache();
  cache.put("counts", "o/r", null, {
    openPRs: 11,
    openIssues: 2,
    ciStatus: null,
    prKinds: null,
  });
  const { forge, limits } = listing(cache, 11);
  expect((await forge.listOpenPrSnapshot()).prs).toHaveLength(11);
  expect(limits).toEqual([20]);
});

test("#2845: unknown counts preserve the existing 200-item window", async () => {
  const cache = readCache();
  cache.put("counts", "o/r", null, {
    openPRs: null,
    openIssues: null,
    ciStatus: null,
    prKinds: null,
  });
  const { forge, limits } = listing(cache, 25);
  expect((await forge.listOpenPrSnapshot()).prs).toHaveLength(25);
  expect(limits).toEqual([200]);
});

test("#2845: count growing from 10 to 25 returns every PR and status", async () => {
  const cache = readCache();
  fingerprint(cache, 10);
  const { forge, limits } = listing(cache, 25);
  const snapshot = await forge.listOpenPrSnapshot();
  expect(limits).toEqual([20, 30]);
  expect(snapshot.prs.map((p) => p.number)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  expect(snapshot.statuses.size).toBe(25);
  expect(snapshot.statuses.get("branch-25")?.number).toBe(25);
  expect(snapshot.capped).toBe(false);
});

test("#2845: growth beyond the first retry still returns the complete open set", async () => {
  const cache = readCache();
  fingerprint(cache, 10);
  const { forge, limits } = listing(cache, 75);
  const snapshot = await forge.listOpenPrSnapshot();
  expect(limits).toEqual([20, 30, 50, 100]);
  expect(snapshot.prs).toHaveLength(75);
  expect(snapshot.statuses.get("branch-75")?.number).toBe(75);
  expect(snapshot.capped).toBe(false);
});

test("#2845: exactly full results are checked with the next limit", async () => {
  const cache = readCache();
  fingerprint(cache, 10);
  const { forge, limits } = listing(cache, 20);
  expect((await forge.listOpenPrSnapshot()).prs).toHaveLength(20);
  expect(limits).toEqual([20, 30]);
});

test("#2845: a failed retry never returns a partial snapshot", async () => {
  const cache = readCache();
  fingerprint(cache, 10);
  const { forge, limits } = listing(cache, 25, 30);
  await expect(forge.listOpenPrSnapshot()).rejects.toThrow("listing failed");
  expect(limits).toEqual([20, 30]);
});

test("#2845: growth to the existing cap stays bounded and signals truncation", async () => {
  const cache = readCache();
  fingerprint(cache, 10);
  const { forge, limits } = listing(cache, 250);
  const snapshot = await forge.listOpenPrSnapshot();
  expect(limits).toEqual([20, 30, 50, 100, 200]);
  expect(snapshot.prs).toHaveLength(200);
  expect(snapshot.capped).toBe(true);
});

test("#2845: small issue lists use a 50-item page", async () => {
  const cache = readCache();
  fingerprint(cache, 0, 11);
  const { forge, limits } = listing(cache, 11);
  expect((await forge.listIssues()).map((i) => i.number)).toEqual(
    Array.from({ length: 11 }, (_, i) => i + 1),
  );
  expect(limits).toEqual([50]);
});

test("#2845: issue count growth refetches without losing the tail", async () => {
  const cache = readCache();
  fingerprint(cache, 0, 10);
  const { forge, limits } = listing(cache, 120);
  const issues = await forge.listIssues();
  expect(limits).toEqual([50, 100, 200]);
  expect(issues).toHaveLength(120);
  expect(issues.at(-1)?.number).toBe(120);
});

test("#2845: issue lists also use the backlog count without a fingerprint", async () => {
  const cache = readCache();
  cache.put("counts", "o/r", null, {
    openPRs: null,
    openIssues: 11,
    ciStatus: null,
    prKinds: null,
  });
  const { forge, limits } = listing(cache, 11);
  expect(await forge.listIssues()).toHaveLength(11);
  expect(limits).toEqual([50]);
});
