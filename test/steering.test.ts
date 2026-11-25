import { describe, expect, it } from "bun:test";
import { STEERING_LABEL, SteeringReportService, type SteeringEvent } from "../src/steering";
import {
  computeSteeringTables,
  type SteeringMessages,
  type SteeringReport,
} from "../src/steering-core";
import type { Session } from "../src/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 100 * DAY;

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    desig: id.toUpperCase(),
    prompt: `${id}: the login page shows a blank screen after sign-in`,
    repoPath: "/repo/app",
    auto: false,
    issueNumber: null,
    scheduleId: null,
    landingRepair: false,
    terminal: false,
    archiveReason: "merged",
    createdAt: NOW - 2 * DAY,
    settledAt: NOW - 2 * DAY + 3 * HOUR,
    archivedAt: NOW - 2 * DAY + 4 * HOUR,
    ...over,
  } as Session;
}

const typed = (n: number) => Array.from({ length: n }, (_, i) => session(`t${i}`));

/** A helper result labelling every typed session `describing bugfix`, with one finding. */
const resultFor = (sessions: Session[]) => ({
  prompts: sessions.map((s) => ({ desig: s.desig, type: "bugfix", style: "describing" })),
  steers: [],
  findings: [{ text: "Prompts state the symptom.", desigs: [sessions[0]!.desig] }],
  examples: [{ desig: sessions[0]!.desig, quote: "q", evidence: "e", rewrite: "a sharper prompt" }],
});

interface Harness {
  service: SteeringReportService;
  started: { label: string; cwd: string; argv: string[] }[];
  stopped: string[];
  cleaned: string[];
  inserted: SteeringReport[];
  events: SteeringEvent[];
  settings: Map<string, string>;
  ready: SteeringReport[];
}

function harness(
  sessions: Session[],
  opts: {
    readResult?: (cwd: string) => Promise<unknown>;
    start?: () => Promise<{ terminalId: string }>;
    readMessages?: (s: Session) => Promise<SteeringMessages>;
    stored?: SteeringReport[];
    usageHeld?: () => boolean;
  } = {},
): Harness {
  const h: Omit<Harness, "service"> = {
    started: [],
    stopped: [],
    cleaned: [],
    inserted: [...(opts.stored ?? [])],
    events: [],
    settings: new Map(),
    ready: [],
  };
  const list = (trigger?: SteeringReport["trigger"]) =>
    h.inserted
      .filter((r) => !trigger || r.trigger === trigger)
      .sort((a, b) => b.createdAt - a.createdAt);
  let clock = NOW;
  const service = new SteeringReportService({
    store: {
      listArchivedSessions: () => sessions,
      insertSteeringReport: (r) => void h.inserted.push(r),
      latestSteeringReport: (trigger) => list(trigger)[0] ?? null,
      listSteeringReports: (trigger) => list(trigger),
      getSetting: (k) => h.settings.get(k) ?? null,
      setSetting: (k, v) => void h.settings.set(k, v),
    },
    usageHeld: opts.usageHeld,
    onWeeklyReady: (r) => void h.ready.push(r),
    readMessages: opts.readMessages ?? (async () => ({ messages: [], unavailable: null })),
    herdr: {
      start: async (label: string, cwd: string, argv: string[]) => {
        h.started.push({ label, cwd, argv });
        return opts.start ? opts.start() : { terminalId: "term-1" };
      },
      stop: async (id: string) => void h.stopped.push(id),
    } as never,
    env: () => ({ provider: "claude", model: "sonnet", effort: null }),
    now: () => clock,
    emit: (e) => void h.events.push(e),
    makeTmpDir: () => "/tmp/steering-test",
    cleanup: (cwd) => void h.cleaned.push(cwd),
    readResult: opts.readResult ?? (async () => resultFor(sessions)),
    sleep: async (ms) => {
      clock += ms;
    },
    timeoutMs: 10_000,
    pollMs: 1_000,
  });
  return { service, ...h };
}

describe("SteeringReportService", () => {
  it("persists an ok report whose tables equal computeSteeringTables over its labels", async () => {
    const sessions = typed(6);
    const h = harness(sessions);
    expect(await h.service.run("manual")).toBe(true);
    const r = h.inserted[0]!;
    expect(r.status).toBe("ok");
    expect(r.trigger).toBe("manual");
    expect(r.model).toBe("sonnet");
    expect(r.labels?.findings).toHaveLength(1);
    expect(r.sessions.map((s) => s.repo)).toEqual(Array(6).fill("app"));
    expect(r.windowEnd).toBe(NOW);
    expect(r.windowStart).toBe(NOW - 7 * DAY);
    const digest = { sample: r.sample!, sessions: [] };
    // Tables recompute from the stored sessions' typed rows: rebuild via the same core call.
    expect(r.tables).toEqual(
      computeSteeringTables(
        {
          ...digest,
          sessions: r.sessions.map((s) => ({
            ...s,
            openingPrompt: "x",
            operatorSteers: [],
            windowComplete: true,
            transcript: null,
          })),
        },
        r.labels!,
      ),
    );
    expect(h.started[0]!.label.startsWith(STEERING_LABEL)).toBe(true);
    expect(h.started[0]!.argv).toContain("Write");
    expect(h.started[0]!.argv).not.toContain("--add-dir");
    expect(h.stopped).toEqual(["term-1"]);
    expect(h.cleaned).toEqual(["/tmp/steering-test"]);
    expect(h.service.snapshot()).toEqual({ running: false, report: r, trend: [], unread: false });
  });

  it("emits running at start and the persisted report at the end", async () => {
    const h = harness(typed(6));
    await h.service.run("weekly");
    expect(h.events).toEqual([
      { running: true },
      { running: false, id: h.inserted[0]!.id, status: h.inserted[0]!.status },
    ]);
  });

  it("drops findings on a thin sample but keeps tables and examples", async () => {
    const h = harness(typed(2));
    await h.service.run("manual");
    const r = h.inserted[0]!;
    expect(r.status).toBe("thin");
    expect(r.labels?.findings).toEqual([]);
    expect(r.labels?.examples).toHaveLength(1);
    expect(r.tables?.byStyle[0]?.n).toBe(2);
  });

  it("persists empty without spawning when nothing is typed or steered", async () => {
    const h = harness([session("i1", { issueNumber: 3 }), session("old", { archivedAt: 1 })]);
    await h.service.run("manual");
    expect(h.started).toEqual([]);
    expect(h.inserted[0]?.status).toBe("empty");
    expect(h.inserted[0]?.model).toBeNull();
    expect(h.inserted[0]?.sample?.skipped.outOfWindow).toBe(1);
    expect(h.events.at(-1)).toEqual({
      running: false,
      id: h.inserted[0]!.id,
      status: h.inserted[0]!.status,
    });
  });

  it("persists failed(unparseable) on junk output, reaping the helper", async () => {
    const h = harness(typed(6), { readResult: async () => ({ junk: true }) });
    await h.service.run("manual");
    expect(h.inserted[0]).toMatchObject({ status: "failed", error: "unparseable", labels: null });
    expect(h.stopped).toEqual(["term-1"]);
    expect(h.cleaned).toEqual(["/tmp/steering-test"]);
  });

  it("persists failed(timeout) when no result arrives, reaping the helper", async () => {
    const h = harness(typed(6), { readResult: async () => null });
    await h.service.run("manual");
    expect(h.inserted[0]).toMatchObject({ status: "failed", error: "timeout" });
    expect(h.stopped).toEqual(["term-1"]);
    expect(h.cleaned).toEqual(["/tmp/steering-test"]);
  });

  it("persists failed with the spawn error and still cleans the tmp dir", async () => {
    const h = harness(typed(6), {
      start: () => Promise.reject(new Error("herdr down")),
    });
    await h.service.run("manual");
    expect(h.inserted[0]?.status).toBe("failed");
    expect(h.inserted[0]?.error).toContain("herdr down");
    expect(h.stopped).toEqual([]);
    expect(h.cleaned).toEqual(["/tmp/steering-test"]);
  });

  it("records an unreadable transcript as the session's reason instead of failing", async () => {
    const h = harness(typed(6), {
      readMessages: () => Promise.reject(new Error("gone")),
    });
    await h.service.run("manual");
    expect(h.inserted[0]?.status).toBe("ok");
  });

  it("is single-flight: a second start is rejected while the first runs", async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    const sessions = typed(6);
    const h = harness(sessions, {
      readResult: async () => {
        await gate;
        return resultFor(sessions);
      },
    });
    expect(h.service.start("manual")).toBe(true);
    expect(h.service.snapshot().running).toBe(true);
    expect(h.service.start("manual")).toBe(false);
    expect(await h.service.run("manual")).toBe(false);
    release(null);
    // Let the first run drain.
    while (h.service.snapshot().running) await new Promise((r) => setTimeout(r, 1));
    expect(h.inserted).toHaveLength(1);
    expect(h.service.start("manual")).toBe(true);
  });

  it("persists failed instead of throwing when the store read throws", async () => {
    const h = harness([]);
    (
      h.service as unknown as { deps: { store: { listArchivedSessions: () => never } } }
    ).deps.store.listArchivedSessions = () => {
      throw new Error("db locked");
    };
    expect(await h.service.run("manual")).toBe(true);
    expect(h.inserted[0]).toMatchObject({ status: "failed", error: "db locked", sample: null });
  });
});

function storedReport(over: Partial<SteeringReport> & { id: string }): SteeringReport {
  return {
    createdAt: NOW - 8 * DAY,
    windowStart: NOW - 15 * DAY,
    windowEnd: NOW - 8 * DAY,
    trigger: "weekly",
    status: "ok",
    error: null,
    model: null,
    sample: null,
    sessions: [],
    labels: { prompts: [], steers: [], findings: [], examples: [] },
    tables: null,
    ...over,
  };
}

describe("SteeringReportService weekly digest (#4176)", () => {
  it("runs a weekly report when due and hands an ok report to onWeeklyReady", async () => {
    const h = harness(typed(6));
    expect(await h.service.tickWeekly()).toBe("ran");
    expect(h.inserted.at(-1)?.trigger).toBe("weekly");
    expect(h.ready.map((r) => r.id)).toEqual([h.inserted.at(-1)!.id]);
  });

  it("does not run before the newest weekly report is a week old", async () => {
    const h = harness(typed(6), { stored: [storedReport({ id: "w", createdAt: NOW - 6 * DAY })] });
    expect(await h.service.tickWeekly()).toBe("not-due");
    expect(h.started).toHaveLength(0);
  });

  it("ignores manual reports when deciding the weekly run is due", async () => {
    const h = harness(typed(6), {
      stored: [storedReport({ id: "m", trigger: "manual", createdAt: NOW - HOUR })],
    });
    expect(await h.service.tickWeekly()).toBe("ran");
  });

  it("defers while the usage hold is active", async () => {
    const h = harness(typed(6), { usageHeld: () => true });
    expect(await h.service.tickWeekly()).toBe("held");
    expect(h.started).toHaveLength(0);
    expect(h.inserted).toHaveLength(0);
  });

  it("is busy while a run is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(typed(6), {
      readMessages: () => gate.then(() => ({ messages: [], unavailable: null })),
    });
    const first = h.service.start("manual");
    expect(first).toBe(true);
    expect(await h.service.tickWeekly()).toBe("busy");
    release();
  });

  it("notifies for weekly ok/thin only — not manual, empty or failed", async () => {
    const manual = harness(typed(6));
    await manual.service.run("manual");
    expect(manual.ready).toHaveLength(0);

    const empty = harness([]);
    await empty.service.run("weekly");
    expect(empty.inserted.at(-1)?.status).toBe("empty");
    expect(empty.ready).toHaveLength(0);

    const failed = harness(typed(6), { readResult: async () => ({ nonsense: true }) });
    await failed.service.run("weekly");
    expect(failed.inserted.at(-1)?.status).toBe("failed");
    expect(failed.ready).toHaveLength(0);

    const thin = harness(typed(2));
    await thin.service.run("weekly");
    expect(thin.inserted.at(-1)?.status).toBe("thin");
    expect(thin.ready).toHaveLength(1);
  });

  it("marks the newest weekly digest unread until markSeen", () => {
    const h = harness([], {
      stored: [
        storedReport({ id: "w1", createdAt: NOW - 14 * DAY }),
        storedReport({ id: "w2", createdAt: NOW - 7 * DAY }),
        storedReport({ id: "m", trigger: "manual", createdAt: NOW - DAY }),
      ],
    });
    expect(h.service.snapshot().unread).toBe(true);
    h.service.markSeen();
    expect(h.settings.get("steeringReportSeenId")).toBe("w2");
    expect(h.service.snapshot().unread).toBe(false);
  });

  it("never marks unread for manual or failed reports only", () => {
    const h = harness([], {
      stored: [
        storedReport({ id: "m", trigger: "manual" }),
        storedReport({ id: "f", status: "failed", labels: null }),
      ],
    });
    expect(h.service.snapshot().unread).toBe(false);
  });

  it("snapshot carries the trend over weekly digests only", () => {
    const h = harness([], {
      stored: [
        storedReport({ id: "w1", createdAt: NOW - 14 * DAY }),
        storedReport({ id: "m", trigger: "manual", createdAt: NOW - 10 * DAY }),
        storedReport({ id: "w2", createdAt: NOW - 7 * DAY }),
      ],
    });
    const snap = h.service.snapshot();
    expect(snap.trend.map((p) => p.reportId)).toEqual(["w1", "w2"]);
    expect(snap.report?.id).toBe("w2");
  });
});
