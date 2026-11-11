import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store";
import { SchedulePauseService } from "../src/schedule-pause";
import { DEFAULT_LAUNCH } from "../src/schedules-core";
import { jsonlPathFor, SessionUsageRollup } from "../src/usage";
import type { AgentProvider } from "../src/types";
import type { UsageLimits } from "../src/usage-limits";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function record(id: string, input: number, output = 0, cacheWrite = 0, cacheRead = 0) {
  return JSON.stringify({
    type: "assistant",
    requestId: id,
    message: {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    },
  });
}
function harness(provider: AgentProvider = "claude") {
  const dir = mkdtempSync(join(tmpdir(), "schedule-budget-"));
  dirs.push(dir);
  const db = join(dir, "state.db");
  const store = new SessionStore(db);
  const schedule = store.insertSchedule(
    {
      repoPath: dir,
      name: "Budget",
      prompt: "work",
      days: 127,
      times: ["09:00"],
      interval: null,
      usageLimit: { kind: "upTo", stopPct: 80, pauseAtStop: true },
      tokenBudget: 100_000,
      enabled: true,
      launch: DEFAULT_LAUNCH,
    },
    0,
  );
  const s = store.create({
    name: "run",
    prompt: "work",
    repoPath: dir,
    baseBranch: "main",
    branch: null,
    worktreePath: dir,
    isolated: false,
    herdrSession: "h",
    herdrAgentId: "a",
    claudeSessionId: "c",
    model: null,
    agentProvider: provider,
    scheduleId: schedule.id,
  });
  store.update(s.id, { status: "running" });
  store.setSpawnIdentity(s.id, "a", dir);
  store.claimScheduleRun(schedule.id, "slot", 0);
  store.settleScheduleRun(schedule.id, "slot", "spawned", { sessionId: s.id });
  store.bindScheduleBudget(s.id, schedule.id, "slot", 100_000);
  const path = jsonlPathFor(dir, "c", dir);
  mkdirSync(dirname(path), { recursive: true });
  const stops: string[] = [],
    resumes: string[] = [];
  let pct = 0,
    busy = false;
  const makeService = (
    dbStore = store,
    overrides: Partial<ConstructorParameters<typeof SchedulePauseService>[0]> = {},
  ) =>
    new SchedulePauseService({
      store: dbStore,
      rollup: new SessionUsageRollup(),
      limits: () => ({ week: { pct, resetAt: Date.now() + 1000 } }) as UsageLimits,
      stop: async (_id, text) => {
        stops.push(text);
        return true;
      },
      resume: async (_id, text) => {
        resumes.push(text);
        return true;
      },
      isBackgroundBusy: () => busy,
      events: { emit() {} },
      ...overrides,
    });
  return {
    store,
    s,
    schedule,
    path,
    db,
    stops,
    resumes,
    svc: makeService(),
    makeService,
    setPct: (p: number) => {
      pct = p;
    },
    setBusy: (b: boolean) => {
      busy = b;
    },
  };
}

test("incremental input + writes + output, request dedupe and exact threshold stop at turn end", async () => {
  const h = harness();
  writeFileSync(h.path, record("1", 30_000, 10_000, 10_000, 1_000_000) + "\n");
  await h.svc.tick();
  expect(h.store.scheduleBudget(h.s.id)?.tokensUsed).toBe(50_000);
  expect(h.stops).toHaveLength(0);
  appendFileSync(
    h.path,
    record("1", 30_000, 10_000, 10_000, 1_000_000) + "\n" + record("2", 50_000),
  );
  await h.svc.tick();
  expect(h.store.scheduleBudget(h.s.id)?.tokensUsed).toBe(50_000);
  appendFileSync(h.path, "\n");
  await h.svc.tick();
  await h.svc.tick();
  expect(h.stops).toHaveLength(1);
  expect(h.stops[0]).toContain("token budget (100000)");
  expect(h.store.getScheduleRun(h.schedule.id, "slot")?.outcome).toBe("spawned");
  appendFileSync(h.path, record("3", 5_000) + "\n");
  h.store.update(h.s.id, { status: "done" });
  h.svc.onStatus(h.s.id, "done");
  expect(h.store.getScheduleRun(h.schedule.id, "slot")).toMatchObject({
    outcome: "stopped:budget",
    tokensUsed: 105_000,
    sessionId: h.s.id,
  });
  expect(h.store.hasOpenScheduledSession(h.schedule.id)).toBe(false);
  expect(h.store.get(h.s.id)?.status).toBe("done");
  await h.svc.tick();
  expect(h.resumes).toHaveLength(0);
});

test("turn end reads tokens before any tick, and budget wins over usage pause", async () => {
  const h = harness();
  h.setPct(90);
  writeFileSync(h.path, record("1", 100_000) + "\n");
  h.store.update(h.s.id, { status: "done" });
  h.svc.onStatus(h.s.id, "done");
  expect(h.store.get(h.s.id)?.usagePause?.reason).toBe("budget");
  expect(h.store.getScheduleRun(h.schedule.id, "slot")?.outcome).toBe("stopped:budget");
  await h.svc.tick();
  expect(h.resumes).toHaveLength(0);
});

test("restart, schedule deletion and history pruning preserve stop; operator continuation is unbudgeted", async () => {
  const h = harness();
  writeFileSync(h.path, record("1", 100_000) + "\n");
  await h.svc.tick();
  const reopened = new SessionStore(h.db);
  const svc = h.makeService(reopened);
  reopened.deleteSchedule(h.schedule.id);
  reopened.update(h.s.id, { status: "done" });
  svc.onStatus(h.s.id, "done");
  expect(reopened.get(h.s.id)?.usagePause?.phase).toBe("paused");
  reopened.pruneScheduleRuns(Date.now());
  expect(reopened.hasOpenScheduledSession(h.schedule.id)).toBe(false);
  reopened.setUsagePause(h.s.id, null, true);
  reopened.update(h.s.id, { status: "running" });
  await svc.tick();
  expect(reopened.get(h.s.id)?.usagePause).toBeNull();
  expect(reopened.scheduleBudget(h.s.id)).toBeNull();
});

test("Codex is unbudgeted and its run explains why", async () => {
  const h = harness("codex");
  writeFileSync(h.path, record("1", 200_000) + "\n");
  await h.svc.tick();
  expect(h.store.scheduleBudget(h.s.id)).toBeNull();
  expect(h.store.getScheduleRun(h.schedule.id, "slot")).toMatchObject({
    budgetNotApplied: "codex",
    tokensUsed: null,
  });
  expect(h.stops).toHaveLength(0);
});

test("missing transcript and active background work do not falsely end a run", async () => {
  const h = harness();
  await h.svc.tick();
  expect(h.store.scheduleBudget(h.s.id)?.tokensUsed).toBeNull();
  writeFileSync(h.path, record("1", 100_001) + "\n");
  h.setBusy(true);
  h.store.update(h.s.id, { status: "done" });
  await h.svc.tick();
  expect(h.store.getScheduleRun(h.schedule.id, "slot")?.outcome).toBe("spawned");
  h.setBusy(false);
  await h.svc.tick();
  expect(h.store.getScheduleRun(h.schedule.id, "slot")?.outcome).toBe("stopped:budget");
});

test("overriding only a usage pause retains the budget, which takes precedence later", async () => {
  const h = harness();
  h.setPct(90);
  await h.svc.tick();
  expect(h.store.get(h.s.id)?.usagePause?.reason).toBeUndefined();
  h.store.setUsagePause(h.s.id, null, true);
  writeFileSync(h.path, record("1", 100_000) + "\n");
  await h.svc.tick();
  expect(h.store.get(h.s.id)?.usagePause?.reason).toBe("budget");
});

test("held release binds its exact row and keeps the original budget after edits", async () => {
  const h = harness();
  h.store.claimScheduleRun(h.schedule.id, "held-slot", 2);
  h.store.settleScheduleRun(h.schedule.id, "held-slot", "held");
  h.store.bindScheduleBudget(h.s.id, h.schedule.id, "held-slot", 200_000);
  expect(h.store.getScheduleRun(h.schedule.id, "held-slot")).toMatchObject({
    sessionId: h.s.id,
    outcome: "spawned",
  });
  h.store.updateSchedule(h.schedule.id, { ...h.schedule, tokenBudget: 5_000_000 }, 2, false);
  expect(h.store.scheduleBudget(h.s.id)?.tokenBudget).toBe(100_000);
});

test("Codex budget non-application survives noop summaries and held reasons", () => {
  const h = harness("codex");
  h.store.settleScheduleRun(h.schedule.id, "slot", "held", { reason: "usage" });
  h.store.bindScheduleBudget(h.s.id, h.schedule.id, "slot", 100_000);
  expect(h.store.markScheduleRunNoop(h.s.id, h.schedule.id, "nothing to do")).toBe(true);
  expect(h.store.getScheduleRun(h.schedule.id, "slot")).toMatchObject({
    outcome: "noop",
    reason: "nothing to do",
    budgetNotApplied: "codex",
  });
});

test("replacing a budgeted run with Codex records non-application", () => {
  const h = harness();
  const replacement = h.store.create({
    name: "replacement",
    prompt: "work",
    repoPath: h.s.repoPath,
    baseBranch: "main",
    branch: null,
    worktreePath: h.s.worktreePath,
    isolated: false,
    herdrSession: "h",
    herdrAgentId: "b",
    agentProvider: "codex",
    scheduleId: h.schedule.id,
  });
  h.store.repointScheduleRun(h.s.id, replacement.id);
  expect(h.store.getScheduleRun(h.schedule.id, "slot")).toMatchObject({
    sessionId: replacement.id,
    budgetNotApplied: "codex",
  });
  expect(h.store.scheduleBudget(replacement.id)).toBeNull();
});

test("operator takeover during an in-flight stop cannot restore the budget lock", async () => {
  const h = harness();
  writeFileSync(h.path, record("1", 100_000) + "\n");
  let finish!: (delivered: boolean) => void;
  const svc = h.makeService(h.store, {
    stop: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const tick = svc.tick();
  expect(h.store.get(h.s.id)?.usagePause?.phase).toBe("requested");
  h.store.setUsagePause(h.s.id, null, true);
  finish(true);
  await tick;
  await svc.tick();
  expect(h.store.get(h.s.id)?.usagePause).toBeNull();
  expect(h.store.scheduleBudget(h.s.id)).toBeNull();
});

test("an undelivered budget stop retries, and promotion invalidates a prior pause identity", async () => {
  const h = harness();
  h.setPct(90);
  await h.svc.tick();
  const previous = h.store.get(h.s.id)!.usagePause!;
  writeFileSync(h.path, record("1", 100_000) + "\n");
  let attempts = 0;
  const svc = h.makeService(h.store, { stop: async () => ++attempts > 1 });
  await svc.tick();
  expect(h.store.get(h.s.id)?.usagePause?.since).toBeGreaterThan(previous.since);
  expect(h.store.get(h.s.id)?.usagePause?.stopSteerSent).toBe(false);
  await svc.tick();
  await svc.tick();
  expect(attempts).toBe(2);
  expect(h.store.get(h.s.id)?.usagePause?.stopSteerSent).toBe(true);
});

test("an ended budget stays ended after archive and operator restore", async () => {
  const h = harness();
  writeFileSync(h.path, record("1", 100_000) + "\n");
  h.store.update(h.s.id, { status: "done" });
  h.svc.onStatus(h.s.id, "done");
  h.store.archive(h.s.id);
  h.store.update(h.s.id, { status: "running" });
  await h.svc.tick();
  expect(h.store.get(h.s.id)?.usagePause).toBeNull();
  expect(h.store.getScheduleRun(h.schedule.id, "slot")?.outcome).toBe("stopped:budget");
});

test("a pending budget stop cannot be replaced by an automatic noop close", async () => {
  const h = harness();
  writeFileSync(h.path, record("1", 100_000) + "\n");
  await h.svc.tick();
  expect(h.store.markScheduleRunNoop(h.s.id, h.schedule.id, "nothing to do")).toBe(false);
  h.store.update(h.s.id, { status: "done" });
  h.svc.onStatus(h.s.id, "done");
  expect(h.store.getScheduleRun(h.schedule.id, "slot")?.outcome).toBe("stopped:budget");
});

test("creating a released held session binds the budget without exposing internal launch metadata", () => {
  const h = harness();
  h.store.claimScheduleRun(h.schedule.id, "held", 2);
  h.store.settleScheduleRun(h.schedule.id, "held", "held", { reason: "usage" });
  const released = h.store.create({
    name: "released",
    prompt: "work",
    repoPath: h.s.repoPath,
    baseBranch: "main",
    branch: null,
    worktreePath: h.s.worktreePath,
    isolated: false,
    herdrSession: "h",
    herdrAgentId: "b",
    scheduleId: h.schedule.id,
    scheduleRun: { slotKey: "held", tokenBudget: 200_000 },
  });
  expect(h.store.scheduleBudget(released.id)?.tokenBudget).toBe(200_000);
  expect(h.store.getScheduleRun(h.schedule.id, "held")).toMatchObject({
    sessionId: released.id,
    outcome: "spawned",
  });
  expect(released).not.toHaveProperty("scheduleRun");
});
