/**
 * Unit tests for BacklogPoller (src/backlog-poller.ts).
 *
 * The poller keeps CountsService's cache warm so GET /api/backlog serves from
 * memory. It only warms forge-backed repos (resolveForge non-null) and must
 * never throw, even if a warm call rejects — backlog freshness is best-effort.
 */
import { test, expect } from "bun:test";
import { BacklogPoller, reposUsedSince } from "../src/backlog-poller";

test("warms only forge-backed repos", async () => {
  const warmed: string[] = [];
  const poller = new BacklogPoller(
    () => [{ path: "/a" }, { path: "/b" }, { path: "/no-forge" }],
    (p) => (p === "/no-forge" ? null : { kind: "github", slug: "o/r" }),
    async (p) => {
      warmed.push(p);
      return { openIssues: 1, openPRs: 0, ciStatus: null, prKinds: null };
    },
  );

  await poller.tick();

  expect(warmed.sort()).toEqual(["/a", "/b"]);
});

test("skipRepo: repos the fingerprint keeps current are not warmed; onWarmed still fires", async () => {
  const warmed: string[] = [];
  let broadcasts = 0;
  const poller = new BacklogPoller(
    () => [{ path: "/covered" }, { path: "/gitea" }],
    () => ({ kind: "github", slug: "o/r" }),
    async (p) => {
      warmed.push(p);
      return { openIssues: 1, openPRs: 0, ciStatus: null, prKinds: null };
    },
    90_000,
    () => {
      broadcasts++;
    },
    () => true,
    undefined,
    (p) => p === "/covered",
  );

  await poller.tick();

  expect(warmed).toEqual(["/gitea"]);
  expect(broadcasts).toBe(1);
});

test("a rejecting warm does not sink the tick or sibling repos", async () => {
  const warmed: string[] = [];
  const poller = new BacklogPoller(
    () => [{ path: "/bad" }, { path: "/good" }],
    () => ({ kind: "github", slug: "o/r" }),
    async (p) => {
      warmed.push(p);
      if (p === "/bad") throw new Error("gh down");
      return { openIssues: 2, openPRs: 1, ciStatus: null, prKinds: null };
    },
  );

  await poller.tick(); // must resolve, not reject
  expect(warmed.sort()).toEqual(["/bad", "/good"]);
});

test("resolveForge is called per tick so repoMode flips propagate", async () => {
  // resolveForge is called per isForgeBacked call — BacklogPoller no longer
  // permanently caches the verdict so a repoMode toggle takes effect immediately.
  // The git shell-out avoidance is now the responsibility of makeForgeResolver
  // (which memoizes detectForge for forge repos internally).
  const resolveCalls: string[] = [];
  const poller = new BacklogPoller(
    () => [{ path: "/a" }, { path: "/no-forge" }],
    (p) => {
      resolveCalls.push(p);
      return p === "/no-forge" ? null : { kind: "github", slug: "o/r" };
    },
    async () => ({ openIssues: 1, openPRs: 0, ciStatus: null, prKinds: null }),
  );

  await poller.tick();
  await poller.tick();

  // resolveForge is called every tick (twice per path across 2 ticks)
  expect(resolveCalls.filter((p) => p === "/a").length).toBe(2);
  expect(resolveCalls.filter((p) => p === "/no-forge").length).toBe(2);
});

test("empty repo list is a no-op", async () => {
  let calls = 0;
  const poller = new BacklogPoller(
    () => [],
    () => ({ kind: "github", slug: "o/r" }),
    async () => {
      calls++;
      return { openIssues: 0, openPRs: 0, ciStatus: null, prKinds: null };
    },
  );
  await poller.tick();
  expect(calls).toBe(0);
});

test("calls onWarmed once after warming completes each tick", async () => {
  const order: string[] = [];
  const poller = new BacklogPoller(
    () => [{ path: "/a" }, { path: "/b" }],
    () => ({ kind: "github", slug: "o/r" }),
    async (p) => {
      order.push(`warm:${p}`);
      return { openIssues: 1, openPRs: 0, ciStatus: null, prKinds: null };
    },
    60_000,
    async () => {
      order.push("warmed");
    },
  );

  await poller.tick();

  // both warms happen before the single broadcast hook
  expect(order).toEqual(["warm:/a", "warm:/b", "warmed"]);
});

test("a throwing onWarmed does not sink the tick", async () => {
  const poller = new BacklogPoller(
    () => [{ path: "/a" }],
    () => ({ kind: "github", slug: "o/r" }),
    async () => ({ openIssues: 1, openPRs: 0, ciStatus: null, prKinds: null }),
    60_000,
    async () => {
      throw new Error("broadcast boom");
    },
  );

  await poller.tick(); // must resolve, not reject
  expect(true).toBe(true);
});

test("start/stop manage the interval timer without throwing", () => {
  const poller = new BacklogPoller(
    () => [],
    () => null,
    async () => ({ openIssues: null, openPRs: null, ciStatus: null, prKinds: null }),
    60_000,
  );
  poller.start();
  poller.stop();
  expect(true).toBe(true);
});

// ── shouldWarm() gating ───────────────────────────────────────────────────────

test("tick performs no warming and no broadcast when shouldWarm() is false", async () => {
  const warmed: string[] = [];
  let broadcasts = 0;
  const poller = new BacklogPoller(
    () => [{ path: "/a" }],
    () => ({ kind: "github", slug: "o/r" }),
    async (p) => {
      warmed.push(p);
      return { openIssues: 1, openPRs: 0, ciStatus: null, prKinds: null };
    },
    45_000,
    () => {
      broadcasts++;
    },
    () => false, // shouldWarm
  );

  await poller.tick();
  expect(warmed).toEqual([]);
  expect(broadcasts).toBe(0);
});

test("tick warms when shouldWarm() is true", async () => {
  const warmed: string[] = [];
  const poller = new BacklogPoller(
    () => [{ path: "/a" }],
    () => ({ kind: "github", slug: "o/r" }),
    async (p) => {
      warmed.push(p);
      return { openIssues: 1, openPRs: 0, ciStatus: null, prKinds: null };
    },
    45_000,
    undefined,
    () => true, // shouldWarm
  );

  await poller.tick();
  expect(warmed).toEqual(["/a"]);
});

// ── mode-aware forge-backed tests ─────────────────────────────────────────────

test("local forge (kind=local) is NOT forge-backed — not warmed", async () => {
  const warmed: string[] = [];
  const poller = new BacklogPoller(
    () => [{ path: "/local-repo" }, { path: "/github-repo" }],
    (p) => (p === "/local-repo" ? { kind: "local" } : { kind: "github", slug: "o/r" }),
    async (p) => {
      warmed.push(p);
      return { openIssues: 1, openPRs: 0, ciStatus: null, prKinds: null };
    },
  );

  await poller.tick();

  // local-repo must NOT be warmed; only the github-repo should be
  expect(warmed).toEqual(["/github-repo"]);
});

test("github forge (kind=github) is forge-backed", async () => {
  const warmed: string[] = [];
  const poller = new BacklogPoller(
    () => [{ path: "/gh" }],
    () => ({ kind: "github", slug: "o/r" }),
    async (p) => {
      warmed.push(p);
      return { openIssues: 0, openPRs: 0, ciStatus: null, prKinds: null };
    },
  );

  await poller.tick();
  expect(warmed).toEqual(["/gh"]);
});

test("repoMode flip propagates: local→github → repo starts being warmed", async () => {
  let forgeKind: "local" | "github" = "local";
  const warmed: string[] = [];

  const poller = new BacklogPoller(
    () => [{ path: "/flip" }],
    () => ({ kind: forgeKind }),
    async (p) => {
      warmed.push(p);
      return { openIssues: 0, openPRs: 0, ciStatus: null, prKinds: null };
    },
  );

  await poller.tick(); // kind=local → not warmed
  expect(warmed).toEqual([]);

  forgeKind = "github"; // flip
  await poller.tick(); // kind=github → warmed
  expect(warmed).toEqual(["/flip"]);
});

// ── hot/cold tiering (#2656) ──────────────────────────────────────────────────

const COUNTS = { openIssues: 0, openPRs: 0, ciStatus: null, prKinds: null };

test("tiering: hot repos warm every tick, cold repos once per cold interval", async () => {
  let clock = 1_000_000;
  const warmed: string[] = [];
  const poller = new BacklogPoller(
    () => [{ path: "/hot" }, { path: "/cold" }],
    () => ({ kind: "github" }),
    async (p) => {
      warmed.push(p);
      return COUNTS;
    },
    90_000,
    undefined,
    undefined,
    { hotRepos: () => new Set(["/hot"]), coldIntervalMs: 900_000, now: () => clock },
  );

  await poller.tick(); // first tick: nothing warmed yet → both
  expect(warmed.sort()).toEqual(["/cold", "/hot"]);

  warmed.length = 0;
  clock += 90_000;
  await poller.tick(); // cold repo is not due yet
  expect(warmed).toEqual(["/hot"]);

  warmed.length = 0;
  clock += 900_000;
  await poller.tick(); // cold interval elapsed → both again
  expect(warmed.sort()).toEqual(["/cold", "/hot"]);
});

test("tiering: a failed cold warm waits out its interval instead of retrying every tick", async () => {
  let clock = 0;
  let calls = 0;
  const poller = new BacklogPoller(
    () => [{ path: "/cold" }],
    () => ({ kind: "github" }),
    async () => {
      calls++;
      throw new Error("API rate limit exceeded");
    },
    90_000,
    undefined,
    undefined,
    { hotRepos: () => new Set(), coldIntervalMs: 900_000, now: () => clock },
  );

  await poller.tick();
  clock += 90_000;
  await poller.tick();
  expect(calls).toBe(1);
});

test("tiering: a repo turning hot is warmed on the next tick", async () => {
  let clock = 0;
  const hot = new Set<string>();
  const warmed: string[] = [];
  const poller = new BacklogPoller(
    () => [{ path: "/a" }],
    () => ({ kind: "github" }),
    async (p) => {
      warmed.push(p);
      return COUNTS;
    },
    90_000,
    undefined,
    undefined,
    { hotRepos: () => hot, coldIntervalMs: 900_000, now: () => clock },
  );

  await poller.tick();
  clock += 90_000;
  hot.add("/a"); // operator starts a session in /a
  await poller.tick();
  expect(warmed).toEqual(["/a", "/a"]);
});

test("reposUsedSince keeps only repos with a session at or after the cutoff", () => {
  expect(reposUsedSince({ "/new": 500, "/edge": 400, "/old": 399 }, 400)).toEqual(
    new Set(["/new", "/edge"]),
  );
});
