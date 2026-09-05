import { test, expect, beforeEach } from "bun:test";
import {
  SpawnPhaseTracker,
  SpawnCanceled,
  cancelSpawn,
  isValidSpawnId,
  registerSpawn,
  releaseSpawn,
  resetSpawnRegistry,
  type SpawnPhaseProgress,
} from "../src/spawn-progress";

/** Tracker wired to a controllable clock, a captured log and no real timer. */
function makeTracker(spawnId?: string) {
  const lines: string[] = [];
  const events: SpawnPhaseProgress[] = [];
  let clock = 1_000;
  const tracker = new SpawnPhaseTracker({
    spawnId,
    now: () => clock,
    log: (line) => lines.push(line),
    emit: (p) => events.push(p),
    yieldToLoop: () => Promise.resolve(),
  });
  return { tracker, lines, events, advance: (ms: number) => (clock += ms) };
}

beforeEach(() => resetSpawnRegistry());

test("logs one line naming every phase it ran, with the total", async () => {
  const { tracker, lines, advance } = makeTracker();
  await tracker.phase("base", () => advance(1_200));
  await tracker.phase("worktree", () => advance(400));
  await tracker.phase("agent", () => advance(18_300));
  tracker.finish("ok");

  expect(lines).toEqual(["[create] spawn ok base 1.2s worktree 0.4s agent 18.3s total 19.9s"]);
});

test("a phase that threw still appears on the log line", async () => {
  const { tracker, lines, advance } = makeTracker();
  await tracker.phase("base", () => advance(500));
  await expect(
    tracker.phase("agent", () => {
      advance(30_000);
      throw new Error("not auto-detected within 30s");
    }),
  ).rejects.toThrow("not auto-detected");
  tracker.finish("failed");

  expect(lines[0]).toBe("[create] spawn failed base 0.5s agent 30.0s total 30.5s");
});

test("emits the phase about to run, carrying the phases already done", async () => {
  const { tracker, events, advance } = makeTracker("spawn-abc12345");
  await tracker.phase("base", () => advance(1_200));
  await tracker.phase("worktree", () => advance(400));

  expect(events).toEqual([
    { spawnId: "spawn-abc12345", phase: "base", startedAt: 1_000, completed: [] },
    {
      spawnId: "spawn-abc12345",
      phase: "worktree",
      startedAt: 2_200,
      completed: [{ phase: "base", ms: 1_200 }],
    },
  ]);
});

test("emits nothing when the spawn is unobserved, but still measures", async () => {
  const { tracker, events, lines, advance } = makeTracker();
  await tracker.phase("base", () => advance(700));
  tracker.finish("ok");

  expect(events).toEqual([]);
  expect(lines[0]).toBe("[create] spawn ok base 0.7s total 0.7s");
});

test("cancel makes the next phase throw SpawnCanceled", async () => {
  const { tracker } = makeTracker("spawn-abc12345");
  expect(tracker.cancel()).toBe(true);
  expect(tracker.canceled).toBe(true);
  await expect(tracker.phase("base", () => 1)).rejects.toBeInstanceOf(SpawnCanceled);
});

test("cancel aborts the signal handed to herdr's poll loop", async () => {
  const { tracker } = makeTracker("spawn-abc12345");
  expect(tracker.signal.aborted).toBe(false);
  tracker.cancel();
  expect(tracker.signal.aborted).toBe(true);
});

test("a sealed spawn refuses cancellation — the agent is already up", () => {
  const { tracker } = makeTracker("spawn-abc12345");
  expect(tracker.seal()).toBe(true);
  expect(tracker.cancel()).toBe(false);
  expect(tracker.signal.aborted).toBe(false);
});

test("seal refuses when a cancel got there first — exactly one side wins", () => {
  const { tracker } = makeTracker("spawn-abc12345");
  expect(tracker.cancel()).toBe(true);
  // The driver may still have handed back a live agent; the caller must unwind, not persist.
  expect(tracker.seal()).toBe(false);
  // And the decision is stable: a second seal cannot talk its way past the cancel.
  expect(tracker.seal()).toBe(false);
});

test("registry cancels by id, reports too_late once sealed and unknown after release", () => {
  const { tracker } = makeTracker("spawn-abc12345");
  registerSpawn(tracker);
  expect(cancelSpawn("spawn-abc12345")).toBe("canceled");

  const second = makeTracker("spawn-def67890").tracker;
  registerSpawn(second);
  second.seal();
  expect(cancelSpawn("spawn-def67890")).toBe("too_late");

  releaseSpawn("spawn-def67890");
  expect(cancelSpawn("spawn-def67890")).toBe("unknown");
  expect(cancelSpawn("spawn-never-seen")).toBe("unknown");
});

test("an unobserved tracker is never registered — there is no id to cancel by", () => {
  const { tracker } = makeTracker();
  registerSpawn(tracker);
  expect(cancelSpawn("")).toBe("unknown");
});

test("spawn ids are bounded in length and alphabet", () => {
  expect(isValidSpawnId(crypto.randomUUID())).toBe(true);
  expect(isValidSpawnId("short")).toBe(false);
  expect(isValidSpawnId("has spaces in it")).toBe(false);
  expect(isValidSpawnId(`${"a".repeat(65)}`)).toBe(false);
  expect(isValidSpawnId("../../etc/passwd")).toBe(false);
});
