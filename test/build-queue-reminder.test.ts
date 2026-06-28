import { test, expect } from "bun:test";
import {
  BuildQueueReminderService,
  isQueueDrifted,
  RECONCILE_STEER,
} from "../src/build-queue-reminder";
import type { BuildQueue, BuildStep, BuildStepStatus, Session, SessionStatus } from "../src/types";

// ── fixtures ────────────────────────────────────────────────────────────────

function step(position: number, status: BuildStepStatus): BuildStep {
  return { id: `s${position}`, title: `Step ${position}`, detail: "", status, position };
}

function queue(approved: boolean, statuses: BuildStepStatus[]): BuildQueue {
  return { sessionId: "S", approved, steps: statuses.map((st, i) => step(i, st)) };
}

function session(status: SessionStatus, planPhase: Session["planPhase"] = null): Session {
  // Only id + status + planPhase are read by the service; the rest is filler.
  return { id: "S", status, planPhase } as unknown as Session;
}

const THRESHOLD = 1000;

/** Build a service over a single session whose status + queue are mutable between sweeps. */
function harness(initialStatus: SessionStatus, initialQueue: BuildQueue) {
  const state = {
    status: initialStatus,
    queue: initialQueue,
    planPhase: null as Session["planPhase"],
    t: 0,
  };
  const steers: string[] = [];
  const svc = new BuildQueueReminderService({
    store: {
      list: () => [session(state.status, state.planPhase)],
      getBuildQueue: () => state.queue,
    } as never,
    steer: (_id, text) => {
      steers.push(text);
      return true; // landed
    },
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
    maxNudges: 3,
  });
  return { svc, state, steers };
}

/** Drive a session from running → settled idle so it nudges once (the happy path). */
function settleAndSweep(h: ReturnType<typeof harness>): void {
  h.state.status = "running";
  h.svc.sweep(); // observe running → sawRunning
  h.state.status = "idle";
  h.svc.sweep(); // first idle tick → start timer
  h.state.t += THRESHOLD + 1;
  h.svc.sweep(); // settled → evaluate
}

// ── isQueueDrifted ──────────────────────────────────────────────────────────

test("isQueueDrifted: approved + pending + no active → true", () => {
  expect(isQueueDrifted(queue(true, ["pending", "pending"]))).toBe(true);
  expect(isQueueDrifted(queue(true, ["done", "pending"]))).toBe(true);
});

test("isQueueDrifted: false when unapproved, empty, has active, or no pending", () => {
  expect(isQueueDrifted(queue(false, ["pending"]))).toBe(false);
  expect(isQueueDrifted(queue(true, []))).toBe(false);
  expect(isQueueDrifted(queue(true, ["active", "pending"]))).toBe(false);
  expect(isQueueDrifted(queue(true, ["done", "done"]))).toBe(false);
  expect(isQueueDrifted(queue(true, ["done", "skipped"]))).toBe(false);
});

// ── sweep: happy path ───────────────────────────────────────────────────────

test("reconciles drift: settled idle after running → exactly one steer, no double-steer", () => {
  const h = harness("idle", queue(true, ["pending", "pending", "pending"]));
  settleAndSweep(h);
  expect(h.steers).toEqual([RECONCILE_STEER]);

  // A second sweep in the SAME idle episode must not steer again.
  h.state.t += THRESHOLD + 1;
  h.svc.sweep();
  expect(h.steers).toHaveLength(1);
});

// ── sweep: guards (no steer) ────────────────────────────────────────────────

test("no collision with approval: drifted but never ran (sawRunning false) → no steer", () => {
  const h = harness("idle", queue(true, ["pending", "pending"]));
  // Never running: first idle tick, then settle — sawRunning stays false.
  h.svc.sweep();
  h.state.t += THRESHOLD + 1;
  h.svc.sweep();
  expect(h.steers).toHaveLength(0);
});

test("no waking a done session: status done + drifted → no steer", () => {
  const h = harness("running", queue(true, ["pending", "pending"]));
  h.svc.sweep(); // sawRunning
  h.state.status = "done";
  h.state.t += THRESHOLD + 1;
  h.svc.sweep();
  h.state.t += THRESHOLD + 1;
  h.svc.sweep();
  expect(h.steers).toHaveLength(0);
});

test("live gap honored: status running → no steer even when drifted", () => {
  const h = harness("running", queue(true, ["pending", "pending"]));
  h.svc.sweep();
  h.state.t += THRESHOLD + 1;
  h.svc.sweep();
  expect(h.steers).toHaveLength(0);
});

test("not settled: first idle tick (below threshold) → no steer", () => {
  const h = harness("running", queue(true, ["pending"]));
  h.svc.sweep(); // running → sawRunning
  h.state.status = "idle";
  h.svc.sweep(); // first idle tick
  h.state.t += THRESHOLD - 1; // still below threshold
  h.svc.sweep();
  expect(h.steers).toHaveLength(0);
});

test("negatives: has-active / all-done / unapproved / empty → no steer", () => {
  for (const q of [
    queue(true, ["active", "pending"]),
    queue(true, ["done", "done"]),
    queue(false, ["pending", "pending"]),
    queue(true, []),
  ]) {
    const h = harness("idle", q);
    settleAndSweep(h);
    expect(h.steers).toHaveLength(0);
  }
});

// ── sweep: plan gate ────────────────────────────────────────────────────────

test("plan gate: planning + drifted + settled idle → no steer", () => {
  const h = harness("idle", queue(true, ["pending", "pending"]));
  h.state.planPhase = "planning";
  // Run during planning (must NOT set sawRunning), then settle idle and tick past threshold.
  h.state.status = "running";
  h.svc.sweep();
  h.state.status = "idle";
  h.svc.sweep(); // first idle tick (reset by the planning guard anyway)
  h.state.t += THRESHOLD + 1;
  h.svc.sweep(); // settled — but still planning → suppressed
  expect(h.steers).toHaveLength(0);
});

test("plan gate: planning suppresses, then executing nudges once after a post-flip run", () => {
  const h = harness("idle", queue(true, ["pending", "pending"]));
  h.state.planPhase = "planning";

  // Phase 1 — run + settle idle while still planning: no steer, and sawRunning stays false.
  h.state.status = "running";
  h.svc.sweep();
  h.state.status = "idle";
  h.svc.sweep();
  h.state.t += THRESHOLD + 1;
  h.svc.sweep();
  expect(h.steers).toHaveLength(0);

  // Phase 2 — gate opens. A fresh execution run is required to arm sawRunning (the planning
  // run above never counted), so drive running AFTER the flip, then settle idle.
  h.state.planPhase = "executing";
  h.state.status = "running";
  h.svc.sweep(); // sawRunning set now
  h.state.status = "idle";
  h.svc.sweep(); // first idle tick of a fresh episode
  h.state.t += THRESHOLD + 1;
  h.svc.sweep(); // settled, executing, drifted → nudge
  expect(h.steers).toEqual([RECONCILE_STEER]);
});

// ── sweep: episode reset + lifetime cap + retry ─────────────────────────────

test("episode reset: re-running between idle episodes allows another steer", () => {
  const h = harness("idle", queue(true, ["pending", "pending"]));
  settleAndSweep(h);
  expect(h.steers).toHaveLength(1);

  // Re-activate, then settle again still drifted → a fresh episode steers again.
  settleAndSweep(h);
  expect(h.steers).toHaveLength(2);
});

test("lifetime cap halts repeated nudging after maxNudges", () => {
  const h = harness("idle", queue(true, ["pending", "pending"]));
  settleAndSweep(h); // 1
  settleAndSweep(h); // 2
  settleAndSweep(h); // 3
  expect(h.steers).toHaveLength(3);
  settleAndSweep(h); // capped
  expect(h.steers).toHaveLength(3);
});

test("non-landing steer is retried (state not consumed)", () => {
  const state = {
    status: "idle" as SessionStatus,
    queue: queue(true, ["pending", "pending"]),
    t: 0,
  };
  let landed = false;
  const steers: string[] = [];
  const svc = new BuildQueueReminderService({
    store: {
      list: () => [session(state.status)],
      getBuildQueue: () => state.queue,
    } as never,
    steer: (_id, text) => {
      steers.push(text);
      return landed; // first attempt fails to land
    },
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
  });

  state.status = "running";
  svc.sweep();
  state.status = "idle";
  svc.sweep();
  state.t += THRESHOLD + 1;
  svc.sweep(); // attempt 1 — does not land
  expect(steers).toHaveLength(1);

  // Still same idle episode; because it didn't land, the episode is not marked fired.
  landed = true;
  state.t += 1;
  svc.sweep(); // retry — lands now
  expect(steers).toHaveLength(2);
});
