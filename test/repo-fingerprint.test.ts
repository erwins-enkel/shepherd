import { test, expect, spyOn } from "bun:test";
import {
  countsPlan,
  RepoFingerprintService,
  type FingerprintObservation,
  type FingerprintTarget,
} from "../src/repo-fingerprint";
import type { FingerprintResult, RepoFingerprint } from "../src/forge/github-fingerprint";
import type { RateLimitSnapshot } from "../src/forge/rate-limit";

const BASE: RepoFingerprint = {
  openIssues: 3,
  issuesUpdatedAt: "2026-10-01T00:00:00Z",
  openPrs: 2,
  prsUpdatedAt: "2026-10-02T00:00:00Z",
  ciState: "SUCCESS",
};

const HEALTHY: RateLimitSnapshot = {
  remaining: 4000,
  resetAt: null,
  pausedUntil: null,
  blocked: false,
};

function harness(
  opts: {
    targets?: FingerprintTarget[];
    minGapMs?: number;
  } = {},
) {
  let clock = 1_000_000;
  let rate: RateLimitSnapshot = { ...HEALTHY };
  const current = new Map<string, RepoFingerprint | null>([
    ["acme/web", { ...BASE }],
    ["acme/api", { ...BASE }],
  ]);
  const fetches: string[][] = [];
  const observations: FingerprintObservation[] = [];
  const targets = opts.targets ?? [
    { slug: "acme/web", paths: ["/r/web"] },
    { slug: "acme/api", paths: ["/r/api", "/r/api-ref"] },
  ];
  const svc = new RepoFingerprintService({
    listTargets: () => targets,
    fetch: async (slugs): Promise<FingerprintResult> => {
      fetches.push(slugs);
      return {
        fingerprints: new Map(slugs.map((s) => [s, current.get(s) ?? null])),
        rateLimit: { cost: 1, remaining: 4000, used: 1000, resetAt: clock + 3_600_000 },
      };
    },
    rateLimit: () => rate,
    onObserved: (o) => {
      observations.push(o);
    },
    now: () => clock,
    intervalMs: 120_000,
    reserve: 1_000,
    minGapMs: opts.minGapMs ?? 30_000,
  });
  return {
    svc,
    fetches,
    observations,
    current,
    advance: (ms: number) => {
      clock += ms;
    },
    setRate: (r: Partial<RateLimitSnapshot>) => {
      rate = { ...HEALTHY, ...r };
    },
    now: () => clock,
  };
}

test("first observation supplies every slug's issue key and reports it as a change", async () => {
  const h = harness();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(h.svc.issuesKey("acme/web")).toBeNull();
    await h.svc.tick();
    expect(h.fetches).toEqual([["acme/web", "acme/api"]]);
    expect(h.svc.issuesKey("acme/web")).not.toBeNull();
    const [obs] = h.observations;
    expect(obs!.changed.map((c) => [c.slug, c.first, c.issues, c.counts])).toEqual([
      ["acme/web", true, true, true],
      ["acme/api", true, true, true],
    ]);
    expect(obs!.changed[1]!.paths).toEqual(["/r/api", "/r/api-ref"]);
    expect(obs!.unchanged).toEqual([]);
  } finally {
    log.mockRestore();
  }
});

test("an unchanged fingerprint keeps the content key and reports the repo as unchanged", async () => {
  const h = harness();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await h.svc.tick();
    const gen = h.svc.issuesKey("acme/web");
    h.advance(120_000);
    await h.svc.tick();
    expect(h.svc.issuesKey("acme/web")).toBe(gen);
    expect(h.observations[1]!.changed).toEqual([]);
    expect(h.observations[1]!.unchanged.map((t) => t.slug)).toEqual(["acme/web", "acme/api"]);
  } finally {
    log.mockRestore();
  }
});

test("an issue change moves only that slug; a CI-only change reports counts, not issues", async () => {
  const h = harness();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await h.svc.tick();
    const web = h.svc.issuesKey("acme/web");
    const api = h.svc.issuesKey("acme/api");
    h.current.set("acme/web", { ...BASE, issuesUpdatedAt: "2026-10-03T00:00:00Z" });
    h.current.set("acme/api", { ...BASE, ciState: "FAILURE" });
    h.advance(120_000);
    await h.svc.tick();
    expect(h.svc.issuesKey("acme/web")).not.toBe(web);
    expect(h.svc.issuesKey("acme/api")).toBe(api);
    expect(h.observations[1]!.changed.map((c) => [c.slug, c.first, c.issues, c.counts])).toEqual([
      ["acme/web", false, true, false],
      ["acme/api", false, false, true],
    ]);
  } finally {
    log.mockRestore();
  }
});

test("an open-count change alone moves both the issue key and the counts", async () => {
  const h = harness();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await h.svc.tick();
    h.current.set("acme/web", { ...BASE, openIssues: 2 });
    h.current.set("acme/api", { ...BASE, openPrs: 3 });
    h.advance(120_000);
    await h.svc.tick();
    expect(h.observations[1]!.changed.map((c) => [c.slug, c.issues, c.counts])).toEqual([
      ["acme/web", true, true],
      ["acme/api", false, true],
    ]);
  } finally {
    log.mockRestore();
  }
});

test("an unreadable repo is not covered; the rest still are", async () => {
  const h = harness();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    h.current.set("acme/api", null);
    await h.svc.tick();
    expect(h.svc.covered("acme/web")).toBe(true);
    expect(h.svc.covered("acme/api")).toBe(false);
    expect(h.svc.issuesKey("acme/api")).toBeNull();
  } finally {
    log.mockRestore();
  }
});

test("coverage lapses after three intervals without an observation", async () => {
  const h = harness();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await h.svc.tick();
    h.advance(3 * 120_000 - 1);
    expect(h.svc.covered("acme/web")).toBe(true);
    h.advance(1);
    expect(h.svc.covered("acme/web")).toBe(false);
    expect(h.svc.issuesKey("acme/web")).toBeNull();
  } finally {
    log.mockRestore();
  }
});

test("below the reserve the background tick makes no call, coverage holds, ensureFresh still runs", async () => {
  const h = harness();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await h.svc.tick();
    h.setRate({ remaining: 900, resetAt: h.now() + 30 * 60_000 });
    h.advance(10 * 60_000);
    await h.svc.tick();
    expect(h.fetches).toHaveLength(1);
    expect(h.svc.covered("acme/web")).toBe(true); // paused → serve the cache, don't re-list
    await h.svc.ensureFresh();
    expect(h.fetches).toHaveLength(2);
    // Past resetAt the stale low reading no longer pauses the background refresh.
    h.advance(30 * 60_000);
    await h.svc.tick();
    expect(h.fetches).toHaveLength(3);
  } finally {
    log.mockRestore();
  }
});

test("while the GraphQL backoff is engaged neither the tick nor a demand calls GitHub", async () => {
  const h = harness();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    h.setRate({ blocked: true, pausedUntil: h.now() + 60_000 });
    await h.svc.tick();
    await h.svc.ensureFresh();
    await h.svc.refreshSoon();
    expect(h.fetches).toHaveLength(0);
  } finally {
    log.mockRestore();
  }
});

test("ensureFresh answers immediately after a recent run and runs once the gap has passed", async () => {
  const h = harness();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await h.svc.ensureFresh();
    expect(h.fetches).toHaveLength(1);
    h.advance(10_000);
    await Promise.all([h.svc.ensureFresh(), h.svc.ensureFresh()]);
    expect(h.fetches).toHaveLength(1);
    h.advance(30_000);
    await Promise.all([h.svc.ensureFresh(), h.svc.ensureFresh()]); // single-flight
    expect(h.fetches).toHaveLength(2);
  } finally {
    log.mockRestore();
  }
});

test("the background tick skips when a demanded run is fresher than half an interval", async () => {
  const h = harness();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await h.svc.ensureFresh();
    h.advance(59_000);
    await h.svc.tick();
    expect(h.fetches).toHaveLength(1);
    h.advance(1_000);
    await h.svc.tick();
    expect(h.fetches).toHaveLength(2);
  } finally {
    log.mockRestore();
  }
});

test("refreshSoon coalesces demands into one trailing run after the gap", async () => {
  // Real clock + a short gap: the trailing run is scheduled on a real timer.
  const fetches: number[] = [];
  const svc = new RepoFingerprintService({
    listTargets: () => [{ slug: "acme/web", paths: ["/r/web"] }],
    fetch: async (slugs) => {
      fetches.push(Date.now());
      return { fingerprints: new Map(slugs.map((s) => [s, { ...BASE }])), rateLimit: null };
    },
    rateLimit: () => HEALTHY,
    onObserved: () => {},
    minGapMs: 40,
  });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const t0 = Date.now();
    await svc.ensureFresh(); // run #1 at ~t0
    const a = svc.refreshSoon();
    const b = svc.refreshSoon();
    expect(a).toBe(b);
    await a;
    expect(fetches).toHaveLength(2);
    expect(fetches[1]! - t0).toBeGreaterThanOrEqual(35);
  } finally {
    log.mockRestore();
    svc.stop();
  }
});

test("a failed run is logged and reports nothing", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const failing = new RepoFingerprintService({
      listTargets: () => [{ slug: "acme/web", paths: ["/r/web"] }],
      fetch: async () => {
        throw new Error("boom");
      },
      rateLimit: () => HEALTHY,
      onObserved: () => {
        throw new Error("must not be called");
      },
    });
    await failing.tick();
    expect(warn).toHaveBeenCalled();
    expect(failing.covered("acme/web")).toBe(false);
  } finally {
    warn.mockRestore();
  }
});

test("countsPlan: re-fetch moved counts, first sightings only when uncached; restamp the rest", () => {
  const plan = countsPlan(
    {
      changed: [
        { slug: "a/moved", paths: ["/moved"], first: false, issues: false, counts: true },
        { slug: "a/issues", paths: ["/issues"], first: false, issues: true, counts: false },
        {
          slug: "a/new",
          paths: ["/new-cached", "/new-cold"],
          first: true,
          issues: true,
          counts: true,
        },
      ],
      unchanged: [{ slug: "a/same", paths: ["/same", "/same-ref"] }],
    },
    (path) => path === "/new-cached",
  );
  expect(plan.refresh).toEqual(["/moved", "/new-cold"]);
  expect(plan.touch).toEqual(["/issues", "/new-cached", "/same", "/same-ref"]);
});
