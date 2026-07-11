import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import type { DrainStatus } from "../src/drain";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-drain-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function harness(
  drain?: Omit<
    NonNullable<AppDeps["drain"]>,
    "retainClaim" | "buildEpic" | "diagnoseEpic" | "approveEpicNext" | "tick"
  >,
): {
  app: ReturnType<typeof makeApp>;
  store: SessionStore;
} {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    // these drain tests don't exercise relaunch; stub retainClaim + epic methods
    // so the route's drain interface is satisfied.
    drain: drain
      ? {
          ...drain,
          retainClaim: () => {},
          buildEpic: async () => null,
          diagnoseEpic: async () => null,
          approveEpicNext: () => {},
          tick: async () => {},
        }
      : undefined,
  };
  return { app: makeApp(deps), store };
}

function putRepoConfig(app: ReturnType<typeof makeApp>, body: unknown) {
  return app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function getRepoConfig(app: ReturnType<typeof makeApp>) {
  return app.fetch(new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`));
}

// ── PUT /api/repo-config drain fields ────────────────────────────────────────

test("PUT drain fields round-trips through GET", async () => {
  const { app } = harness();
  const put = await putRepoConfig(app, {
    autoDrainEnabled: true,
    maxAuto: 3,
    autoLabel: "go",
    usageCeilingPct: 60,
  });
  expect(put.status).toBe(200);
  const putBody = await put.json();
  expect(putBody.autoDrainEnabled).toBe(true);
  expect(putBody.maxAuto).toBe(3);
  expect(putBody.autoLabel).toBe("go");
  expect(putBody.usageCeilingPct).toBe(60);

  const get = await getRepoConfig(app);
  expect(get.status).toBe(200);
  const getBody = await get.json();
  expect(getBody.autoDrainEnabled).toBe(true);
  expect(getBody.maxAuto).toBe(3);
  expect(getBody.autoLabel).toBe("go");
  expect(getBody.usageCeilingPct).toBe(60);
  // existing fields untouched
  expect(getBody.criticEnabled).toBe(true);
  expect(getBody.autoAddressEnabled).toBe(false);
});

test("PUT drain fields update independently — other fields preserved", async () => {
  const { app } = harness();
  // first set criticEnabled=false
  await putRepoConfig(app, { criticEnabled: false });
  // then set only drain fields
  const put = await putRepoConfig(app, { autoDrainEnabled: true });
  expect(put.status).toBe(200);
  const body = await put.json();
  expect(body.criticEnabled).toBe(false); // preserved
  expect(body.autoDrainEnabled).toBe(true);
});

// ── Validation 400s ───────────────────────────────────────────────────────────

test("PUT maxAuto: 0 → 400", async () => {
  const { app } = harness();
  const res = await putRepoConfig(app, { maxAuto: 0 });
  expect(res.status).toBe(400);
});

test("PUT maxAuto: -5 → 400", async () => {
  const { app } = harness();
  const res = await putRepoConfig(app, { maxAuto: -5 });
  expect(res.status).toBe(400);
});

test("PUT maxAuto: non-integer → 400", async () => {
  const { app } = harness();
  const res = await putRepoConfig(app, { maxAuto: 1.5 });
  expect(res.status).toBe(400);
});

test("PUT maxAuto: NaN → 400", async () => {
  const { app } = harness();
  // JSON doesn't encode NaN, send a non-number string instead
  const res = await putRepoConfig(app, { maxAuto: "x" });
  expect(res.status).toBe(400);
});

test("PUT autoLabel: empty string → 400", async () => {
  const { app } = harness();
  const res = await putRepoConfig(app, { autoLabel: "" });
  expect(res.status).toBe(400);
});

test("PUT autoLabel: whitespace-only → 400", async () => {
  const { app } = harness();
  const res = await putRepoConfig(app, { autoLabel: "   " });
  expect(res.status).toBe(400);
});

test("PUT autoLabel: non-string → 400", async () => {
  const { app } = harness();
  const res = await putRepoConfig(app, { autoLabel: 42 });
  expect(res.status).toBe(400);
});

test("PUT usageCeilingPct: non-number string → 400", async () => {
  const { app } = harness();
  const res = await putRepoConfig(app, { usageCeilingPct: "x" });
  expect(res.status).toBe(400);
});

test("PUT autoDrainEnabled: non-boolean → 400", async () => {
  const { app } = harness();
  const res = await putRepoConfig(app, { autoDrainEnabled: "yes" });
  expect(res.status).toBe(400);
});

// ── Clamping ──────────────────────────────────────────────────────────────────

test("PUT maxAuto: 999 → stored as 20", async () => {
  const { app } = harness();
  const put = await putRepoConfig(app, { maxAuto: 999 });
  expect(put.status).toBe(200);
  expect((await put.json()).maxAuto).toBe(20);

  const get = await getRepoConfig(app);
  expect((await get.json()).maxAuto).toBe(20);
});

test("PUT usageCeilingPct: 150 → stored as 100", async () => {
  const { app } = harness();
  const put = await putRepoConfig(app, { usageCeilingPct: 150 });
  expect(put.status).toBe(200);
  expect((await put.json()).usageCeilingPct).toBe(100);
});

test("PUT usageCeilingPct: -5 → stored as 0", async () => {
  const { app } = harness();
  const put = await putRepoConfig(app, { usageCeilingPct: -5 });
  expect(put.status).toBe(200);
  expect((await put.json()).usageCeilingPct).toBe(0);
});

test("PUT usageCeilingPct: 60.9 → stored as floor (60)", async () => {
  const { app } = harness();
  const put = await putRepoConfig(app, { usageCeilingPct: 60.9 });
  expect(put.status).toBe(200);
  expect((await put.json()).usageCeilingPct).toBe(60);
});

test("PUT autoLabel: trims whitespace", async () => {
  const { app } = harness();
  const put = await putRepoConfig(app, { autoLabel: "  my-label  " });
  expect(put.status).toBe(200);
  expect((await put.json()).autoLabel).toBe("my-label");
});

// ── GET /api/drain ────────────────────────────────────────────────────────────

test("GET /api/drain returns array from drain.snapshot()", async () => {
  const status: DrainStatus = {
    repoPath: repoDir,
    enabled: true,
    paused: false,
    reason: null,
    detail: null,
    queued: 2,
    inFlight: 1,
    max: 3,
    epicParent: null,
  };
  const { app } = harness({ snapshot: async () => [status], queue: async () => [] });
  const res = await app.fetch(new Request("http://x/api/drain"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([status]);
});

test("GET /api/drain returns [] when deps.drain is absent", async () => {
  const { app } = harness(undefined);
  const res = await app.fetch(new Request("http://x/api/drain"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

test("GET /api/drain with extra path segment → 404", async () => {
  const { app } = harness({ snapshot: async () => [], queue: async () => [] });
  const res = await app.fetch(new Request("http://x/api/drain/extra"));
  expect(res.status).toBe(404);
});

// ── GET /api/drain/queue?repo= ──────────────────────────────────────────────

test("GET /api/drain/queue returns the repo's queued items from drain.queue()", async () => {
  const items = [
    { number: 7, title: "fix the thing", url: "https://x/7" },
    { number: 9, title: "do the other", url: "https://x/9" },
  ];
  let askedFor = "";
  const { app } = harness({
    snapshot: async () => [],
    queue: async (repoPath) => {
      askedFor = repoPath;
      return items;
    },
  });
  const res = await app.fetch(
    new Request(`http://x/api/drain/queue?repo=${encodeURIComponent(repoDir)}`),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(items);
  expect(askedFor).toBe(repoDir);
});

test("GET /api/drain/queue with invalid repo → 400", async () => {
  const { app } = harness({ snapshot: async () => [], queue: async () => [] });
  const res = await app.fetch(new Request("http://x/api/drain/queue?repo=/nope/not/here"));
  expect(res.status).toBe(400);
});

test("GET /api/drain/queue returns [] when deps.drain is absent", async () => {
  const { app } = harness(undefined);
  const res = await app.fetch(
    new Request(`http://x/api/drain/queue?repo=${encodeURIComponent(repoDir)}`),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});
