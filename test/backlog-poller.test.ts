/**
 * Unit tests for BacklogPoller (src/backlog-poller.ts).
 *
 * The poller keeps CountsService's cache warm so GET /api/backlog serves from
 * memory. It only warms forge-backed repos (resolveForge non-null) and must
 * never throw, even if a warm call rejects — backlog freshness is best-effort.
 */
import { test, expect, describe } from "bun:test";
import type { BacklogPayload } from "../src/server";
import { BacklogPoller, createBacklogBroadcast } from "../src/backlog-poller";

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

// ── warm repo gate (#2837) ────────────────────────────────────────────────────

const COUNTS = { openIssues: 0, openPRs: 0, ciStatus: null, prKinds: null };

test("warm gate: cold repos are never warmed; a repo turning warm is warmed next tick", async () => {
  const warm = new Set(["/warm"]);
  const warmed: string[] = [];
  const poller = new BacklogPoller(
    () => [{ path: "/warm" }, { path: "/cold" }],
    () => ({ kind: "github" }),
    async (p) => {
      warmed.push(p);
      return COUNTS;
    },
    90_000,
    undefined,
    undefined,
    (p) => warm.has(p),
  );
  for (let i = 0; i < 20; i++) await poller.tick();
  expect(new Set(warmed)).toEqual(new Set(["/warm"]));
  warmed.length = 0;
  warm.add("/cold"); // operator opens /cold
  await poller.tick();
  expect(warmed.sort()).toEqual(["/cold", "/warm"]);
});

describe("changed backlog broadcasts", () => {
  const empty = { projects: [], pinnedPath: null, totals: { openIssues: 0, openPRs: 0 } };

  test("sends full changes, suppresses repeats and shares overlapping builds", async () => {
    let payload: BacklogPayload = structuredClone(empty);
    let builds = 0;
    const sent: BacklogPayload[] = [];
    const broadcast = createBacklogBroadcast(
      async () => {
        builds++;
        return payload;
      },
      (p) => sent.push(structuredClone(p)),
    );
    await Promise.all([broadcast(), broadcast()]);
    expect(builds).toBe(1);
    await broadcast();
    expect(sent).toHaveLength(1);
    payload = { ...payload, pinnedPath: "/repo" };
    await broadcast();
    expect(sent.at(-1)).toEqual(payload);
    payload = structuredClone(empty);
    await broadcast();
    expect(sent).toHaveLength(3);
  });

  test("build and publication failures release the flight and do not mark data sent", async () => {
    let failBuild = true;
    let failEmit = true;
    let sent = 0;
    const broadcast = createBacklogBroadcast(
      async () => {
        if (failBuild) throw new Error("build");
        return empty;
      },
      () => {
        if (failEmit) throw new Error("emit");
        sent++;
      },
    );
    await expect(broadcast()).rejects.toThrow("build");
    failBuild = false;
    await expect(broadcast()).rejects.toThrow("emit");
    failEmit = false;
    await broadcast();
    await broadcast();
    expect(sent).toBe(1);
  });
});

test("a backlog invalidation during a build is not lost until the next poll", async () => {
  const initial: BacklogPayload = {
    projects: [],
    pinnedPath: null,
    totals: { openIssues: 0, openPRs: 0 },
  };
  let current = initial;
  let release!: (p: BacklogPayload) => void;
  let builds = 0;
  const sent: BacklogPayload[] = [];
  const broadcast = createBacklogBroadcast(
    () => {
      builds++;
      return builds === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(current);
    },
    (p) => sent.push(p),
  );
  const flight = broadcast();
  await Promise.resolve();
  current = { ...initial, pinnedPath: "/new-project" };
  const overlapping = broadcast();
  release(initial);
  await Promise.all([flight, overlapping]);
  expect(sent.at(-1)).toEqual(current);
  expect(builds).toBe(2);
});
