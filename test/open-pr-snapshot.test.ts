/**
 * Unit tests for OpenPrSnapshotService (src/open-pr-snapshot.ts).
 *
 * Uses a fake GitForge-shaped object with a controllable clock seam.
 */
import { test, expect } from "bun:test";
import { OpenPrSnapshotService, SNAPSHOT_TTL_MS } from "../src/open-pr-snapshot";
import type { GitForge, OpenPrSnapshot, PrStatus } from "../src/forge/types";

// ── helpers ────────────────────────────────────────────────────────────────

function makeSnapshot(id = 1): OpenPrSnapshot {
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
  expect(snap!.prs[0].number).toBe(1);
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

test("read-through: get after TTL expiry refetches", async () => {
  let now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();

  await svc.get(forge);
  now = SNAPSHOT_TTL_MS; // exactly expired
  const snap2 = await svc.get(forge);
  expect(forge.calls).toBe(2);
  // Second fetch returns snapshot with id=2
  expect(snap2!.prs[0].number).toBe(2);
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
  expect(snap2!.prs[0].number).toBe(2);
});

test("refresh: updates the cache so next get returns the refreshed value", async () => {
  const now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge();

  await svc.get(forge);
  await svc.refresh(forge);
  const snap3 = await svc.get(forge); // should be served from cache (no extra call)
  expect(forge.calls).toBe(2);
  expect(snap3!.prs[0].number).toBe(2);
});

test("preserve-on-error: failing refresh keeps last-known-good when a value exists", async () => {
  const now = 0;
  const svc = new OpenPrSnapshotService(() => now);
  const forge = makeForge("org/repo", { failSnapshot: false });

  const first = await svc.get(forge);
  expect(first!.prs[0].number).toBe(1);

  // Now make the forge fail
  (forge as unknown as Record<string, unknown>).listOpenPrSnapshot = async () => {
    throw new Error("transient failure");
  };

  const kept = await svc.refresh(forge);
  expect(kept!.prs[0].number).toBe(1); // last-known-good preserved
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
  expect(peeked!.prs[0].number).toBe(1);
  expect(forge.calls).toBe(1); // peek triggered no extra fetch
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
  expect(snap2!.prs[0].number).toBe(1);
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
