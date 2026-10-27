import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    store,
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
