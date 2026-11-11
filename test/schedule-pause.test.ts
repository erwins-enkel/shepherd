import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import type { UsagePause } from "../src/types";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function session(store: SessionStore) {
  return store.create({
    name: "run",
    prompt: "work",
    repoPath: "/repo",
    baseBranch: "main",
    branch: null,
    worktreePath: "/repo",
    isolated: false,
    herdrSession: "h",
    herdrAgentId: "a",
    claudeSessionId: "c",
    model: null,
  });
}
const pause: UsagePause = {
  phase: "requested",
  since: 100,
  resumeAt: 200,
  stopPct: 80,
  windows: ["week"],
  stopSteerSent: false,
};

test("requested and active pauses survive reopening; operator override is durable", () => {
  const dir = mkdtempSync(join(tmpdir(), "schedule-pause-"));
  dirs.push(dir);
  const path = join(dir, "state.db");
  const store = new SessionStore(path);
  const s = session(store);
  expect(store.get(s.id)?.usagePause).toBeNull();
  store.setUsagePause(s.id, pause);
  const reopened = new SessionStore(path);
  expect(reopened.get(s.id)?.usagePause).toEqual(pause);
  reopened.setUsagePause(s.id, { ...pause, phase: "paused" });
  expect(new SessionStore(path).get(s.id)?.usagePause?.phase).toBe("paused");
  reopened.setUsagePause(s.id, null, true);
  const again = new SessionStore(path);
  expect(again.get(s.id)?.usagePause).toBeNull();
  expect(again.usagePauseOptedOut(s.id)).toBe(true);
});

test("archive clears a pause without resuming its historical run", () => {
  const store = new SessionStore(":memory:");
  const s = session(store);
  store.claimScheduleRun("schedule", "slot", 1);
  store.settleScheduleRun("schedule", "slot", "spawned", { sessionId: s.id });
  store.setUsagePause(s.id, { ...pause, phase: "paused" });
  expect(store.getScheduleRun("schedule", "slot")).toMatchObject({
    outcome: "paused",
    pausedUntil: 200,
    sessionId: s.id,
    at: 1,
  });
  store.archive(s.id);
  expect(store.get(s.id)?.usagePause).toBeNull();
  expect(store.getScheduleRun("schedule", "slot")).toMatchObject({
    outcome: "paused",
    pausedUntil: null,
  });
});

import { SchedulePauseService } from "../src/schedule-pause";
import { DEFAULT_LAUNCH } from "../src/schedules-core";
import type { AgentProvider } from "../src/types";
import type { UsageLimits } from "../src/usage-limits";

function harness(provider: AgentProvider = "claude", pauseAtStop = true) {
  const store = new SessionStore(":memory:");
  const schedule = store.insertSchedule(
    {
      repoPath: "/repo",
      name: "run",
      prompt: "work",
      days: 127,
      times: ["09:00"],
      interval: null,
      enabled: true,
      launch: DEFAULT_LAUNCH,
      usageLimit: { kind: "upTo", stopPct: 80, pauseAtStop },
    },
    0,
  );
  const s = store.create({ ...sessionInput(), agentProvider: provider, scheduleId: schedule.id });
  store.update(s.id, { status: "running" });
  store.claimScheduleRun(schedule.id, "slot", 0);
  store.settleScheduleRun(schedule.id, "slot", "spawned", { sessionId: s.id });
  let now = 100;
  let limits = {
    week: { pct: 80, resetAt: 200 },
    session5h: { pct: 20, resetAt: 150 },
    stale: false,
    providers: [
      {
        provider: "codex",
        week: { pct: 30, resetAt: 300 },
        session5h: { pct: 90, resetAt: 180 },
        stale: false,
      },
    ],
  } as unknown as UsageLimits;
  const stops: string[] = [],
    resumes: string[] = [];
  let deliver = true;
  let pending: (() => Promise<boolean>) | undefined;
  const makeService = () =>
    new SchedulePauseService({
      store,
      limits: () => ({
        ...limits,
        observed: limits.observed ?? {
          week: limits.week ? { ...limits.week, scrapedAt: now } : null,
          session5h: limits.session5h ? { ...limits.session5h, scrapedAt: now } : null,
        },
      }),
      now: () => now,
      stop: async (id, text) => {
        stops.push(text);
        return deliver;
      },
      resume: async (id, text) => {
        resumes.push(text);
        return pending ? pending() : deliver;
      },
      events: { emit() {} },
    });
  return {
    store,
    s,
    schedule,
    svc: makeService(),
    restart: makeService,
    succeed: () => (deliver = true),
    stops,
    resumes,
    setNow: (n: number) => (now = n),
    setLimits: (v: UsageLimits) => (limits = v),
    limits: () => limits,
    fail: () => (deliver = false),
    block: (f: () => Promise<boolean>) => (pending = f),
  };
}
function sessionInput() {
  return {
    name: "run",
    prompt: "work",
    repoPath: "/repo",
    baseBranch: "main",
    branch: null,
    worktreePath: "/repo",
    isolated: false,
    herdrSession: "h",
    herdrAgentId: "a",
    claudeSessionId: "c",
    model: null,
  };
}

test("Claude requests a cooperative stop once and pauses only on the turn end", async () => {
  const h = harness();
  await h.svc.tick();
  await h.svc.tick();
  expect(h.stops).toHaveLength(1);
  expect(h.stops[0]).toContain("Finish the step");
  expect(h.stops[0]).not.toContain("\x1b");
  expect(h.store.get(h.s.id)?.usagePause?.phase).toBe("requested");
  expect(h.store.getScheduleRun(h.schedule.id, "slot")?.outcome).toBe("spawned");
  h.svc.onStatus(h.s.id, "blocked");
  expect(h.store.get(h.s.id)?.usagePause?.phase).toBe("requested");
  h.store.update(h.s.id, { status: "done" });
  h.svc.onStatus(h.s.id, "done");
  expect(h.store.get(h.s.id)?.usagePause?.phase).toBe("paused");
  expect(h.store.getScheduleRun(h.schedule.id, "slot")).toMatchObject({
    outcome: "paused",
    pausedUntil: 200,
  });
});

test("Codex uses its own window and never receives a stop steer", async () => {
  const h = harness("codex");
  await h.svc.tick();
  expect(h.stops).toHaveLength(0);
  expect(h.store.get(h.s.id)?.usagePause).toMatchObject({ resumeAt: 180, windows: ["5h"] });
});

test("only opt-in sessions at or above the stop request a pause", async () => {
  const off = harness("claude", false);
  await off.svc.tick();
  expect(off.store.get(off.s.id)?.usagePause).toBeNull();
  const low = harness();
  low.limits().week!.pct = 79;
  await low.svc.tick();
  expect(low.store.get(low.s.id)?.usagePause).toBeNull();
});

test("both triggering windows use the later reset; hard halt does not need a prior tick", () => {
  const h = harness();
  h.limits().session5h = { pct: 90, resetAt: 500 };
  h.svc.onHalt(h.s.id, "usage_limit");
  expect(h.store.get(h.s.id)?.usagePause).toMatchObject({
    phase: "paused",
    resumeAt: 500,
    windows: ["week", "5h"],
  });
});

test("resume waits for the reset, rechecks usage and restores the same run", async () => {
  const h = harness();
  h.store.update(h.s.id, { status: "idle" });
  await h.svc.tick();
  expect(h.stops).toHaveLength(0);
  expect(h.resumes).toHaveLength(0);
  h.setNow(200);
  h.limits().week = { pct: 90, resetAt: 400 };
  await h.svc.tick();
  expect(h.resumes).toHaveLength(0);
  expect(h.store.get(h.s.id)?.usagePause?.resumeAt).toBe(400);
  h.setNow(400);
  h.limits().week = { pct: 10, resetAt: 600 };
  await h.svc.tick();
  expect(h.resumes).toHaveLength(1);
  expect(h.store.get(h.s.id)?.usagePause).toBeNull();
  expect(h.store.getScheduleRun(h.schedule.id, "slot")).toMatchObject({
    outcome: "spawned",
    pausedUntil: null,
  });
});

test("unknown, stale and missing triggering data never grant resume", async () => {
  for (const mode of ["missing", "stale", "expired"] as const) {
    const h = harness();
    h.store.update(h.s.id, { status: "done" });
    await h.svc.tick();
    h.setNow(200);
    if (mode === "missing") h.limits().week = null;
    if (mode === "stale") h.limits().stale = true;
    if (mode === "expired") h.limits().week = { pct: 10, resetAt: 200 };
    await h.svc.tick();
    expect(h.resumes).toHaveLength(0);
    expect(h.store.get(h.s.id)?.usagePause?.phase).toBe("paused");
  }
});

test("operator takeover, archive and shelve prevent automatic resume", async () => {
  for (const mode of ["operator", "archive", "shelve"] as const) {
    const h = harness();
    h.store.update(h.s.id, { status: "idle" });
    await h.svc.tick();
    if (mode === "operator") h.store.setUsagePause(h.s.id, null, true);
    if (mode === "archive") h.store.archive(h.s.id);
    if (mode === "shelve") h.store.setShelved(h.s.id, true);
    h.setNow(200);
    h.limits().week = { pct: 10, resetAt: 400 };
    await h.svc.tick();
    expect(h.resumes).toHaveLength(0);
    if (mode === "operator") {
      h.limits().week!.pct = 90;
      await h.svc.tick();
      expect(h.store.get(h.s.id)?.usagePause).toBeNull();
    }
  }
});

test("failed resume retains the pause; concurrent sweeps send only once", async () => {
  const h = harness();
  h.store.update(h.s.id, { status: "done" });
  await h.svc.tick();
  h.setNow(200);
  h.limits().week = { pct: 10, resetAt: 400 };
  h.fail();
  await h.svc.tick();
  expect(h.store.get(h.s.id)?.usagePause?.phase).toBe("paused");
  let release!: (v: boolean) => void;
  h.block(() => new Promise<boolean>((r) => (release = r)));
  const first = h.svc.tick();
  await h.svc.tick();
  release(true);
  await first;
  expect(h.resumes).toHaveLength(2);
  expect(h.store.get(h.s.id)?.usagePause).toBeNull();
});

test("a restarted coordinator retries an undelivered stop and resumes an overdue pause", async () => {
  const h = harness();
  h.fail();
  await h.svc.tick();
  expect(h.store.get(h.s.id)?.usagePause?.stopSteerSent).toBe(false);
  h.succeed();
  await h.restart().tick();
  expect(h.stops).toHaveLength(2);
  expect(h.store.get(h.s.id)?.usagePause?.stopSteerSent).toBe(true);
  await h.restart().tick();
  expect(h.stops).toHaveLength(2);
  h.store.update(h.s.id, { status: "done" });
  h.svc.onStatus(h.s.id, "done");
  h.setNow(200);
  h.limits().week = { pct: 10, resetAt: 400 };
  await h.restart().tick();
  expect(h.resumes).toHaveLength(1);
  expect(h.store.get(h.s.id)?.usagePause).toBeNull();
});

test("a missing reset is not invented and is filled by a later snapshot", async () => {
  const h = harness();
  h.limits().week!.resetAt = null as unknown as number;
  h.store.update(h.s.id, { status: "done" });
  await h.svc.tick();
  expect(h.store.get(h.s.id)?.usagePause?.resumeAt).toBeNull();
  expect(h.resumes).toHaveLength(0);
  h.limits().week!.resetAt = 200;
  await h.svc.tick();
  expect(h.store.get(h.s.id)?.usagePause?.resumeAt).toBe(200);
});

test("a hard halt without telemetry tolerates a confirmed absent 5h window", async () => {
  const h = harness();
  h.limits().week = null;
  h.limits().session5h = null;
  h.store.setHaltReason(h.s.id, "usage_limit", 100);
  h.svc.onHalt(h.s.id, "usage_limit");
  expect(h.store.get(h.s.id)?.usagePause?.resumeAt).toBeNull();
  h.limits().week = { pct: 90, resetAt: 200 };
  h.limits().observed = {
    week: { pct: 90, resetAt: 200, scrapedAt: 100 },
    session5h: null,
    session5hAbsent: true,
  };
  await h.svc.tick();
  expect(h.store.get(h.s.id)?.usagePause?.resumeAt).toBe(200);
  h.setNow(200);
  h.limits().week = null;
  h.limits().stale = true;
  h.limits().observed!.week = { pct: 10, resetAt: 400, scrapedAt: 200 };
  await h.svc.tick();
  expect(h.resumes).toHaveLength(1);
});

test("computed Claude anchors without observed resets remain unknown", async () => {
  const h = harness();
  h.limits().observed = { week: null, session5h: null };
  h.store.update(h.s.id, { status: "done" });
  await h.svc.tick();
  expect(h.store.get(h.s.id)?.usagePause?.resumeAt).toBeNull();
  h.setNow(200);
  h.limits().week = { pct: 0, resetAt: 400 };
  await h.svc.tick();
  expect(h.resumes).toHaveLength(0);
});

test("rolled-forward estimates require a provider sample confirming the new window", async () => {
  const h = harness();
  h.store.update(h.s.id, { status: "done" });
  await h.svc.tick();
  h.setNow(200);
  h.limits().week = { pct: 0, resetAt: 400 };
  h.limits().observed = { week: { pct: 80, resetAt: 200, scrapedAt: 100 }, session5h: null };
  await h.svc.tick();
  expect(h.resumes).toHaveLength(0);
  h.limits().observed!.week = { pct: 0, resetAt: 400, scrapedAt: 200 };
  await h.svc.tick();
  expect(h.resumes).toHaveLength(1);
});
