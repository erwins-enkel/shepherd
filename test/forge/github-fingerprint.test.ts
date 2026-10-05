import { test, expect } from "bun:test";
import {
  buildFingerprintArgs,
  fetchRepoFingerprints,
  FINGERPRINT_CHUNK,
  parseFingerprintResponse,
} from "../../src/forge/github-fingerprint";
import { BucketRateLimit } from "../../src/forge/rate-limit";

const RATE = { cost: 1, remaining: 4321, used: 679, resetAt: "2026-10-05T10:00:00Z" };

function repoNode(o: {
  openIssues?: number;
  issueAt?: string | null;
  openPrs?: number;
  prAt?: string | null;
  ci?: string | null;
}) {
  return {
    openIssues: { totalCount: o.openIssues ?? 3 },
    lastIssue: {
      nodes: o.issueAt === null ? [] : [{ updatedAt: o.issueAt ?? "2026-10-01T00:00:00Z" }],
    },
    openPrs: { totalCount: o.openPrs ?? 2 },
    lastPr: { nodes: o.prAt === null ? [] : [{ updatedAt: o.prAt ?? "2026-10-02T00:00:00Z" }] },
    defaultBranchRef:
      o.ci === null ? null : { target: { statusCheckRollup: { state: o.ci ?? "SUCCESS" } } },
  };
}

test("buildFingerprintArgs: one aliased query with string variables per repo plus rateLimit", () => {
  const args = buildFingerprintArgs(["acme/web", "acme/api"]);
  expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
  expect(args).toContain("o0=acme");
  expect(args).toContain("n0=web");
  expect(args).toContain("o1=acme");
  expect(args).toContain("n1=api");
  // -f (raw string), never -F: a numeric repo name must stay a String! variable.
  expect(args.filter((a) => a === "-F")).toEqual([]);
  const query = args.find((a) => a.startsWith("query="))!;
  expect(query).toContain("$o0:String!");
  expect(query).toContain("r0:repository(owner:$o0,name:$n0)");
  expect(query).toContain("r1:repository(owner:$o1,name:$n1)");
  expect(query).toContain("orderBy:{field:UPDATED_AT,direction:DESC}");
  expect(query).toContain("rateLimit{cost remaining used resetAt}");
});

test("parseFingerprintResponse: maps aliases back to slugs, null for an unreadable repo", () => {
  const out = JSON.stringify({
    data: { r0: repoNode({ openIssues: 7, ci: "FAILURE" }), r1: null, rateLimit: RATE },
  });
  const { fingerprints, rateLimit } = parseFingerprintResponse(out, ["acme/web", "acme/gone"]);
  expect(fingerprints.get("acme/web")).toEqual({
    openIssues: 7,
    issuesUpdatedAt: "2026-10-01T00:00:00Z",
    openPrs: 2,
    prsUpdatedAt: "2026-10-02T00:00:00Z",
    ciState: "FAILURE",
  });
  expect(fingerprints.get("acme/gone")).toBeNull();
  expect(rateLimit).toEqual({
    cost: 1,
    remaining: 4321,
    used: 679,
    resetAt: Date.parse(RATE.resetAt),
  });
});

test("parseFingerprintResponse: an empty repo (no issues, no PRs, no rollup) still fingerprints", () => {
  const out = JSON.stringify({
    data: { r0: repoNode({ openIssues: 0, issueAt: null, openPrs: 0, prAt: null, ci: null }) },
  });
  const { fingerprints, rateLimit } = parseFingerprintResponse(out, ["acme/empty"]);
  expect(fingerprints.get("acme/empty")).toEqual({
    openIssues: 0,
    issuesUpdatedAt: "",
    openPrs: 0,
    prsUpdatedAt: "",
    ciState: "",
  });
  expect(rateLimit).toBeNull();
});

test("fetchRepoFingerprints: N ≤ chunk size is one gh call; the reading reaches the tracker", async () => {
  const calls: string[][] = [];
  const rl = new BucketRateLimit();
  const run = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ data: { r0: repoNode({}), r1: repoNode({}), rateLimit: RATE } });
  };
  const { fingerprints, rateLimit } = await fetchRepoFingerprints(run, ["a/b", "c/d"], rl);
  expect(calls).toHaveLength(1);
  expect([...fingerprints.keys()]).toEqual(["a/b", "c/d"]);
  expect(rateLimit?.remaining).toBe(4321);
  expect(rl.snapshot().remaining).toBe(4321);
});

test("fetchRepoFingerprints: chunks above FINGERPRINT_CHUNK and sums the cost", async () => {
  const slugs = Array.from({ length: FINGERPRINT_CHUNK + 1 }, (_, i) => `o/r${i}`);
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const n = args.filter((a) => /^o\d+=/.test(a)).length;
    const data: Record<string, unknown> = {
      rateLimit: { ...RATE, remaining: 4000 - calls.length },
    };
    for (let i = 0; i < n; i++) data[`r${i}`] = repoNode({});
    return JSON.stringify({ data });
  };
  const { fingerprints, rateLimit } = await fetchRepoFingerprints(
    run,
    slugs,
    new BucketRateLimit(),
  );
  expect(calls).toHaveLength(2);
  expect(fingerprints.size).toBe(FINGERPRINT_CHUNK + 1);
  expect(fingerprints.get(`o/r${FINGERPRINT_CHUNK}`)).not.toBeNull();
  expect(rateLimit?.cost).toBe(2);
  expect(rateLimit?.remaining).toBe(3998); // the latest reading
});

test("fetchRepoFingerprints: a gh exit carrying partial data (one NOT_FOUND alias) is parsed", async () => {
  const run = async () => {
    const stdout = JSON.stringify({
      data: { r0: repoNode({}), r1: null, rateLimit: RATE },
      errors: [{ type: "NOT_FOUND", path: ["r1"], message: "Could not resolve" }],
    });
    throw Object.assign(new Error("exit 1"), { stdout, stderr: "gh: Could not resolve" });
  };
  const { fingerprints } = await fetchRepoFingerprints(
    run,
    ["a/b", "a/gone"],
    new BucketRateLimit(),
  );
  expect(fingerprints.get("a/b")).not.toBeNull();
  expect(fingerprints.get("a/gone")).toBeNull();
});

test("fetchRepoFingerprints: a failed chunk omits its slugs; every chunk failing rethrows", async () => {
  const slugs = Array.from({ length: FINGERPRINT_CHUNK + 1 }, (_, i) => `o/r${i}`);
  let n = 0;
  const run = async (args: string[]) => {
    n++;
    if (n === 2) throw Object.assign(new Error("boom"), { stderr: "boom" });
    const data: Record<string, unknown> = {};
    const count = args.filter((a) => /^o\d+=/.test(a)).length;
    for (let i = 0; i < count; i++) data[`r${i}`] = repoNode({});
    return JSON.stringify({ data });
  };
  const { fingerprints } = await fetchRepoFingerprints(run, slugs, new BucketRateLimit());
  expect(fingerprints.size).toBe(FINGERPRINT_CHUNK);
  expect(fingerprints.has(`o/r${FINGERPRINT_CHUNK}`)).toBe(false);

  const failing = async () => {
    throw Object.assign(new Error("rate limit"), { stderr: "API rate limit exceeded" });
  };
  await expect(fetchRepoFingerprints(failing, ["a/b"], new BucketRateLimit())).rejects.toThrow(
    "rate limit",
  );
});

test("fetchRepoFingerprints: no slugs → no gh call", async () => {
  let called = false;
  const run = async () => {
    called = true;
    return "{}";
  };
  const { fingerprints } = await fetchRepoFingerprints(run, [], new BucketRateLimit());
  expect(called).toBe(false);
  expect(fingerprints.size).toBe(0);
});
