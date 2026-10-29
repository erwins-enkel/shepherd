import { describe, expect, it } from "vitest";
import {
  ciRows,
  sessionPulse,
  slotFor,
  steerTally,
  timeline,
  type PulseInput,
} from "./session-pulse";
import type {
  BuildQueue,
  GitState,
  HeavySlotSnapshot,
  Session,
  SteerLogEntry,
  WorkflowJob,
} from "./types";

const MIN = 60_000;
const NOW = 1_000 * MIN;

const session = (over: Partial<Session> = {}) =>
  ({ id: "s1", status: "running", createdAt: NOW - 150 * MIN, ...over }) as Session;
const openPr = (jobs: WorkflowJob[], over: Partial<GitState> = {}): GitState => ({
  kind: "github",
  state: "open",
  number: 128,
  createdAt: NOW - 58 * MIN,
  checks: jobs.some((j) => j.state === "failure")
    ? "failure"
    : jobs.some((j) => j.state === "pending")
      ? "pending"
      : "success",
  deployConfigured: false,
  jobs,
  ...over,
});
const green = (name: string): WorkflowJob => ({
  name,
  state: "success",
  startedAt: NOW - 30 * MIN,
  completedAt: NOW - 28 * MIN,
});
const gate = (elapsedMin: number, typicalMin?: number): WorkflowJob => ({
  name: "CI / Release-Gate",
  state: "pending",
  startedAt: NOW - elapsedMin * MIN,
  ...(typicalMin ? { typicalMs: typicalMin * MIN } : {}),
});
const steers = (...kinds: SteerLogEntry["kind"][]): SteerLogEntry[] =>
  kinds.map((kind, i) => ({ ts: NOW - (60 - i) * MIN, kind }));
const pulse = (over: Partial<PulseInput>) =>
  sessionPulse({ session: session(), nowMs: NOW, ...over });

describe("sessionPulse", () => {
  it("waits on CI: names the job finishing last, its time against the usual, and the ETA", () => {
    const p = pulse({
      git: openPr([green("CI / lint"), gate(9, 43)]),
      steers: steers("go", "ci_fix"),
    });
    expect(p).toMatchObject({
      state: "waiting_ci",
      job: {
        name: "CI / Release-Gate",
        short: "Release-Gate",
        elapsedMs: 9 * MIN,
        typicalMs: 43 * MIN,
      },
      etaMs: NOW + 34 * MIN,
      green: 1,
      total: 2,
      ciFixRun: 1,
    });
  });

  it("calls CI overdue once a running job passes 1.5 × its usual time", () => {
    expect(pulse({ git: openPr([gate(64, 43)]) })?.state).toBe("waiting_ci");
    expect(pulse({ git: openPr([gate(65, 43)]) })).toMatchObject({
      state: "ci_overdue",
      job: { elapsedMs: 65 * MIN },
    });
  });

  it("gives a short job at least 3 min past its usual time before calling it overdue", () => {
    const quick = (elapsedMs: number): WorkflowJob => ({
      name: "CI / cli",
      state: "pending",
      startedAt: NOW - elapsedMs,
      typicalMs: 9_000,
    });
    expect(pulse({ git: openPr([quick(MIN)]) })?.state).toBe("waiting_ci");
    expect(pulse({ git: openPr([quick(3 * MIN + 9_000)]) })?.state).toBe("waiting_ci");
    expect(pulse({ git: openPr([quick(3 * MIN + 10_000)]) })?.state).toBe("ci_overdue");
  });

  it("without a usual time it still waits, without an ETA", () => {
    const p = pulse({ git: openPr([gate(9)]) });
    expect(p?.state).toBe("waiting_ci");
    expect(p?.etaMs).toBeUndefined();
  });

  it("reports red CI with the first failing job", () => {
    const failed: WorkflowJob = { ...green("CI / prodlike"), state: "failure" };
    expect(pulse({ git: openPr([green("CI / lint"), failed]) })).toMatchObject({
      state: "ci_failed",
      job: { name: "CI / prodlike" },
      green: 1,
      total: 2,
    });
  });

  it("calls three CI-fix steers in a row without green a loop; other steers break the run", () => {
    const red = openPr([{ ...green("CI / prodlike"), state: "failure" }]);
    expect(pulse({ git: red, steers: steers("ci_fix", "ci_fix", "ci_fix") })).toMatchObject({
      state: "looping",
      ciFixRun: 3,
    });
    expect(
      pulse({ git: red, steers: steers("ci_fix", "ci_fix", "operator", "ci_fix") })?.state,
    ).toBe("ci_failed");
    expect(
      pulse({ git: openPr([green("CI / x")]), steers: steers("ci_fix", "ci_fix", "ci_fix") }),
    ).toMatchObject({ state: "working" });
  });

  it("a blocked session needs the operator, whatever CI does", () => {
    expect(
      pulse({ session: session({ status: "blocked" }), git: openPr([gate(9, 43)]) })?.state,
    ).toBe("needs_you");
  });

  it("a running session without pending CI is working, on its active queue step", () => {
    const queue: BuildQueue = {
      sessionId: "s1",
      approved: true,
      steps: ["a", "b", "c", "d", "e"].map((id, position) => ({
        id,
        title: `step ${id}`,
        position,
        status: position < 2 ? "done" : position === 2 ? "active" : "pending",
      })),
    };
    expect(pulse({ queue })).toMatchObject({
      state: "working",
      step: { index: 3, total: 5, title: "step c" },
    });
  });

  it("has nothing to say about an idle session with no CI in flight", () => {
    expect(
      pulse({ session: session({ status: "idle" }), git: openPr([green("CI / x")]) }),
    ).toBeNull();
    expect(pulse({ session: session({ status: "done" }) })).toBeNull();
  });
});

describe("panel helpers", () => {
  it("ciRows lists failing, then running, then green, each with its time", () => {
    const failed: WorkflowJob = { ...green("CI / prodlike"), state: "failure" };
    expect(ciRows(openPr([green("CI / lint"), gate(9, 43), failed]).jobs, NOW)).toEqual([
      { name: "CI / prodlike", state: "failure", durationMs: 2 * MIN },
      { name: "CI / Release-Gate", state: "pending", elapsedMs: 9 * MIN, typicalMs: 43 * MIN },
      { name: "CI / lint", state: "success", durationMs: 2 * MIN },
    ]);
  });

  it("timeline merges start, PR opening and steers, oldest first", () => {
    const git = openPr([], { createdAt: NOW - 90 * MIN });
    expect(timeline(session(), git, steers("go", "ci_fix")).map((e) => e.kind)).toEqual([
      "start",
      "pr",
      "go",
      "ci_fix",
    ]);
  });

  it("steerTally counts Shepherd's steers apart from the operator's", () => {
    expect(steerTally(steers("go", "ci_fix", "operator", "ci_fix"))).toEqual({
      shepherd: 3,
      operator: 1,
      ciFix: 2,
      ciFixRun: 1,
    });
  });
});

describe("sessionPulse: the host-wide heavy-check slot (#3181)", () => {
  const snap = (over: Partial<HeavySlotSnapshot> = {}): HeavySlotSnapshot => ({
    enabled: true,
    capacity: 1,
    holders: [],
    waiters: [],
    brake: { active: false, reason: null },
    pressure: {
      ramAvailableBytes: null,
      ramTotalBytes: null,
      swapUsedBytes: null,
      swapTotalBytes: null,
      memFullAvg10: null,
      memBrakeThreshold: null,
      cpuSomeAvg10: null,
    },
    memoryBySource: { agentsBytes: null, foreignBytes: null, foreignTop: [] },
    lastResults: [],
    ...over,
  });
  const holding = snap({
    holders: [
      {
        sessionId: "s1",
        command: "bun run test",
        startedAt: NOW - 2 * MIN,
        rssBytes: 1.4 * 1024 ** 3,
      },
    ],
  });
  const waiting = (reason: "slot" | "pressure" = "slot") =>
    snap({ waiters: [{ sessionId: "s1", position: 2, reason }] });

  it("a holder checks with command, time and memory; a waiter has its place and reason", () => {
    expect(pulse({ heavySlot: holding })).toMatchObject({
      state: "slot_running",
      slot: {
        kind: "holding",
        command: "bun run test",
        elapsedMs: 2 * MIN,
        rssBytes: 1.4 * 1024 ** 3,
      },
    });
    expect(pulse({ heavySlot: waiting("pressure") })).toMatchObject({
      state: "slot_waiting",
      slot: { kind: "waiting", position: 2, pressure: true },
    });
  });

  it("only this session's entry counts, and a switched-off slot shows nothing", () => {
    expect(slotFor(waiting(), "other", NOW)).toBeNull();
    expect(slotFor({ ...holding, enabled: false }, "s1", NOW)).toBeNull();
    expect(slotFor(null, "s1", NOW)).toBeNull();
    expect(pulse({ heavySlot: { ...holding, enabled: false } })?.state).toBe("working");
  });

  it("ranks below needs-you and a CI-fix loop, above red or running CI", () => {
    const red = openPr([{ name: "CI / test", state: "failure", startedAt: NOW - MIN }]);
    expect(pulse({ session: session({ status: "blocked" }), heavySlot: waiting() })?.state).toBe(
      "needs_you",
    );
    expect(
      pulse({ git: red, steers: steers("ci_fix", "ci_fix", "ci_fix"), heavySlot: waiting() })
        ?.state,
    ).toBe("looping");
    expect(pulse({ git: red, heavySlot: waiting() })?.state).toBe("slot_waiting");
    expect(pulse({ git: openPr([gate(9, 43)]), heavySlot: holding })?.state).toBe("slot_running");
  });

  it("shows on an idle session (the agent ended its turn on purpose), never on an archived one", () => {
    expect(pulse({ session: session({ status: "idle" }), heavySlot: waiting() })?.state).toBe(
      "slot_waiting",
    );
    expect(pulse({ session: session({ status: "archived" }), heavySlot: holding })).toBeNull();
  });
});
