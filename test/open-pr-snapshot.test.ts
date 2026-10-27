/**
 * Unit tests for OpenPrSnapshotService (src/open-pr-snapshot.ts).
 *
 * Uses a fake GitForge-shaped object with a controllable clock seam.
 */
import { test, expect } from "bun:test";
import { OpenPrSnapshotService, SETTLE_DELAYS_MS, SNAPSHOT_TTL_MS } from "../src/open-pr-snapshot";
import { graphRateLimit } from "../src/forge/rate-limit";
import { withGhCaller } from "../src/forge/gh-caller";
import { GithubReadCache } from "../src/github-read-cache";
import { SessionStore } from "../src/store";
import type { GitForge, OpenPrSnapshot, PrStatus } from "../src/forge/types";

// ── helpers ────────────────────────────────────────────────────────────────

function blockGraphql(): void {
  graphRateLimit.noteLimitError(60);
}

function unblockGraphql(): void {
  graphRateLimit.noteSuccess();
}

function makeSnapshot(id = 1, source?: OpenPrSnapshot["source"]): OpenPrSnapshot {
  const status: PrStatus = {
    state: "open",
    number: id,
    checks: "none",
    deployConfigured: false,
  };
  return {
    prs: [
      {
        number: id,
        title: `PR ${id}`,
        url: `https://github.com/org/repo/pull/${id}`,
        author: "alice",
        kind: "regular",
        createdAt: 1000,
        isDraft: false,
        mergeable: true,
        checks: "none",
        jobs: [],
      },
    ],
    statuses: new Map([["branch-a", status]]),
    capped: false,
    source,
  };
}

/** Forge factory — slug defaults to "org/repo". */
function makeForge(
  slug: string | null = "org/repo",
  opts: { noSnapshot?: boolean; failSnapshot?: boolean } = {},
): GitForge & { calls: number } {
  const calls = 0;
  const forge = {
    slug,
    kind: "github" as const,
    mergeMethod: "squash" as const,
    deployWorkflow: null,
    calls,
    // Required GitForge methods (stubs — not exercised by these tests)
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => ({
      openIssues: null,
      openPRs: null,
      ciStatus: null,
      prKinds: null,
    }),
    prStatus: async () => ({
      state: "none" as const,
      checks: "none" as const,
      deployConfigured: false,
    }),
    openPr: async () => ({
      state: "none" as const,
      checks: "none" as const,
      deployConfigured: false,
    }),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
  } as unknown as GitForge & { calls: number };

  if (!opts.noSnapshot) {
    let snapshotCalls = 0;
    (forge as unknown as Record<string, unknown>).listOpenPrSnapshot = async () => {
      snapshotCalls++;
      if (opts.failSnapshot) throw new Error("network error");
      return makeSnapshot(snapshotCalls);
    };
    // Expose call count via a getter so it stays in sync with the closure variable.
    Object.defineProperty(forge, "calls", {
      configurable: true,
      get() {
        return snapshotCalls;
      },
    });
  }

  return forge;
}

// ── tests ──────────────────────────────────────────────────────────────────

test("read-through: first get calls forge once and caches result", async () => {
  const now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();

  const snap = await svc.get(forge);
  expect(snap).not.toBeNull();
  expect(snap!.prs[0]!.number).toBe(1);
  expect(forge.calls).toBe(1);
});

test("read-through: second get within TTL returns cached, no new forge call", async () => {
  let now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();

  await svc.get(forge);
  now = SNAPSHOT_TTL_MS - 1; // still fresh
  await svc.get(forge);
  expect(forge.calls).toBe(1);
});

test("read-through: GraphQL backoff bypasses a fresh GraphQL snapshot", async () => {
  let now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();
  let source: OpenPrSnapshot["source"] = "graphql";
  (forge as unknown as Record<string, unknown>).listOpenPrSnapshot = async () => {
    (forge as unknown as { calls: number }).calls++;
    return makeSnapshot((forge as unknown as { calls: number }).calls, source);
  };
  Object.defineProperty(forge, "calls", { value: 0, writable: true, configurable: true });

  await svc.get(forge);
  now = SNAPSHOT_TTL_MS - 1;
  source = "rest";
  blockGraphql();
  try {
    const snap = await svc.get(forge);
    expect(snap!.source).toBe("rest");
    expect(snap!.prs[0]!.number).toBe(2);
    expect(forge.calls).toBe(2);
  } finally {
    unblockGraphql();
  }
});

test("read-through: a background get serves a stale GraphQL snapshot during backoff (#2660)", async () => {
  let now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();

  await svc.get(forge);
  now = SNAPSHOT_TTL_MS * 10; // long expired
  blockGraphql();
  try {
    const snap = await svc.get(forge, { background: true });
    expect(snap!.prs[0]!.number).toBe(1);
    expect(forge.calls).toBe(1);
    await svc.get(forge); // operator read still refetches
    expect(forge.calls).toBe(2);
  } finally {
    unblockGraphql();
  }
});

test("read-through: a background get with no snapshot yet still fetches", async () => {
  const svc = new OpenPrSnapshotService(() => 0);
  const forge = makeForge();
  blockGraphql();
  try {
    expect(await svc.get(forge, { background: true })).not.toBeNull();
    expect(forge.calls).toBe(1);
  } finally {
    unblockGraphql();
  }
});

test("read-through: GraphQL backoff reuses a fresh REST snapshot", async () => {
  let now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();
  (forge as unknown as Record<string, unknown>).listOpenPrSnapshot = async () => {
    (forge as unknown as { calls: number }).calls++;
    return makeSnapshot((forge as unknown as { calls: number }).calls, "rest");
  };
  Object.defineProperty(forge, "calls", { value: 0, writable: true, configurable: true });

  await svc.get(forge);
  now = SNAPSHOT_TTL_MS - 1;
  blockGraphql();
  try {
    const snap = await svc.get(forge);
    expect(snap!.source).toBe("rest");
    expect(snap!.prs[0]!.number).toBe(1);
    expect(forge.calls).toBe(1);
  } finally {
    unblockGraphql();
  }
});

test("read-through: get after TTL expiry refetches", async () => {
  let now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();

  await svc.get(forge);
  now = SNAPSHOT_TTL_MS; // exactly expired
  const snap2 = await svc.get(forge);
  expect(forge.calls).toBe(2);
  // Second fetch returns snapshot with id=2
  expect(snap2!.prs[0]!.number).toBe(2);
});

test("single-flight: concurrent gets share one in-flight fetch", async () => {
  const now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();

  const [a, b] = await Promise.all([svc.get(forge), svc.get(forge)]);
  expect(forge.calls).toBe(1);
  expect(a).toEqual(b);
});

test("refresh: forces a fetch even when a fresh entry exists", async () => {
  const now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();

  await svc.get(forge);
  const snap2 = await svc.refresh(forge);
  expect(forge.calls).toBe(2);
  expect(snap2!.prs[0]!.number).toBe(2);
});

test("refresh: updates the cache so next get returns the refreshed value", async () => {
  const now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();

  await svc.get(forge);
  await svc.refresh(forge);
  const snap3 = await svc.get(forge); // should be served from cache (no extra call)
  expect(forge.calls).toBe(2);
  expect(snap3!.prs[0]!.number).toBe(2);
});

test("preserve-on-error: failing refresh keeps last-known-good when a value exists", async () => {
  const now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge("org/repo", { failSnapshot: false });

  const first = await svc.get(forge);
  expect(first!.prs[0]!.number).toBe(1);

  // Now make the forge fail
  (forge as unknown as Record<string, unknown>).listOpenPrSnapshot = async () => {
    throw new Error("transient failure");
  };

  const kept = await svc.refresh(forge);
  expect(kept!.prs[0]!.number).toBe(1); // last-known-good preserved
});

test("preserve-on-error: failing get with no prior value resolves to null", async () => {
  const now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge("org/repo", { failSnapshot: true });

  const result = await svc.get(forge);
  expect(result).toBeNull();
});

test("preserve-on-error: failing refresh with no prior value resolves to null", async () => {
  const now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge("org/repo", { failSnapshot: true });

  const result = await svc.refresh(forge);
  expect(result).toBeNull();
});

test("peek: returns cached value without fetching", async () => {
  const now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();

  expect(svc.peek(forge)).toBeNull(); // nothing cached yet

  await svc.get(forge);
  const peeked = svc.peek(forge);
  expect(peeked).not.toBeNull();
  expect(peeked!.prs[0]!.number).toBe(1);
  expect(forge.calls).toBe(1); // peek triggered no extra fetch
});

test("peek with maxAgeMs: an entry older than the bound reads as null, never fetching", async () => {
  let now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();
  await svc.get(forge);
  now = 60_000;
  expect(svc.peek(forge, 60_000)).not.toBeNull();
  now = 60_001;
  expect(svc.peek(forge, 60_000)).toBeNull();
  expect(svc.peek(forge)).not.toBeNull(); // unbounded peek still serves it
  expect(forge.calls).toBe(1);
});

test("peek: returns null before anything is cached", async () => {
  const svc = new OpenPrSnapshotService();
  const forge = makeForge();

  expect(svc.peek(forge)).toBeNull();
});

test("null condition: forge.slug is null → returns null without fetching", async () => {
  const svc = new OpenPrSnapshotService();
  const forge = makeForge(null);

  expect(await svc.get(forge)).toBeNull();
  expect(await svc.refresh(forge)).toBeNull();
  expect(svc.peek(forge)).toBeNull();
  // No calls should have been made (forge has no listOpenPrSnapshot in null-slug path,
  // but we verify the service short-circuits before touching the forge at all)
  expect(forge.calls).toBe(0);
});

test("null condition: forge.listOpenPrSnapshot undefined → returns null without fetching", async () => {
  const svc = new OpenPrSnapshotService();
  const forge = makeForge("org/repo", { noSnapshot: true });

  expect(await svc.get(forge)).toBeNull();
  expect(await svc.refresh(forge)).toBeNull();
  expect(svc.peek(forge)).toBeNull();
});

test("keying: two forges with the same slug share a cache entry", async () => {
  const now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge1 = makeForge("org/repo");
  const forge2 = makeForge("org/repo");

  await svc.get(forge1); // warm via forge1
  const snap2 = await svc.get(forge2); // should hit cache — forge2 NOT called
  expect(forge1.calls).toBe(1);
  expect(forge2.calls).toBe(0);
  expect(snap2!.prs[0]!.number).toBe(1);
});

test("keying: different slugs are isolated", async () => {
  const now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forgeA = makeForge("org/repo-a");
  const forgeB = makeForge("org/repo-b");

  await svc.get(forgeA);
  await svc.get(forgeB);
  expect(forgeA.calls).toBe(1);
  expect(forgeB.calls).toBe(1);
});

test("interleaving: joining refresh gets stale-on-error; get gets null; single-flight preserved", async () => {
  // Regression: when get() starts an in-flight fetch (preserveOnError=false) and
  // refresh() joins the same in-flight (preserveOnError=true), each caller must
  // apply its OWN error policy — refresh must return last-known-good on failure.

  let now = 0;
  const svc = new OpenPrSnapshotService(() => now);

  // Seed the cache with a known stale snapshot.
  const staleSnap = makeSnapshot(42);
  let callCount = 0;
  const forge = makeForge();
  (forge as unknown as Record<string, unknown>).listOpenPrSnapshot = async () => {
    callCount++;
    return staleSnap;
  };
  await svc.get(forge); // warms cache at t=0
  expect(callCount).toBe(1);

  // Advance past TTL so the cache entry is stale; get() will miss and fetch.
  now = SNAPSHOT_TTL_MS;
  callCount = 0; // reset for the concurrent phase

  // Replace listOpenPrSnapshot with a controllable-rejecting version.
  let pendingReject!: (e: Error) => void;
  (forge as unknown as Record<string, unknown>).listOpenPrSnapshot = () => {
    callCount++;
    return new Promise<OpenPrSnapshot>((_, reject) => {
      pendingReject = reject;
    });
  };

  // Fire both callers — neither awaited yet, so they share one in-flight fetch.
  const getPromise = svc.get(forge); // preserveOnError=false
  const refreshPromise = svc.refresh(forge); // preserveOnError=true

  // Reject the shared in-flight (simulates a network failure).
  pendingReject(new Error("network failure"));

  const [getResult, refreshResult] = await Promise.all([getPromise, refreshPromise]);

  expect(getResult).toBeNull(); // get has no preserve-on-error
  expect(refreshResult).toEqual(staleSnap); // refresh keeps last-known-good
  expect(callCount).toBe(1); // single-flight: only one forge call
});

test("invalidate: evicts the cached entry so the next get refetches within TTL", async () => {
  const now = 0; // clock never advances — entry would stay fresh without invalidation
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();

  await svc.get(forge); // warm cache (id=1)
  expect(forge.calls).toBe(1);

  svc.invalidate(forge);
  expect(svc.peek(forge)).toBeNull(); // entry gone, even though still within TTL

  const snap = await svc.get(forge); // miss → refetch (id=2)
  expect(forge.calls).toBe(2);
  expect(snap!.prs[0]!.number).toBe(2);
});

test("invalidate: clears inflight — a later get starts a fresh fetch and a late pre-invalidate fetch can't poison the cache", async () => {
  const now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();

  // Controllable, ordered resolutions so we can interleave invalidate between fetches.
  const resolvers: Array<(v: OpenPrSnapshot) => void> = [];
  let callCount = 0;
  (forge as unknown as Record<string, unknown>).listOpenPrSnapshot = () => {
    callCount++;
    return new Promise<OpenPrSnapshot>((res) => resolvers.push(res));
  };

  const a = svc.get(forge); // fetch A in flight (call #1)
  svc.invalidate(forge); // drop cache + inflight pointer
  const b = svc.get(forge); // must NOT join A — starts fetch B (call #2)
  expect(callCount).toBe(2);

  // Resolve A (the abandoned pre-invalidate fetch) FIRST, then B.
  resolvers[0]!(makeSnapshot(1)); // A's stale value
  resolvers[1]!(makeSnapshot(2)); // B's fresh value
  const [av, bv] = await Promise.all([a, b]);

  // Each caller still receives the value it fetched…
  expect(av!.prs[0]!.number).toBe(1);
  expect(bv!.prs[0]!.number).toBe(2);
  // …but only B (the current inflight) repopulated the cache; A's late resolution was dropped.
  expect(svc.peek(forge)!.prs[0]!.number).toBe(2);
});

test("invalidate: no-op for incapable forges (null slug / no listOpenPrSnapshot)", async () => {
  const svc = new OpenPrSnapshotService();
  const nullSlug = makeForge(null);
  const noMethod = makeForge("org/repo", { noSnapshot: true });

  // Should neither throw nor touch the forge.
  expect(() => svc.invalidate(nullSlug)).not.toThrow();
  expect(() => svc.invalidate(noMethod)).not.toThrow();
  expect(nullSlug.calls).toBe(0);
  expect(noMethod.calls).toBe(0);
});

test("peekCurrent: the cached snapshot with its fetch time, never fetching", async () => {
  let now = 1_000;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();

  expect(svc.peekCurrent(forge)).toBeNull(); // nothing cached yet
  const snap = await svc.get(forge);
  now = 5_000;
  expect(svc.peekCurrent(forge)).toEqual({ at: 1_000, value: snap! });
  expect(forge.calls).toBe(1);
});

test("peekCurrent: without a fingerprint, an entry past SNAPSHOT_TTL_MS is not current", async () => {
  let now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();
  await svc.get(forge);
  now = SNAPSHOT_TTL_MS - 1;
  expect(svc.peekCurrent(forge)).not.toBeNull();
  now = SNAPSHOT_TTL_MS;
  expect(svc.peekCurrent(forge)).toBeNull();
  expect(svc.peek(forge)).not.toBeNull(); // peek still serves it
  expect(forge.calls).toBe(1);
});

test("peekCurrent: with a fingerprint, current until the PR key moves — whatever the age", async () => {
  let now = 0;
  const cache = new GithubReadCache(new SessionStore(":memory:"), { now: () => now });
  const fingerprint = (prsUpdatedAt: string) =>
    cache.put("fingerprint", "org/repo", null, {
      openIssues: 0,
      issuesUpdatedAt: "",
      openPrs: 1,
      prsUpdatedAt,
      ciState: "",
    });
  fingerprint("t1");
  const svc = new OpenPrSnapshotService(() => now, 6, cache);
  const forge = makeForge();
  await svc.get(forge);

  now = 60 * 60_000; // far past SNAPSHOT_TTL_MS
  expect(svc.peekCurrent(forge)?.at).toBe(0);
  fingerprint("t2");
  expect(svc.peekCurrent(forge)).toBeNull();
  expect(forge.calls).toBe(1);
});

test("peekCurrent: null for incapable forges", () => {
  const svc = new OpenPrSnapshotService();
  expect(svc.peekCurrent(makeForge(null))).toBeNull();
  expect(svc.peekCurrent(makeForge("org/repo", { noSnapshot: true }))).toBeNull();
});

// ── hasTransient (#2799) ───────────────────────────────────────────────────

function snapshotWith(status: Partial<PrStatus>): OpenPrSnapshot {
  const snap = makeSnapshot(1);
  const base: PrStatus = {
    state: "open",
    number: 1,
    headSha: "h1",
    checks: "success",
    deployConfigured: false,
    mergeable: true,
    mergeStateStatus: "clean",
  };
  return { ...snap, statuses: new Map([["branch-a", { ...base, ...status }]]) };
}

test("hasTransient: pending, running, unknown and unstable PRs count; settled ones don't", async () => {
  const cases: Array<[Partial<PrStatus>, boolean]> = [
    [{}, false],
    [{ checks: "pending" }, true],
    [{ runningChecks: ["ci"] }, true],
    [{ mergeable: null }, true],
    [{ mergeStateStatus: "unknown" }, true],
    [{ mergeStateStatus: "unstable" }, true],
    [{ state: "merged", checks: "pending" }, false],
  ];
  for (const [status, expected] of cases) {
    const svc = new OpenPrSnapshotService(() => 0);
    const forge = makeForge();
    (forge as unknown as Record<string, unknown>).listOpenPrSnapshot = async () =>
      snapshotWith(status);
    await svc.get(forge);
    expect(svc.hasTransient(forge, 1_000)).toBe(expected);
  }
});

test("hasTransient: a PR stuck transient stops counting after the window; a new head restarts it", async () => {
  let now = 0;
  let head = "h1";
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();
  (forge as unknown as Record<string, unknown>).listOpenPrSnapshot = async () =>
    snapshotWith({ checks: "pending", headSha: head });
  await svc.refresh(forge);
  expect(svc.hasTransient(forge, 1_000)).toBe(true);
  now = 500;
  await svc.refresh(forge); // same head, refetched: the window keeps its first sighting
  expect(svc.hasTransient(forge, 1_000)).toBe(true);
  now = 1_000;
  expect(svc.hasTransient(forge, 1_000)).toBe(false);
  head = "h2";
  await svc.refresh(forge);
  expect(svc.hasTransient(forge, 1_000)).toBe(true);
});

test("hasTransient: false without a cached snapshot or snapshot support", () => {
  const svc = new OpenPrSnapshotService(() => 0);
  expect(svc.hasTransient(makeForge(), 1_000)).toBe(false);
  expect(svc.hasTransient(makeForge("org/repo", { noSnapshot: true }), 1_000)).toBe(false);
});

test("a real fetch logs the slug and the caller that paid for it", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    const svc = new OpenPrSnapshotService(() => 0);
    const forge = makeForge();
    await withGhCaller("critic", () => svc.get(forge));
    await withGhCaller("critic", () => svc.get(forge)); // cache hit: no line
  } finally {
    console.log = orig;
  }
  expect(lines.filter((l) => l.startsWith("[open-pr-snapshot]"))).toEqual([
    "[open-pr-snapshot] org/repo: 1 open PRs (graphql) for critic",
  ]);
});

test("noteHeadRead: a disagreeing head read marks the snapshot stale until a later fetch", async () => {
  let now = 0;
  let status: Partial<PrStatus> = { checks: "pending" };
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();
  (forge as unknown as Record<string, unknown>).listOpenPrSnapshot = async () =>
    snapshotWith(status);
  await svc.get(forge);
  const read = snapshotWith({ checks: "pending" }).statuses.get("branch-a")!;
  svc.noteHeadRead(forge, "branch-a", read); // agrees
  svc.noteHeadRead(forge, "other", { ...read, checks: "success" }); // not in the snapshot
  expect(svc.isStale(forge)).toBe(false);
  now = 10;
  svc.noteHeadRead(forge, "branch-a", { ...read, checks: "success" });
  expect(svc.isStale(forge)).toBe(true);
  status = { checks: "success" };
  now = 20;
  await svc.refresh(forge);
  expect(svc.isStale(forge)).toBe(false);
});

// ── mergeability settle + patchPr + onUpdate ───────────────────────────────

/** A forge whose listings hand out `mergeable` from `seq` (last value repeats), PR #1 head `h1`. */
function settleForge(seq: Array<boolean | null>, source?: OpenPrSnapshot["source"]) {
  const forge = makeForge();
  let i = 0;
  (forge as unknown as Record<string, unknown>).listOpenPrSnapshot = async () => {
    const snap = makeSnapshot(1, source);
    const mergeable = seq[Math.min(i++, seq.length - 1)]!;
    return { ...snap, prs: [{ ...snap.prs[0]!, mergeable, headSha: "h1" }] };
  };
  return { forge, fetches: () => i };
}

/** A scheduler that queues timers for the test to fire. */
function fakeTimers() {
  const queued: Array<{ fn: () => void; ms: number }> = [];
  return {
    schedule: (fn: () => void, ms: number) => void queued.push({ fn, ms }),
    queued,
    async fire() {
      const t = queued.shift()!;
      t.fn();
      await new Promise((r) => setTimeout(r, 0));
      return t.ms;
    },
  };
}

test("settle: a snapshot holding unknown mergeability re-reads after SETTLE_DELAYS_MS", async () => {
  const timers = fakeTimers();
  const svc = new OpenPrSnapshotService(() => 0, 6, undefined, timers.schedule);
  const { forge, fetches } = settleForge([null, false]);
  await svc.get(forge);
  expect(timers.queued.map((t) => t.ms)).toEqual([SETTLE_DELAYS_MS[0]!]);
  await timers.fire();
  expect(fetches()).toBe(2);
  expect(svc.peek(forge)!.prs[0]!.mergeable).toBe(false);
  expect(timers.queued).toHaveLength(0); // settled: nothing more scheduled
});

test("settle: a settled snapshot schedules nothing", async () => {
  const timers = fakeTimers();
  const svc = new OpenPrSnapshotService(() => 0, 6, undefined, timers.schedule);
  await svc.get(settleForge([true]).forge);
  expect(timers.queued).toHaveLength(0);
});

test("settle: at most one attempt per delay for the same PR head", async () => {
  const timers = fakeTimers();
  const svc = new OpenPrSnapshotService(() => 0, 6, undefined, timers.schedule);
  const { forge, fetches } = settleForge([null]);
  await svc.get(forge);
  expect(await timers.fire()).toBe(SETTLE_DELAYS_MS[0]!);
  expect(await timers.fire()).toBe(SETTLE_DELAYS_MS[1]!);
  expect(timers.queued).toHaveLength(0);
  expect(fetches()).toBe(1 + SETTLE_DELAYS_MS.length);
  await svc.refresh(forge); // another reader's fetch doesn't re-arm the spent head
  expect(timers.queued).toHaveLength(0);
});

test("settle: a moved prs content key restarts the attempts", async () => {
  const timers = fakeTimers();
  let now = 0;
  const cache = new GithubReadCache(new SessionStore(":memory:"), { now: () => now });
  const fingerprint = (defaultHeadOid: string) =>
    cache.put("fingerprint", "org/repo", null, {
      openIssues: 0,
      issuesUpdatedAt: "",
      openPrs: 1,
      prsUpdatedAt: "t1",
      ciState: "",
      defaultHeadOid,
    });
  fingerprint("base1");
  const svc = new OpenPrSnapshotService(() => now, 6, cache, timers.schedule);
  const { forge } = settleForge([null]);
  await svc.get(forge);
  await timers.fire();
  await timers.fire();
  expect(timers.queued).toHaveLength(0);
  fingerprint("base2"); // the base moved: GitHub recomputes every PR's mergeability
  now = 1;
  await svc.get(forge);
  expect(timers.queued.map((t) => t.ms)).toEqual([SETTLE_DELAYS_MS[0]!]);
});

test("settle: never armed by a REST listing", async () => {
  const timers = fakeTimers();
  const svc = new OpenPrSnapshotService(() => 0, 6, undefined, timers.schedule);
  await svc.get(settleForge([null], "rest").forge);
  expect(timers.queued).toHaveLength(0);
});

test("settle: the re-read is skipped while GraphQL is limited or the background reserve is low", async () => {
  const timers = fakeTimers();
  let canRefresh = true;
  const cache = new GithubReadCache(new SessionStore(":memory:"), {
    now: () => 0,
    canRefresh: () => canRefresh,
  });
  const svc = new OpenPrSnapshotService(() => 0, 6, cache, timers.schedule);
  const { forge, fetches } = settleForge([null]);
  await svc.get(forge);
  blockGraphql();
  try {
    await timers.fire();
  } finally {
    unblockGraphql();
  }
  expect(fetches()).toBe(1);
  await svc.refresh(forge); // arms the second attempt
  canRefresh = false;
  await timers.fire();
  expect(fetches()).toBe(2);
});

test("patchPr: replaces the PR's row and status in place, keeps fetch time, notifies", async () => {
  let now = 0;
  const cache = new GithubReadCache(new SessionStore(":memory:"), { now: () => now });
  const svc = new OpenPrSnapshotService(() => now, 6, cache);
  const forge = makeForge();
  const updates: string[] = [];
  svc.onUpdate((slug) => updates.push(slug));
  await svc.get(forge);
  expect(updates).toEqual(["org/repo"]); // a fetch notifies too
  const before = svc.peek(forge)!;
  now = 5_000;
  const pr = { ...before.prs[0]!, mergeable: false, mergeStateStatus: "dirty" as const };
  const status: PrStatus = { ...before.statuses.get("branch-a")!, mergeable: false };
  svc.patchPr(forge, 1, { pr, status });
  const after = svc.peek(forge)!;
  expect(after.prs).toEqual([pr]);
  expect(after.statuses.get("branch-a")).toEqual(status);
  expect(cache.get("prs", "org/repo")!.at).toBe(0);
  expect(updates).toEqual(["org/repo", "org/repo"]);
  expect(forge.calls).toBe(1);
});

test("patchPr: a null read drops the PR; no snapshot or another PR is a no-op", async () => {
  const svc = new OpenPrSnapshotService(() => 0);
  const forge = makeForge();
  svc.patchPr(forge, 1, null); // nothing cached yet
  expect(svc.peek(forge)).toBeNull();
  await svc.get(forge);
  svc.patchPr(forge, 99, null);
  expect(svc.peek(forge)!.prs).toHaveLength(1);
  svc.patchPr(forge, 1, null);
  expect(svc.peek(forge)!.prs).toEqual([]);
  expect(svc.peek(forge)!.statuses.size).toBe(0);
});
