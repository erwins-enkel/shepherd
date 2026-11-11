import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { SessionStore } from "../src/store";
import { ScheduleService } from "../src/schedules";
import { validateScheduleInput, type ScheduleInput } from "../src/schedules-core";
import type { LaunchOutcome } from "../src/server";
import type { Session, StandardCreateInput } from "../src/types";

// Slots are server-local: pin the zone, restore after (test files share one process).
const prevTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Berlin";
});
afterAll(() => {
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
});

const root = mkdtempSync(join(tmpdir(), "sched-svc-"));
const repo = join(root, "aetherial");
mkdirSync(repo);
const WORKDAYS = 0b0011111;
const at = (mo: number, d: number, h: number, mi = 0) => new Date(2026, mo - 1, d, h, mi).getTime();

let store: SessionStore;
let now: number;
let launches: StandardCreateInput[];
let outcome: (input: StandardCreateInput) => LaunchOutcome;
let maintenance: boolean;
let svc: ScheduleService;

function spawnSession(input: StandardCreateInput): Session {
  return store.create({
    name: "triage",
    prompt: input.prompt,
    repoPath: input.repoPath,
    baseBranch: input.baseBranch,
    branch: null,
    worktreePath: input.repoPath,
    isolated: false,
    herdrSession: "h",
    herdrAgentId: "a",
    claudeSessionId: "c",
    model: null,
    scheduleId: input.scheduleId,
  });
}

beforeEach(() => {
  store = new SessionStore(":memory:");
  launches = [];
  maintenance = false;
  outcome = (input) => ({ kind: "spawned", session: spawnSession(input) });
  svc = new ScheduleService({
    readyProviders: async () => [],
    providerDefaults: () => ({ model: null, effort: null }),
    store,
    usageLimits: { limits: () => ({ session5h: null, week: null }) } as any,
    resolveProvider: (s) => s.launch.agentProvider ?? "claude",
    launch: async (input) => {
      launches.push(input);
      return outcome(input);
    },
    defaultBranch: async () => "main",
    repoRoot: () => root,
    maintenanceActive: () => maintenance,
    events: { emit() {} },
    now: () => now,
    log: () => {},
  });
});

function makeSchedule(createdAt: number, patch: Partial<ScheduleInput> = {}) {
  const v = validateScheduleInput(
    {
      repoPath: repo,
      name: "Triage",
      prompt: "/triage-feedback",
      days: WORKDAYS,
      times: ["09:00", "18:00"],
    },
    root,
  );
  if (!v.ok) throw new Error(v.error);
  return store.insertSchedule({ ...v.value, ...patch }, createdAt);
}

const archiveAll = () => {
  for (const s of store.list()) store.archive(s.id);
};

async function runDay(fromMs: number, toMs: number, archiveBetween = true) {
  for (now = fromMs; now <= toMs; now += 60_000) {
    await svc.tick();
    if (archiveBetween) archiveAll();
  }
}

describe("ScheduleService", () => {
  test("fires once per workday slot, never Sat/Sun", async () => {
    // Mon 2026-10-26 00:00 → Sun 2026-11-01 23:59, created just before.
    makeSchedule(at(10, 25, 23));
    await runDay(at(10, 26, 0), at(11, 1, 23, 59));
    expect(launches.length).toBe(10);
    expect(launches.every((l) => l.prompt === "/triage-feedback" && l.baseBranch === "main")).toBe(
      true,
    );
    expect(launches[0]!.autopilotEnabled).toBe(false);
  });

  test("session carries scheduleId + name and launch metadata says scheduled", async () => {
    const s = makeSchedule(at(10, 26, 8));
    now = at(10, 26, 9, 0);
    await svc.tick();
    const [session] = store.list();
    expect(session!.scheduleId).toBe(s.id);
    expect(store.get(session!.id)!.scheduleName).toBe("Triage");
  });

  test("restart across one slot ⇒ exactly one catch-up", async () => {
    makeSchedule(at(10, 26, 8));
    now = at(10, 26, 10, 30); // down 08:30–10:30 across 09:00
    await svc.tick();
    await svc.tick();
    expect(launches.length).toBe(1);
    expect(store.listScheduleRuns(store.listSchedules()[0]!.id, 10)[0]!.slotKey).toBe(
      "2026-10-26T09:00",
    );
  });

  test("down across two slots ⇒ only the newer fires", async () => {
    const s = makeSchedule(at(10, 26, 8));
    now = at(10, 26, 19); // missed 09:00 and 18:00
    await svc.tick();
    expect(launches.length).toBe(1);
    const runs = store.listScheduleRuns(s.id, 10);
    expect(runs.map((r) => r.slotKey)).toEqual(["2026-10-26T18:00"]);
  });

  test("missed slot older than 12h ⇒ skipped:stale, no spawn", async () => {
    const s = makeSchedule(at(10, 23, 8)); // Fri
    now = at(10, 26, 8); // Mon 08:00: latest due = Fri 18:00
    await svc.tick();
    expect(launches.length).toBe(0);
    expect(store.listScheduleRuns(s.id, 1)[0]).toMatchObject({
      slotKey: "2026-10-23T18:00",
      outcome: "skipped:stale",
    });
    now = at(10, 26, 9);
    await svc.tick();
    expect(launches.length).toBe(1);
  });

  test("previous run still open ⇒ skipped:overlap, no launch", async () => {
    const s = makeSchedule(at(10, 26, 8));
    now = at(10, 26, 9);
    await svc.tick();
    now = at(10, 26, 18);
    await svc.tick();
    expect(launches.length).toBe(1);
    expect(store.getScheduleRun(s.id, "2026-10-26T18:00")?.outcome).toBe("skipped:overlap");
  });

  test("a usage-paused previous run counts as open", async () => {
    const s = makeSchedule(at(10, 26, 8));
    now = at(10, 26, 9);
    await svc.tick();
    const run = store.listScheduleRuns(s.id, 1)[0]!;
    store.setUsagePause(run.sessionId!, {
      phase: "paused",
      since: now,
      resumeAt: now + 86400000,
      stopPct: 80,
      windows: ["week"],
      stopSteerSent: false,
    });
    now = at(10, 26, 18);
    await svc.tick();
    expect(launches).toHaveLength(1);
    expect(store.listScheduleRuns(s.id, 1)[0]?.outcome).toBe("skipped:overlap");
  });

  test("a held previous run counts as open", async () => {
    const s = makeSchedule(at(10, 26, 8));
    store.addHeldTask({
      id: "h1",
      repoPath: repo,
      input: {
        repoPath: repo,
        baseBranch: "main",
        prompt: "x",
        model: null,
        images: [],
        scheduleId: s.id,
      },
      createdAt: now,
      reason: "usage",
    });
    now = at(10, 26, 9);
    await svc.tick();
    expect(launches.length).toBe(0);
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")?.outcome).toBe("skipped:overlap");
  });

  test("a crash between claim and spawn never re-fires the slot", async () => {
    const s = makeSchedule(at(10, 26, 8));
    store.claimScheduleRun(s.id, "2026-10-26T09:00", at(10, 26, 9)); // claimed, then crashed
    now = at(10, 26, 9, 5);
    await svc.tick();
    expect(launches.length).toBe(0);
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")?.outcome).toBe("claimed");
  });

  test("usage hold ⇒ held outcome", async () => {
    const s = makeSchedule(at(10, 26, 8));
    outcome = () => ({ kind: "held", held: { id: "h", count: 1, reason: "usage" } });
    now = at(10, 26, 9);
    await svc.tick();
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")).toMatchObject({
      outcome: "held",
      reason: "usage",
    });
    expect(launches[0]!.scheduleId).toBe(s.id);
  });

  test("launch failure ⇒ error outcome with reason", async () => {
    const s = makeSchedule(at(10, 26, 8));
    outcome = () => ({ kind: "error", error: new Error("herdr down") });
    now = at(10, 26, 9);
    await svc.tick();
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")).toMatchObject({
      outcome: "error",
      reason: "herdr down",
    });
  });

  test("created mid-day ⇒ earlier slot never fires", async () => {
    makeSchedule(at(10, 26, 14));
    now = at(10, 26, 14, 1);
    await svc.tick();
    expect(launches.length).toBe(0);
    now = at(10, 26, 18);
    await svc.tick();
    expect(launches.length).toBe(1);
  });

  test("re-enabled mid-day (re-baselined) ⇒ earlier slot never fires", async () => {
    const s = makeSchedule(at(10, 20, 8), { enabled: false });
    store.updateSchedule(s.id, { ...s, enabled: true }, at(10, 26, 14), true);
    now = at(10, 26, 14, 1);
    await svc.tick();
    expect(launches.length).toBe(0);
  });

  test("disabled schedule is not evaluated", async () => {
    makeSchedule(at(10, 26, 8), { enabled: false });
    now = at(10, 26, 9);
    await svc.tick();
    expect(launches.length).toBe(0);
  });

  test("maintenance skips the tick; the slot is caught up after", async () => {
    makeSchedule(at(10, 26, 8));
    maintenance = true;
    now = at(10, 26, 9);
    await svc.tick();
    expect(launches.length).toBe(0);
    maintenance = false;
    now = at(10, 26, 9, 10);
    await svc.tick();
    expect(launches.length).toBe(1);
  });

  test("run now spawns, and is overlap-skipped while that run is open", async () => {
    const s = makeSchedule(at(10, 26, 8), { enabled: false });
    now = at(10, 26, 12);
    expect((await svc.runNow(s.id))?.outcome).toBe("spawned");
    now += 1000;
    expect((await svc.runNow(s.id))?.outcome).toBe("skipped:overlap");
    expect(await svc.runNow("nope")).toBeNull();
  });

  test("markScheduleRunNoop marks the run that spawned the session; next slot then fires", async () => {
    const s = makeSchedule(at(10, 26, 8));
    now = at(10, 26, 9);
    await svc.tick();
    const [session] = store.list();
    expect(store.markScheduleRunNoop(session!.id, s.id, "0 open feedback items")).toBe(true);
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")).toMatchObject({
      outcome: "noop",
      reason: "0 open feedback items",
      sessionId: session!.id,
    });
    store.archive(session!.id, "noop");
    expect(store.get(session!.id)!.archiveReason).toBe("noop");
    now = at(10, 26, 18);
    await svc.tick();
    expect(launches.length).toBe(2);
    expect(store.getScheduleRun(s.id, "2026-10-26T18:00")?.outcome).toBe("spawned");
  });

  test("markScheduleRunNoop falls back to the latest held run and stamps the session", async () => {
    const s = makeSchedule(at(10, 26, 8));
    outcome = () => ({ kind: "held", held: { id: "h", count: 1, reason: "usage" } });
    now = at(10, 26, 9);
    await svc.tick();
    expect(store.markScheduleRunNoop("sess-1", s.id, "nothing")).toBe(true);
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")).toMatchObject({
      outcome: "noop",
      reason: "nothing",
      sessionId: "sess-1",
    });
    expect(store.markScheduleRunNoop("sess-2", s.id, "nothing")).toBe(false);
  });

  test("held fallback ignores an older held run once a newer firing exists", async () => {
    const s = makeSchedule(at(10, 26, 8));
    store.claimScheduleRun(s.id, "2026-10-26T09:00", at(10, 26, 9));
    store.settleScheduleRun(s.id, "2026-10-26T09:00", "held", { reason: "usage" });
    store.claimScheduleRun(s.id, "2026-10-26T18:00", at(10, 26, 18));
    store.settleScheduleRun(s.id, "2026-10-26T18:00", "spawned", { sessionId: "other" });
    expect(store.markScheduleRunNoop("relaunched", s.id, "nothing")).toBe(false);
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")?.outcome).toBe("held");
  });

  test("held fallback looks past overlap skips to the latest firing", async () => {
    const s = makeSchedule(at(10, 26, 8));
    store.claimScheduleRun(s.id, "2026-10-26T09:00", at(10, 26, 9));
    store.settleScheduleRun(s.id, "2026-10-26T09:00", "held", { reason: "usage" });
    store.claimScheduleRun(s.id, "2026-10-26T18:00", at(10, 26, 18));
    store.settleScheduleRun(s.id, "2026-10-26T18:00", "skipped:overlap");
    expect(store.markScheduleRunNoop("sess", s.id, "nothing")).toBe(true);
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")?.outcome).toBe("noop");
  });

  test("a repeat call re-marks the same run; a relaunch re-points it", async () => {
    const s = makeSchedule(at(10, 26, 8));
    store.claimScheduleRun(s.id, "2026-10-26T09:00", at(10, 26, 9));
    store.settleScheduleRun(s.id, "2026-10-26T09:00", "spawned", { sessionId: "orig" });
    store.repointScheduleRun("orig", "fresh");
    expect(store.markScheduleRunNoop("orig", s.id, "x")).toBe(false);
    expect(store.markScheduleRunNoop("fresh", s.id, "first")).toBe(true);
    expect(store.markScheduleRunNoop("fresh", s.id, "second")).toBe(true);
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")).toMatchObject({
      outcome: "noop",
      reason: "second",
      sessionId: "fresh",
    });
  });
});

describe("interval schedules", () => {
  const interval = { everyMinutes: 15 as const, from: "08:00", until: "18:00" };
  test("fires forty window slots, catches up once and records interval staleness", async () => {
    const s = makeSchedule(at(10, 25, 23), { times: [], interval });
    await runDay(at(10, 26, 0), at(10, 26, 23, 59));
    expect(launches).toHaveLength(40);
    expect(store.listScheduleRuns(s.id, 100).filter((r) => r.outcome === "spawned")).toHaveLength(
      40,
    );
    now = at(10, 27, 12, 7);
    await svc.tick();
    archiveAll();
    await svc.tick();
    expect(launches).toHaveLength(41);
    now = at(10, 27, 20);
    await svc.tick();
    const last = store.listScheduleRuns(s.id, 1)[0];
    expect(last).toMatchObject({
      slotKey: "2026-10-27T17:45",
      outcome: "skipped:stale",
      reason: "missed by more than one interval",
    });
    expect(launches).toHaveLength(41);
  });
  test.each([
    [3, 29, 92],
    [10, 25, 96],
  ])("service deduplicates DST %i/%i", async (mo, day, count) => {
    const s = makeSchedule(at(mo, day, 0) - 1, {
      days: 127,
      times: [],
      interval: { everyMinutes: 15, from: null, until: null },
    });
    await runDay(at(mo, day, 0), at(mo, day + 1, 0) - 60_000);
    expect(launches).toHaveLength(count);
    const rows = store.listScheduleRuns(s.id, 300);
    expect(rows).toHaveLength(count);
    expect(new Set(rows.map((r) => r.slotKey)).size).toBe(count);
  });
  test("interval overlap retains claim-before-launch", async () => {
    const s = makeSchedule(at(10, 26, 7), { times: [], interval });
    now = at(10, 26, 8);
    await svc.tick();
    now = at(10, 26, 8, 15);
    await svc.tick();
    expect(launches).toHaveLength(1);
    expect(store.listScheduleRuns(s.id, 1)[0]!.outcome).toBe("skipped:overlap");
  });
});

test("legacy database migration and interval roundtrip retain baseline and indexed history", () => {
  const path = join(root, "legacy.sqlite");
  const db = new Database(path);
  db.run(`CREATE TABLE schedules (id TEXT PRIMARY KEY, repoPath TEXT NOT NULL, name TEXT NOT NULL,
    prompt TEXT NOT NULL, days INTEGER NOT NULL, timesJson TEXT NOT NULL, enabled INTEGER NOT NULL,
    launchJson TEXT NOT NULL, baselineAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
  const input = makeSchedule(100);
  db.run(`INSERT INTO schedules VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    "legacy",
    repo,
    "Old",
    "hello",
    31,
    '["09:00"]',
    1,
    JSON.stringify(input.launch),
    100,
    100,
    100,
  ]);
  const migrated = new SessionStore(path);
  expect(migrated.getSchedule("legacy")).toMatchObject({
    times: ["09:00"],
    interval: null,
    usageLimit: null,
    baselineAt: 100,
  });
  const interval = { everyMinutes: 15 as const, from: null, until: null };
  migrated.updateSchedule("legacy", { ...input, times: [], interval }, 200, true);
  const reopened = new SessionStore(path);
  expect(reopened.getSchedule("legacy")).toMatchObject({ interval, baselineAt: 200 });
  for (const [key, timestamp] of [
    ["a", 1],
    ["b", 2],
    ["c", 2],
  ] as const)
    reopened.claimScheduleRun("legacy", key, timestamp);
  expect(reopened.listScheduleRuns("legacy", 2).map((r) => r.slotKey)).toEqual(["c", "b"]);
  reopened.pruneScheduleRuns(2);
  expect(reopened.listScheduleRuns("legacy", 10).map((r) => r.slotKey)).toEqual(["c", "b"]);
  const plan = db
    .query(
      "EXPLAIN QUERY PLAN SELECT * FROM schedule_runs WHERE scheduleId = ? ORDER BY at DESC, id DESC LIMIT ?",
    )
    .all("legacy", 2);
  expect(JSON.stringify(plan)).toContain("schedule_runs_history");
  expect(
    JSON.stringify(db.query("EXPLAIN QUERY PLAN DELETE FROM schedule_runs WHERE at < ?").all(2)),
  ).toContain("schedule_runs_at");
  db.close();
});

test("run usage snapshots survive settlement, schedule edits and noop", () => {
  const s = makeSchedule(at(10, 26, 8));
  const usage = { provider: "claude", window: "week", usedPct: 80, thresholdPct: 80 } as const;
  store.claimScheduleRun(s.id, "slot", 1);
  store.settleScheduleRun(s.id, "slot", "claimed", { usage });
  store.settleScheduleRun(s.id, "slot", "spawned", { sessionId: "s" });
  store.updateSchedule(s.id, { ...s, usageLimit: { kind: "upTo", stopPct: 50 } }, 2, false);
  expect(store.getScheduleRun(s.id, "slot")?.usage).toEqual(usage);
  expect(store.listScheduleRuns(s.id, 1)[0]?.usage).toEqual(usage);
  store.markScheduleRunNoop("s", s.id, "done");
  expect(store.getScheduleRun(s.id, "slot")).toMatchObject({ outcome: "noop", usage });
  store.settleScheduleRun(s.id, "slot", "error", { usage: null });
  expect(store.getScheduleRun(s.id, "slot")?.usage).toBeNull();
});

test("automatic limits skip once, snapshot the decision and pin the provider; run now ignores them", async () => {
  let provider: "claude" | "codex" = "claude";
  let pct = 79;
  const options: unknown[] = [];
  svc = new ScheduleService({
    readyProviders: async () => [],
    providerDefaults: () => ({ model: null, effort: null }),
    store,
    launch: async (input, opts) => {
      launches.push(input);
      options.push(opts);
      return outcome(input);
    },
    usageLimits: { limits: () => ({ session5h: null, week: { pct, resetAt: 1 } }) } as any,
    resolveProvider: (s) => s.launch.agentProvider ?? provider,
    defaultBranch: async () => {
      provider = "codex";
      return "main";
    },
    repoRoot: () => root,
    maintenanceActive: () => false,
    events: { emit() {} },
    now: () => now,
    log() {},
  });
  const s = makeSchedule(at(10, 26, 8), {
    usageLimit: { kind: "from", startPct: 80, startWindow: "week", stopPct: 95 },
  });
  now = at(10, 26, 9);
  await svc.tick();
  expect(launches).toHaveLength(0);
  expect(store.listScheduleRuns(s.id, 1)[0]).toMatchObject({
    outcome: "skipped:limit",
    reason: "below-start",
    usage: { provider: "claude", window: "week", usedPct: 79, thresholdPct: 80 },
  });
  pct = 80;
  await svc.tick();
  expect(launches).toHaveLength(0);
  now = at(10, 26, 18);
  await svc.tick();
  expect(launches[0]?.agentProvider).toBe("claude");
  expect(options[0]).toEqual({ skipUsageHold: true });
  expect(store.listScheduleRuns(s.id, 1)[0]).toMatchObject({
    outcome: "spawned",
    usage: { usedPct: 80 },
  });
  archiveAll();
  pct = 99;
  const manual = await svc.runNow(s.id);
  expect(manual).toMatchObject({ outcome: "spawned", usage: null });
  expect((options[1] as { skipUsageHold?: boolean })?.skipUsageHold).not.toBe(true);
});

test("allowed limits retain their snapshot when launch is held or throws", async () => {
  for (const throwing of [false, true]) {
    const s = makeSchedule(at(10, 26, 8), { usageLimit: { kind: "upTo", stopPct: 70 } });
    const service = new ScheduleService({
      readyProviders: async () => [],
      providerDefaults: () => ({ model: null, effort: null }),
      store,
      launch: async () => {
        if (throwing) throw new Error("spawn failed");
        return { kind: "held", held: { id: "held", reason: "memory" } } as LaunchOutcome;
      },
      usageLimits: { limits: () => ({ session5h: null, week: { pct: 60, resetAt: 1 } }) } as any,
      resolveProvider: () => "claude",
      defaultBranch: async () => "main",
      repoRoot: () => root,
      maintenanceActive: () => false,
      events: { emit() {} },
      now: () => now,
      log() {},
    });
    now = at(10, 26, 9);
    await service.tick();
    expect(store.listScheduleRuns(s.id, 1)[0]).toMatchObject({
      outcome: throwing ? "error" : "held",
      usage: { provider: "claude", window: "max", usedPct: 60, thresholdPct: 70 },
    });
  }
});

test("waiting rows expire atomically on disable or cadence edits and disappear on delete", () => {
  for (const change of ["disabled", "cadence-changed", "delete"] as const) {
    const s = makeSchedule(at(10, 26, 8));
    store.claimScheduleRun(s.id, "2026-10-26T09:00", at(10, 26, 9));
    store.settleScheduleRun(s.id, "2026-10-26T09:00", "waiting:limit");
    expect(store.listWaitingScheduleRuns(s.id)).toHaveLength(1);
    if (change === "delete") store.deleteSchedule(s.id);
    else {
      store.updateSchedule(
        s.id,
        { ...s, enabled: change !== "disabled" },
        at(10, 26, 10),
        change === "cadence-changed",
      );
      expect(store.getScheduleRun(s.id, "2026-10-26T09:00")).toMatchObject({
        outcome: "skipped:limit-expired",
        reason: change,
      });
    }
    expect(store.listWaitingScheduleRuns(s.id)).toHaveLength(0);
  }
});

test("failover runs follow replacement sessions and can become noop", () => {
  const s = makeSchedule(at(10, 26, 8));
  const usage = { provider: "codex", window: "max", usedPct: 40, thresholdPct: 70 } as const;
  store.claimScheduleRun(s.id, "slot", 1);
  store.settleScheduleRun(s.id, "slot", "spawned:failover", { sessionId: "original", usage });
  store.repointScheduleRun("original", "replacement");
  expect(store.markScheduleRunNoop("replacement", s.id, "done")).toBe(true);
  expect(store.getScheduleRun(s.id, "slot")).toMatchObject({
    outcome: "noop",
    sessionId: "replacement",
    usage,
  });
});

describe("usage mismatch actions", () => {
  let pct: number | null;
  let otherPct: number | null;
  let ready: ("claude" | "codex")[];
  let selected: "claude" | "codex";
  let changed: number;
  let readReady: () => Promise<readonly ("claude" | "codex")[]>;
  let resolveBase: () => Promise<string | null>;
  const service = () =>
    new ScheduleService({
      store,
      usageLimits: {
        limits: () => ({
          week: pct === null ? null : { pct, resetAt: 1 },
          session5h: null,
          providers: [
            {
              provider: "codex",
              kind: "tokens",
              week: otherPct === null ? null : { pct: otherPct, resetAt: 1 },
              session5h: null,
            },
          ],
        }),
      } as any,
      resolveProvider: (s) => s.launch.agentProvider ?? selected,
      readyProviders: () => readReady(),
      providerDefaults: (provider) => ({
        model: provider === "codex" ? "gpt-5.4" : "opus",
        effort: "high",
      }),
      launch: async (input) => {
        launches.push(input);
        return outcome(input);
      },
      defaultBranch: () => resolveBase(),
      repoRoot: () => root,
      maintenanceActive: () => maintenance,
      events: {
        emit() {
          changed++;
        },
      },
      now: () => now,
      log() {},
    });
  const make = (onMismatch: "wait" | "otherProvider" = "wait", times = ["09:00"]) =>
    makeSchedule(at(10, 26, 8), {
      times,
      usageLimit: { kind: "from", startPct: 80, startWindow: "week", stopPct: 95, onMismatch },
    });
  beforeEach(() => {
    pct = 79;
    otherPct = 85;
    ready = ["claude", "codex"];
    selected = "claude";
    changed = 0;
    readReady = async () => ready;
    resolveBase = async () => "main";
    svc = service();
    now = at(10, 26, 9);
  });

  test("wait resumes the same row once with an updated snapshot", async () => {
    const s = make();
    await svc.tick();
    const run = store.listScheduleRuns(s.id, 1)[0]!;
    expect(run).toMatchObject({ outcome: "waiting:limit", usage: { usedPct: 79 } });
    pct = 78;
    now += 60_000;
    await svc.tick();
    expect(store.getScheduleRun(s.id, run.slotKey)?.usage?.usedPct).toBe(78);
    pct = 80;
    now += 60_000;
    await Promise.all([svc.tick(), svc.tick()]);
    expect(launches).toHaveLength(1);
    expect(store.listScheduleRuns(s.id, 10)).toHaveLength(1);
    expect(store.getScheduleRun(s.id, run.slotKey)).toMatchObject({
      id: run.id,
      outcome: "spawned",
      usage: { usedPct: 80 },
    });
    expect(changed).toBeGreaterThanOrEqual(3);
  });

  test("waiting survives a database reopen and service restart", async () => {
    const path = join(root, `restart-${Date.now()}.sqlite`);
    store = new SessionStore(path);
    svc = service();
    const s = make();
    await svc.tick();
    // Reopen the same database; no in-memory pending state may be needed.
    store["db"].close();
    store = new SessionStore(path);
    svc = service();
    pct = 80;
    now += 60_000;
    await svc.tick();
    expect(store.listScheduleRuns(s.id, 1)[0]?.outcome).toBe("spawned");
    expect(launches).toHaveLength(1);
    store["db"].close();
  });

  test("12h deadline uses nominal time even when first checked late", async () => {
    const s = make();
    now = at(10, 26, 10);
    await svc.tick();
    pct = 80;
    now = at(10, 26, 21);
    await svc.tick();
    expect(store.listScheduleRuns(s.id, 1)[0]?.outcome).toBe("skipped:limit-expired");
    expect(launches).toHaveLength(0);
  });

  test("next fixed slot expires the old wait before evaluating the new slot", async () => {
    const s = make("wait", ["09:00", "10:00"]);
    await svc.tick();
    pct = 80;
    now = at(10, 26, 10);
    await svc.tick();
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")?.outcome).toBe("skipped:limit-expired");
    expect(store.getScheduleRun(s.id, "2026-10-26T10:00")?.outcome).toBe("spawned");
    expect(launches).toHaveLength(1);
  });

  test("interval waits never accumulate across skipped ticks or maintenance", async () => {
    const s = makeSchedule(at(10, 26, 8), {
      times: [],
      interval: { everyMinutes: 15, from: null, until: null },
      usageLimit: { kind: "upTo", stopPct: 70, onMismatch: "wait" },
    });
    pct = 80;
    await svc.tick();
    maintenance = true;
    now += 45 * 60_000;
    await svc.tick();
    expect(store.listWaitingScheduleRuns(s.id)).toHaveLength(1);
    maintenance = false;
    await svc.tick();
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")?.outcome).toBe("skipped:limit-expired");
    expect(store.listWaitingScheduleRuns(s.id)).toHaveLength(1);
    expect(store.listWaitingScheduleRuns(s.id)[0]?.slotKey).toBe("2026-10-26T09:45");
  });

  test("disable then enable does not revive an old wait", async () => {
    const s = make();
    await svc.tick();
    store.updateSchedule(s.id, { ...s, enabled: false }, now, false);
    store.updateSchedule(s.id, s, now + 1, true);
    pct = 80;
    now += 60_000;
    await svc.tick();
    expect(launches).toHaveLength(0);
    expect(store.listScheduleRuns(s.id, 1)[0]).toMatchObject({
      outcome: "skipped:limit-expired",
      reason: "disabled",
    });
  });

  test("edited and removed limits apply to a waiting row", async () => {
    for (const action of ["skip", "otherProvider", "remove", "threshold"] as const) {
      const s = make();
      await svc.tick();
      store.updateSchedule(
        s.id,
        {
          ...s,
          usageLimit:
            action === "remove"
              ? null
              : action === "threshold"
                ? { kind: "upTo", stopPct: 90, onMismatch: "wait" }
                : { ...s.usageLimit!, onMismatch: action },
        },
        now,
        false,
      );
      now += 60_000;
      await svc.tick();
      expect(store.listScheduleRuns(s.id, 1)[0]?.outcome).toBe(
        action === "skip"
          ? "skipped:limit"
          : action === "otherProvider"
            ? "spawned:failover"
            : "spawned",
      );
      archiveAll();
      store.deleteSchedule(s.id);
    }
  });

  test("waiting is not open, but an open manual run blocks a released wait", async () => {
    const s = make();
    await svc.tick();
    expect((await svc.runNow(s.id))?.outcome).toBe("spawned");
    pct = 80;
    now += 60_000;
    await svc.tick();
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")?.outcome).toBe("skipped:overlap");
    expect(launches).toHaveLength(1);
  });

  test("released waits preserve capacity holds and errors", async () => {
    for (const result of ["memory", "capacity", "error"] as const) {
      const s = make();
      await svc.tick();
      pct = 80;
      outcome = () =>
        result === "error"
          ? { kind: "error", error: new Error("failed") }
          : { kind: "held", held: { id: "h", count: 1, reason: result } };
      now += 60_000;
      await svc.tick();
      expect(store.listScheduleRuns(s.id, 1)[0]).toMatchObject({
        outcome: result === "error" ? "error" : "held",
        usage: { usedPct: 80 },
      });
      pct = 79;
      store.deleteSchedule(s.id);
    }
  });

  test("failover in both directions uses target defaults and preserves other launch options", async () => {
    for (const provider of ["claude", "codex"] as const) {
      selected = provider;
      pct = provider === "claude" ? 79 : 85;
      otherPct = provider === "claude" ? 85 : 79;
      const s = make("otherProvider");
      store.updateSchedule(
        s.id,
        {
          ...s,
          launch: {
            ...s.launch,
            agentProvider: provider,
            model: provider === "claude" ? "sonnet" : "gpt-5.4",
            effort: "low",
            autopilotEnabled: true,
            planGateEnabled: false,
            research: true,
            sandboxProfile: "standard",
            baseBranch: "develop",
          },
        },
        now,
        false,
      );
      await svc.tick();
      const target = provider === "claude" ? "codex" : "claude";
      expect(launches.at(-1)).toMatchObject({
        agentProvider: target,
        model: target === "codex" ? "gpt-5.4" : "opus",
        effort: "high",
        autopilotEnabled: true,
        planGateEnabled: false,
        research: true,
        baseBranch: "develop",
      });
      expect(store.listScheduleRuns(s.id, 1)[0]).toMatchObject({
        outcome: "spawned:failover",
        usage: { provider: target, usedPct: 85 },
      });
      expect(store.getSchedule(s.id)?.launch.agentProvider).toBe(provider);
      archiveAll();
      store.deleteSchedule(s.id);
    }
  });

  test("failover requires readiness and the same start and stop bounds", async () => {
    for (const [providers, targetPct] of [
      [[], 85],
      [["claude"], 85],
      [["claude", "codex"], 79],
      [["claude", "codex"], 95],
      [["claude", "codex"], null],
    ] as const) {
      ready = [...providers];
      otherPct = targetPct;
      const s = make("otherProvider");
      await svc.tick();
      expect(store.listScheduleRuns(s.id, 1)[0]).toMatchObject({
        outcome: "skipped:limit",
        reason: "below-start",
        usage: { provider: "claude", usedPct: 79 },
      });
      expect(launches).toHaveLength(0);
      store.deleteSchedule(s.id);
    }
  });

  test("a manual launch in flight blocks a released wait without losing its flight guard", async () => {
    const s = make();
    await svc.tick();
    let finish!: (base: string) => void;
    resolveBase = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const manual = svc.runNow(s.id);
    pct = 80;
    now += 60_000;
    await svc.tick();
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")?.outcome).toBe("skipped:overlap");
    expect((await svc.runNow(s.id))?.outcome).toBe("skipped:overlap");
    finish("main");
    await manual;
    expect(launches).toHaveLength(1);
  });

  test("disabling or expiry during an awaited readiness check cannot launch an old wait", async () => {
    for (const action of ["disable", "expire"] as const) {
      const s = make();
      await svc.tick();
      store.updateSchedule(
        s.id,
        { ...s, usageLimit: { ...s.usageLimit!, onMismatch: "otherProvider" } },
        now,
        false,
      );
      let finish!: (providers: readonly ("claude" | "codex")[]) => void;
      readReady = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      const tick = svc.tick();
      if (action === "disable") store.updateSchedule(s.id, { ...s, enabled: false }, now, false);
      else now = at(10, 26, 21);
      finish(["claude", "codex"]);
      await tick;
      expect(store.getScheduleRun(s.id, "2026-10-26T09:00")?.outcome).toBe("skipped:limit-expired");
      expect(launches).toHaveLength(0);
      store.deleteSchedule(s.id);
      now = at(10, 26, 9);
    }
  });

  test("primary success never switches; held failover keeps target snapshot", async () => {
    const s = make("otherProvider");
    pct = 80;
    await svc.tick();
    expect(launches[0]?.agentProvider).toBe("claude");
    expect(store.listScheduleRuns(s.id, 1)[0]?.outcome).toBe("spawned");
    archiveAll();
    store.deleteSchedule(s.id);
    pct = 79;
    const other = make("otherProvider");
    outcome = () => ({ kind: "held", held: { id: "h", count: 1, reason: "capacity" } });
    await svc.tick();
    expect(store.listScheduleRuns(other.id, 1)[0]).toMatchObject({
      outcome: "held",
      usage: { provider: "codex" },
    });
  });
});

test("a newer waiting run prevents noop from attaching an older held run", () => {
  const s = makeSchedule(at(10, 26, 8));
  store.claimScheduleRun(s.id, "2026-10-26T09:00", 1);
  store.settleScheduleRun(s.id, "2026-10-26T09:00", "held");
  store.claimScheduleRun(s.id, "2026-10-26T18:00", 2);
  store.settleScheduleRun(s.id, "2026-10-26T18:00", "waiting:limit");
  expect(store.markScheduleRunNoop("released", s.id, "done")).toBe(false);
  expect(store.getScheduleRun(s.id, "2026-10-26T09:00")?.outcome).toBe("held");
});

test("manual runs freeze their budget and stopped sessions allow the next firing", async () => {
  const schedule = makeSchedule(at(10, 26, 8), { tokenBudget: 100_000 });
  now = at(10, 26, 9);
  const run = await svc.runNow(schedule.id);
  expect(run?.outcome).toBe("spawned");
  expect(launches[0]?.scheduleRun).toEqual({ slotKey: run!.slotKey, tokenBudget: 100_000 });
  expect(store.scheduleBudget(run!.sessionId!)?.tokenBudget).toBe(100_000);
  store.setUsagePause(run!.sessionId!, {
    reason: "budget",
    tokenBudget: 100_000,
    tokensUsed: 100_001,
    phase: "paused",
    since: now,
    resumeAt: null,
    stopPct: 0,
    windows: [],
    stopSteerSent: true,
  });
  store.setUsagePause(run!.sessionId!, null, true);
  await svc.tick();
  expect(launches).toHaveLength(2);
  expect(store.getScheduleRun(schedule.id, run!.slotKey)).toMatchObject({
    outcome: "stopped:budget",
    tokensUsed: 100_001,
  });
});

test("a default-provider Codex spawn records that its budget did not apply", async () => {
  const schedule = makeSchedule(at(10, 26, 8), { tokenBudget: 100_000 });
  outcome = (input) => {
    const session = spawnSession(input);
    store.update(session.id, { agentProvider: "codex" });
    return { kind: "spawned", session: store.get(session.id)! };
  };
  now = at(10, 26, 9);
  await svc.tick();
  const run = store.listScheduleRuns(schedule.id, 1)[0]!;
  expect(run).toMatchObject({ outcome: "spawned", budgetNotApplied: "codex", tokensUsed: null });
  expect(store.scheduleBudget(run.sessionId!)).toBeNull();
});
