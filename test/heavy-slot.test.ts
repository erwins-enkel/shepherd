import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { SessionStore } from "../src/store";
import {
  HeavySlotService,
  environValue,
  scanMarkersLinux,
  type HeavySlotDeps,
  type ProcStat,
} from "../src/heavy-slot";
import { RUNNING_GRACE_MS, type MemorySample, type HeavySlotBudget } from "../src/heavy-slot-core";
import {
  DISABLED_HEAVY_SLOT,
  parseHeavySlotSnapshot,
  type HeavySlotSnapshot,
} from "../src/heavy-slot-snapshot";
import { validateResponse } from "./contract/harness";
import type { Session } from "../src/types";
import { makeApp, type AppDeps } from "../src/server";

// HeavySlotService (#3181): the persisted queue, the steer that hands a freed slot over, the
// process binding through a scan, and the restart path — against a real (in-memory) store with
// the clock, the scan, the memory sampler and the steer injected.

const GIB = 1024 ** 3;
const BUDGET: HeavySlotBudget = {
  slots: 1,
  minAvailableBytes: 4 * GIB,
  psiFullMax: 20,
  releaseHoldMs: 30_000,
};
const HEALTHY = { availableBytes: 20 * GIB, psiFullAvg10: 0 };

interface Harness {
  svc: HeavySlotService;
  store: SessionStore;
  sessions: Map<string, Partial<Session>>;
  steers: [string, string][];
  emitted: HeavySlotSnapshot[];
  alive: Map<string, ProcStat>;
  clock: { t: number };
  memory: { sample: MemorySample };
  steerOk: { value: boolean };
  deps: HeavySlotDeps;
}

const live: HeavySlotService[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.stop();
});

function harness(over: Partial<HeavySlotDeps> = {}, store = new SessionStore(":memory:")): Harness {
  const sessions = new Map<string, Partial<Session>>();
  for (const id of ["s1", "s2", "s3"])
    sessions.set(id, { id, status: "running", repoPath: "/repo", worktreePath: `/wt/${id}` });
  const h = {
    store,
    sessions,
    steers: [] as [string, string][],
    emitted: [] as HeavySlotSnapshot[],
    alive: new Map<string, ProcStat>(),
    clock: { t: 1_000_000 },
    memory: { sample: { ...HEALTHY } },
    steerOk: { value: true },
  };
  let n = 0;
  const deps: HeavySlotDeps = {
    store: {
      get: (id: string) => (sessions.get(id) as Session | undefined) ?? null,
      listHeavySlotJobs: (s) => store.listHeavySlotJobs(s),
      upsertHeavySlotJob: (j) => store.upsertHeavySlotJob(j),
      heavySlotDurations: (k) => store.heavySlotDurations(k),
      pruneHeavySlotJobs: (b) => store.pruneHeavySlotJobs(b),
    } as HeavySlotDeps["store"],
    events: { emit: (_e: string, d: unknown) => void h.emitted.push(d as HeavySlotSnapshot) },
    steer: async (id, text) => {
      h.steers.push([id, text]);
      return h.steerOk.value;
    },
    enabled: true,
    budget: BUDGET,
    now: () => h.clock.t,
    newId: () => `j${++n}`,
    scanMarkers: async (ids) => new Map([...h.alive].filter(([id]) => ids.has(id))),
    sampleMemory: async () => h.memory.sample,
    platform: "linux",
    ...over,
  };
  const svc = new HeavySlotService(deps);
  live.push(svc);
  return { ...h, svc, deps };
}

/** Move the clock, then run one sweep the way the interval does. */
async function advance(h: Harness, ms: number) {
  h.clock.t += ms;
  await h.svc.sweep();
}

describe("HeavySlotService", () => {
  test("two sessions at once: one runs, the other gets place and a NOT RUN message", async () => {
    const h = harness();
    await h.svc.start();
    const a = await h.svc.acquire("s1", "bun run test", "/wt/s1");
    const b = await h.svc.acquire("s2", "cargo clippy --all-targets", "/wt/s2/cli");
    expect(a).toEqual({ decision: "run", jobId: "j1" });
    expect(b).toMatchObject({
      decision: "queued",
      position: 1,
      total: 1,
      reason: "slot",
      etaMs: null,
    });
    expect(b && "message" in b && b.message).toContain("NOT RUN");
    expect(h.svc.waiting("s2")).toBe(true);
    expect(h.emitted.at(-1)).toMatchObject({
      holders: [{ sessionId: "s1" }],
      waiters: [{ sessionId: "s2", position: 1 }],
    });
  });

  test("finish with leftovers lingers; once they are gone the head is offered and steered once", async () => {
    const h = harness();
    await h.svc.start();
    await h.svc.acquire("s1", "bun run test", "/wt/s1");
    await h.svc.acquire("s2", "bun run check", "/wt/s2");
    h.alive.set("j1", { count: 2, rssBytes: 1.4 * GIB });
    expect(await h.svc.finish("s1", "j1", 0)).toBe(true);
    let snap = h.svc.snapshot();
    expect(snap.holders[0]).toMatchObject({ sessionId: "s1", rssBytes: 1.4 * GIB });
    expect(h.store.listHeavySlotJobs(["lingering"])).toMatchObject([{ id: "j1" }]);
    expect(h.steers).toEqual([]);

    h.alive.delete("j1");
    await advance(h, 11_000);
    snap = h.svc.snapshot();
    expect(snap.holders.map((j) => j.sessionId)).toEqual(["s2"]);
    expect(h.store.listHeavySlotJobs(["offered"])).toMatchObject([{ id: "j2" }]);
    expect(h.steers).toHaveLength(1);
    expect(h.steers[0]![0]).toBe("s2");
    expect(h.steers[0]![1]).toContain("`bun run check`");

    await advance(h, 11_000);
    expect(h.steers).toHaveLength(1);
    const claim = await h.svc.acquire("s2", "bun run check", "/wt/s2");
    expect(claim).toEqual({ decision: "run", jobId: "j2" });
  });

  test("a steer that does not land drops that job and offers the next", async () => {
    const h = harness();
    await h.svc.start();
    await h.svc.acquire("s1", "a", null);
    await h.svc.acquire("s2", "b", null);
    await h.svc.acquire("s3", "c", null);
    h.steerOk.value = false;
    await h.svc.finish("s1", "j1", 0);
    expect(h.steers.map(([id]) => id)).toEqual(["s2", "s3"]);
    expect(h.svc.snapshot()).toMatchObject({ holders: [], waiters: [] });
  });

  test("a runner killed mid-run holds the slot while marker processes live, then frees it", async () => {
    const h = harness();
    await h.svc.start();
    await h.svc.acquire("s1", "bun run test", null);
    await h.svc.acquire("s2", "bun run test", null);
    h.alive.set("j1", { count: 5, rssBytes: GIB });
    await advance(h, RUNNING_GRACE_MS + 1);
    expect(h.svc.snapshot().holders[0]).toMatchObject({ sessionId: "s1", rssBytes: GIB });
    h.alive.delete("j1");
    await advance(h, 11_000);
    expect(h.store.listHeavySlotJobs(["offered"])).toMatchObject([{ id: "j2" }]);
  });

  test("restart: a new service over the same store keeps live holders and the queue order", async () => {
    const store = new SessionStore(":memory:");
    const h = harness({}, store);
    await h.svc.start();
    await h.svc.acquire("s1", "x", null);
    await h.svc.acquire("s2", "y", null);
    await h.svc.acquire("s3", "z", null);
    h.svc.stop();

    const again = harness({ newId: () => "fresh" }, store);
    again.clock.t = h.clock.t + RUNNING_GRACE_MS + 1;
    again.alive.set("j1", { count: 1, rssBytes: 0 });
    await again.svc.start();
    expect(again.svc.snapshot()).toMatchObject({
      holders: [{ sessionId: "s1" }],
      waiters: [
        { sessionId: "s2", position: 1 },
        { sessionId: "s3", position: 2 },
      ],
    });

    const third = harness({}, store);
    third.clock.t = again.clock.t + 1;
    await third.svc.start();
    expect(third.svc.snapshot()).toMatchObject({
      holders: [{ sessionId: "s2" }],
      waiters: [{ sessionId: "s3", position: 1 }],
    });
  });

  test("the brake queues with the pressure reason despite a fast, healthy-looking server", async () => {
    const h = harness();
    await h.svc.start();
    h.memory.sample = { availableBytes: 2.7 * GIB, psiFullAvg10: 59.9 };
    h.clock.t += 6_000; // the boot sample went stale, so the acquire takes a fresh one
    const out = await h.svc.acquire("s1", "bun run test", null);
    expect(out).toMatchObject({ decision: "queued", reason: "pressure" });
    expect(out && "message" in out && out.message).toContain("memory pressure");
    expect(h.svc.snapshot().brake).toMatchObject({ active: true, reason: "memory" });

    h.memory.sample = { ...HEALTHY };
    await advance(h, 5_000);
    await advance(h, 5_000);
    expect(h.steers).toEqual([]);
    await advance(h, 30_000);
    expect(h.steers.map(([id]) => id)).toEqual(["s1"]);
  });

  test("disabled: unmanaged answers, and persisted waiters are dropped at boot", async () => {
    const store = new SessionStore(":memory:");
    const h = harness({}, store);
    await h.svc.start();
    await h.svc.acquire("s1", "x", null);
    await h.svc.acquire("s2", "y", null);
    h.svc.stop();

    const off = harness({ enabled: false }, store);
    await off.svc.start();
    expect(await off.svc.acquire("s3", "z", null)).toEqual({ decision: "run", unmanaged: true });
    expect(store.listHeavySlotJobs(["queued", "running"])).toEqual([]);
    expect(store.listHeavySlotJobs(["dropped"]).map((j) => j.dropReason)).toEqual([
      "disabled",
      "disabled",
    ]);
  });

  test("unknown or archived sessions get no slot; reports on another session's job are refused", async () => {
    const h = harness();
    await h.svc.start();
    expect(await h.svc.acquire("nope", "x", null)).toBeNull();
    h.sessions.get("s3")!.status = "archived";
    expect(await h.svc.acquire("s3", "x", null)).toBeNull();
    await h.svc.acquire("s1", "x", null);
    expect(await h.svc.finish("s2", "j1", 0)).toBe(false);
    expect(await h.svc.started("s2", "j1", 1)).toBe(false);
  });

  test("operator release frees a lingering slot without waiting for the scan", async () => {
    const h = harness();
    await h.svc.start();
    await h.svc.acquire("s1", "x", null);
    await h.svc.acquire("s2", "y", null);
    h.alive.set("j1", { count: 1, rssBytes: 0 });
    await h.svc.finish("s1", "j1", 0);
    expect(await h.svc.release("s2")).toBe(false);
    expect(await h.svc.release("s1")).toBe(true);
    expect(h.steers.map(([id]) => id)).toEqual(["s2"]);
  });

  test("completed occupancy feeds the next wait estimate", async () => {
    const h = harness();
    await h.svc.start();
    await h.svc.acquire("s1", "bun run test", "/wt/s1");
    h.clock.t += 120_000;
    await h.svc.finish("s1", "j1", 0);
    await h.svc.acquire("s2", "bun run test", "/wt/s2");
    h.clock.t += 30_000;
    const out = await h.svc.acquire("s3", "bun run test", "/wt/s3");
    expect(out).toMatchObject({ decision: "queued", position: 1, etaMs: 90_000 });
    expect(out && "message" in out && out.message).toContain("estimated wait ~2 min");
  });

  test("macOS pressure blocks free slots and offers until healthy for 30 seconds", async () => {
    const h = harness({ platform: "darwin" });
    h.memory.sample = { availableBytes: 20 * GIB, psiFullAvg10: null, darwinPressure: "warning" };
    await h.svc.start();
    expect(await h.svc.acquire("s1", "x", null)).toMatchObject({
      decision: "queued",
      reason: "pressure",
    });
    expect(h.svc.snapshot()).toMatchObject({
      brake: { active: true },
      pressure: { memFullAvg10: null },
    });
    await advance(h, 40_000);
    expect(h.steers).toHaveLength(0);
    h.memory.sample.darwinPressure = "normal";
    await advance(h, 5_000);
    await advance(h, 29_999);
    expect(h.steers).toHaveLength(0);
    await advance(h, 1);
    expect(h.steers.map(([id]) => id)).toEqual(["s1"]);
  });

  test("macOS detached markers survive finish and restart; unknown scans never free the slot", async () => {
    const procs = new Map([["j1", { count: 1, rssBytes: 1234 }]]);
    let complete = true;
    const h = harness({
      platform: "darwin",
      groupAlive: () => false,
      scanMarkersDarwin: async () => ({ procs, complete }),
    });
    await h.svc.start();
    await h.svc.acquire("s1", "x", null);
    await h.svc.started("s1", "j1", 4242);
    await h.svc.acquire("s2", "y", null);
    await h.svc.finish("s1", "j1", 0);
    expect(h.store.listHeavySlotJobs(["lingering"])).toHaveLength(1);
    h.svc.stop();
    const restarted = new HeavySlotService(h.deps);
    live.push(restarted);
    await restarted.start();
    expect(h.steers).toHaveLength(0);
    procs.clear();
    complete = false;
    await restarted.sweep(true);
    expect(h.steers).toHaveLength(0);
    complete = true;
    await restarted.sweep(true);
    await restarted.sweep(true);
    expect(h.steers.map(([id]) => id)).toEqual(["s2"]);
  });

  test("macOS: the reported process group stands in for the marker scan", async () => {
    const groups = new Set([4242]);
    const h = harness({
      platform: "darwin",
      groupAlive: (g) => groups.has(g),
      scanMarkers: undefined,
      scanMarkersDarwin: async () => ({ procs: new Map(), complete: true }),
    });
    await h.svc.start();
    await h.svc.acquire("s1", "x", null);
    await h.svc.acquire("s2", "y", null);
    expect(await h.svc.started("s1", "j1", 4242)).toBe(true);
    await h.svc.finish("s1", "j1", 0);
    expect(h.store.listHeavySlotJobs(["lingering"])).toMatchObject([{ id: "j1" }]);
    groups.clear();
    await advance(h, 11_000);
    expect(h.svc.snapshot().holders.map((j) => j.sessionId)).toEqual(["s2"]);
  });
});

describe("marker scan", () => {
  test("environValue reads one entry of a NUL-separated block", () => {
    expect(environValue("A=1\0SHEPHERD_HEAVY_JOB=abc\0B=2", "SHEPHERD_HEAVY_JOB")).toBe("abc");
    expect(environValue("XSHEPHERD_HEAVY_JOB=abc\0", "SHEPHERD_HEAVY_JOB")).toBeNull();
  });

  test.skipIf(process.platform !== "linux")(
    "finds a real process (and its child) by the marker, and nothing once they exit",
    async () => {
      const marker = `scan-${process.pid}-${Date.now()}`;
      const child = spawn("sh", ["-c", "sleep 5 & sleep 5"], {
        env: { ...process.env, SHEPHERD_HEAVY_JOB: marker },
        stdio: "ignore",
        detached: true,
      });
      await new Promise((r) => setTimeout(r, 150));
      const found = await scanMarkersLinux(new Set([marker, "other"]));
      expect(found?.get(marker)?.count).toBeGreaterThanOrEqual(2);
      expect(found?.get(marker)?.rssBytes).toBeGreaterThan(0);
      expect(found?.has("other")).toBe(false);
      process.kill(-child.pid!, "SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
      expect((await scanMarkersLinux(new Set([marker])))?.get(marker)).toBeUndefined();
    },
  );
});

describe("heavy-slot Epic compatibility", () => {
  test("live GET and WS snapshots satisfy the Epic contract through all holding states", async () => {
    const h = harness();
    await h.svc.start();
    await h.svc.acquire("s1", "x", null);
    await h.svc.acquire("s2", "y", null);
    const app = makeApp({ heavySlot: h.svc } as unknown as AppDeps);
    async function check(holder: string) {
      const res = await app.fetch(new Request("http://x/api/heavy-slot"));
      const snap = await validateResponse("GET", "/api/heavy-slot", res);
      expect(snap).toEqual(parseHeavySlotSnapshot(snap));
      expect(snap).toEqual(h.emitted.at(-1));
      expect(snap).toMatchObject({ enabled: true, capacity: 1, holders: [{ sessionId: holder }] });
      return snap;
    }
    expect(await check("s1")).toMatchObject({
      waiters: [{ sessionId: "s2", position: 1, reason: "slot" }],
    });
    h.alive.set("j1", { count: 2, rssBytes: GIB });
    await h.svc.finish("s1", "j1", 0);
    expect(await check("s1")).toMatchObject({ holders: [{ rssBytes: GIB }] });
    h.alive.clear();
    await advance(h, 11_000);
    expect(await check("s2")).toMatchObject({ holders: [{ startedAt: h.clock.t }], waiters: [] });
    expect(await h.svc.acquire("s2", "y", null)).toEqual({ decision: "run", jobId: "j2" });
    await check("s2");
  });

  test("same-clock requests retain arrival order across restart despite reverse-sorted IDs", async () => {
    const ids = ["holder", "z-first", "a-second"];
    const store = new SessionStore(":memory:");
    const h = harness({ newId: () => ids.shift()! }, store);
    await h.svc.start();
    await h.svc.acquire("s1", "holder", null);
    await h.svc.acquire("s2", "first", null);
    await h.svc.acquire("s3", "second", null);
    expect(h.svc.snapshot().waiters.map((j) => j.sessionId)).toEqual(["s2", "s3"]);
    h.svc.stop();
    const again = harness({}, store);
    again.alive.set("holder", { count: 1, rssBytes: 0 });
    await again.svc.start();
    expect(again.svc.snapshot().waiters.map((j) => j.sessionId)).toEqual(["s2", "s3"]);
    await again.svc.release("s1");
    expect(again.steers.map(([id]) => id)).toEqual(["s2"]);
  });

  test("unknown process liveness keeps a finished job bound until a successful scan", async () => {
    let readable = false;
    const h = harness({ scanMarkers: async () => (readable ? new Map() : null) });
    await h.svc.start();
    await h.svc.acquire("s1", "x", null);
    await h.svc.acquire("s2", "y", null);
    await h.svc.finish("s1", "j1", 0);
    expect(h.svc.snapshot().holders.map((j) => j.sessionId)).toEqual(["s1"]);
    expect(h.steers).toEqual([]);
    readable = true;
    await advance(h, 11_000);
    expect(h.svc.snapshot().holders.map((j) => j.sessionId)).toEqual(["s2"]);
  });

  test("session release frees its holders only, leaving queued and unknown sessions alone", async () => {
    const h = harness();
    await h.svc.start();
    await h.svc.acquire("s1", "x", null);
    await h.svc.acquire("s2", "y", null);
    expect(await h.svc.release("s2")).toBe(false);
    expect(await h.svc.release("unknown")).toBe(false);
    expect(await h.svc.release("s1")).toBe(true);
    expect(h.store.listHeavySlotJobs(["dropped"])).toMatchObject([
      { id: "j1", dropReason: "released" },
    ]);
    expect(h.steers.map(([id]) => id)).toEqual(["s2"]);
    expect(await h.svc.release("s1")).toBe(false);
    expect(await h.svc.release("s2")).toBe(true); // an unclaimed offer also reserves capacity
    expect(h.svc.snapshot().holders).toEqual([]);
  });

  test("public release awaits the session result, including asynchronous false", async () => {
    const released: string[] = [];
    const heavySlot = {
      snapshot: () => DISABLED_HEAVY_SLOT,
      release: async (id: string) => {
        await Promise.resolve();
        released.push(id);
        return id === "s1";
      },
    };
    const app = makeApp({ heavySlot } as unknown as AppDeps);
    const post = (sessionId: string) =>
      app.fetch(
        new Request("http://x/api/heavy-slot/release", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId }),
        }),
      );
    expect(await (await post("s1")).json()).toEqual({ released: true });
    expect((await post("s9")).status).toBe(404);
    expect(released).toEqual(["s1", "s9"]);
  });

  test("no service reports the existing disabled snapshot", async () => {
    const app = makeApp({} as AppDeps);
    const res = await app.fetch(new Request("http://x/api/heavy-slot"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DISABLED_HEAVY_SLOT);
  });
});

describe("operator holder (shepherd slot run, #3550)", () => {
  test("takes a free slot without a session and binds it like any job", async () => {
    const h = harness();
    await h.svc.start();
    expect(await h.svc.acquireOperator("cargo clippy", "/repo/cli")).toEqual({
      decision: "run",
      jobId: "j1",
    });
    expect(h.svc.snapshot().holders).toMatchObject([{ sessionId: "operator" }]);
    expect(await h.svc.finish("operator", "j1", 0)).toBe(true);
  });

  test("when the slot is taken it reports place and message but does not queue", async () => {
    const h = harness();
    await h.svc.start();
    await h.svc.acquire("s1", "bun run test", "/wt/s1");
    const out = await h.svc.acquireOperator("cargo clippy", "/repo");
    expect(out).toMatchObject({ decision: "queued", position: 1 });
    expect(h.svc.snapshot().waiters).toEqual([]);
    expect(h.store.listHeavySlotJobs(["dropped"])).toMatchObject([
      { sessionId: "operator", dropReason: "released" },
    ]);
    expect(h.steers).toEqual([]);
  });

  test("POST /api/heavy-slot/operator: ops, repo-scoped token 404, unavailable 503", async () => {
    const h = harness();
    await h.svc.start();
    const app = makeApp({ heavySlot: h.svc } as unknown as AppDeps);
    const post = (body: unknown) =>
      app.fetch(
        new Request("http://x/api/heavy-slot/operator", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const run = await post({ op: "acquire", command: "cargo clippy", cwd: "/repo" });
    expect(await run.json()).toEqual({ decision: "run", jobId: "j1" });
    const done = await post({ op: "finished", jobId: "j1", exitCode: 0 });
    expect(await done.json()).toEqual({ ok: true });
    expect((await post({ op: "nope" })).status).toBe(400);
    expect((await post({ op: "acquire" })).status).toBe(400);
    const bare = makeApp({} as unknown as AppDeps);
    const res = await bare.fetch(
      new Request("http://x/api/heavy-slot/operator", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "acquire", command: "x" }),
      }),
    );
    expect(res.status).toBe(503);
  });
});
