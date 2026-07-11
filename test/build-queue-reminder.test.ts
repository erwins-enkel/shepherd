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
    steer: async (_id, text) => {
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
async function settleAndSweep(h: ReturnType<typeof harness>): Promise<void> {
  h.state.status = "running";
  await h.svc.sweep(); // observe running → sawRunning
  h.state.status = "idle";
  await h.svc.sweep(); // first idle tick → start timer
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep(); // settled → evaluate
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

test("reconciles drift: settled idle after running → exactly one steer, no double-steer", async () => {
  const h = harness("idle", queue(true, ["pending", "pending", "pending"]));
  await settleAndSweep(h);
  expect(h.steers).toEqual([RECONCILE_STEER]);

  // A second sweep in the SAME idle episode must not steer again.
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep();
  expect(h.steers).toHaveLength(1);
});

// ── sweep: guards (no steer) ────────────────────────────────────────────────

test("no collision with approval: drifted but never ran (sawRunning false) → no steer", async () => {
  const h = harness("idle", queue(true, ["pending", "pending"]));
  // Never running: first idle tick, then settle — sawRunning stays false.
  await h.svc.sweep();
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep();
  expect(h.steers).toHaveLength(0);
});

test("no waking a done session: status done + drifted → no steer", async () => {
  const h = harness("running", queue(true, ["pending", "pending"]));
  await h.svc.sweep(); // sawRunning
  h.state.status = "done";
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep();
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep();
  expect(h.steers).toHaveLength(0);
});

test("live gap honored: status running → no steer even when drifted", async () => {
  const h = harness("running", queue(true, ["pending", "pending"]));
  await h.svc.sweep();
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep();
  expect(h.steers).toHaveLength(0);
});

test("not settled: first idle tick (below threshold) → no steer", async () => {
  const h = harness("running", queue(true, ["pending"]));
  await h.svc.sweep(); // running → sawRunning
  h.state.status = "idle";
  await h.svc.sweep(); // first idle tick
  h.state.t += THRESHOLD - 1; // still below threshold
  await h.svc.sweep();
  expect(h.steers).toHaveLength(0);
});

test("negatives: has-active / all-done / unapproved / empty → no steer", async () => {
  for (const q of [
    queue(true, ["active", "pending"]),
    queue(true, ["done", "done"]),
    queue(false, ["pending", "pending"]),
    queue(true, []),
  ]) {
    const h = harness("idle", q);
    await settleAndSweep(h);
    expect(h.steers).toHaveLength(0);
  }
});

// ── sweep: plan gate ────────────────────────────────────────────────────────

test("plan gate: planning + drifted + settled idle → no steer", async () => {
  const h = harness("idle", queue(true, ["pending", "pending"]));
  h.state.planPhase = "planning";
  // Run during planning (must NOT set sawRunning), then settle idle and tick past threshold.
  h.state.status = "running";
  await h.svc.sweep();
  h.state.status = "idle";
  await h.svc.sweep(); // first idle tick (reset by the planning guard anyway)
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep(); // settled — but still planning → suppressed
  expect(h.steers).toHaveLength(0);
});

test("plan gate: planning suppresses, then executing nudges once after a post-flip run", async () => {
  const h = harness("idle", queue(true, ["pending", "pending"]));
  h.state.planPhase = "planning";

  // Phase 1 — run + settle idle while still planning: no steer, and sawRunning stays false.
  h.state.status = "running";
  await h.svc.sweep();
  h.state.status = "idle";
  await h.svc.sweep();
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep();
  expect(h.steers).toHaveLength(0);

  // Phase 2 — gate opens. A fresh execution run is required to arm sawRunning (the planning
  // run above never counted), so drive running AFTER the flip, then settle idle.
  h.state.planPhase = "executing";
  h.state.status = "running";
  await h.svc.sweep(); // sawRunning set now
  h.state.status = "idle";
  await h.svc.sweep(); // first idle tick of a fresh episode
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep(); // settled, executing, drifted → nudge
  expect(h.steers).toEqual([RECONCILE_STEER]);
});

// ── sweep: #1617 event-driven arming (burst race, boundary, discriminator) ──

test("burst missed by the 15s sweep: markRan (poller 1Hz event) arms where the sweep alone can't", async () => {
  const h = harness("idle", queue(true, ["pending", "pending", "pending"]));
  h.state.planPhase = "executing";

  // The agent's herdr-`working` burst falls entirely between two 15s sweeps, so the sweep NEVER
  // samples "running". This is the pre-fix behavior: sawRunning never arms → a drifted, settled-idle
  // executing session gets ZERO steers (the #1617 bug).
  await h.svc.sweep(); // first idle tick → idleSince
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep(); // settled, but sawRunning false → no steer
  expect(h.steers).toHaveLength(0);

  // The fix: the poller caught the same burst at 1 Hz and emitted session:status "running" →
  // markRan. Now the settled-idle drifted session nudges exactly once.
  h.svc.markRan("S");
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep();
  expect(h.steers).toEqual([RECONCILE_STEER]);
});

test("boundary: armed via markRan but flapping into blocked resets the settle → no steer", async () => {
  const h = harness("idle", queue(true, ["pending", "pending"]));
  h.state.planPhase = "executing";
  h.svc.markRan("S"); // agent ran earlier → armed

  // Its windows are non-idle: every time idle starts to accrue, a `blocked` tick resets it, so the
  // 120s settle never completes. Arming is real, but the fix must NOT rescue a non-idle session.
  await h.svc.sweep(); // idle tick → idleSince set
  h.state.status = "blocked";
  await h.svc.sweep(); // blocked → resetEpisode wipes idleSince
  h.state.status = "idle";
  await h.svc.sweep(); // idle again → settle restarts from now
  h.state.t += THRESHOLD - 1; // not yet past threshold since the restart
  await h.svc.sweep();
  expect(h.steers).toHaveLength(0);
});

test("never-started discriminator: executing + drifted but never observed running → no steer, no RECONCILE_STEER", async () => {
  const h = harness("idle", queue(true, ["pending", "pending"]));
  h.state.planPhase = "executing";

  // No markRan, no running sweep — the agent never worked. sawRunning stays false, so the session is
  // never nudged and RECONCILE_STEER (whose text assumes work happened) is never sent to it.
  await h.svc.sweep();
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep();
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep();
  expect(h.steers).toHaveLength(0);
  expect(h.steers).not.toContain(RECONCILE_STEER);
});

// ── sweep: episode reset + lifetime cap + retry ─────────────────────────────

test("episode reset: re-running between idle episodes allows another steer", async () => {
  const h = harness("idle", queue(true, ["pending", "pending"]));
  await settleAndSweep(h);
  expect(h.steers).toHaveLength(1);

  // Re-activate, then settle again still drifted → a fresh episode steers again.
  await settleAndSweep(h);
  expect(h.steers).toHaveLength(2);
});

test("lifetime cap halts repeated nudging after maxNudges", async () => {
  const h = harness("idle", queue(true, ["pending", "pending"]));
  await settleAndSweep(h); // 1
  await settleAndSweep(h); // 2
  await settleAndSweep(h); // 3
  expect(h.steers).toHaveLength(3);
  await settleAndSweep(h); // capped
  expect(h.steers).toHaveLength(3);
});

test("non-landing steer is retried (state not consumed)", async () => {
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
    steer: async (_id, text) => {
      steers.push(text);
      return landed; // first attempt fails to land
    },
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
  });

  state.status = "running";
  await svc.sweep();
  state.status = "idle";
  await svc.sweep();
  state.t += THRESHOLD + 1;
  await svc.sweep(); // attempt 1 — does not land
  expect(steers).toHaveLength(1);

  // Still same idle episode; because it didn't land, the episode is not marked fired.
  landed = true;
  state.t += 1;
  await svc.sweep(); // retry — lands now
  expect(steers).toHaveLength(2);
});

// ── sweep: re-entrancy (#1567) ──────────────────────────────────────────────

/** A harness whose steer parks until released, so a second sweep can overlap the first. */
function slowSteerHarness() {
  const state = { status: "idle" as SessionStatus, t: 0 };
  const steers: string[] = [];
  let release!: () => void;
  const parked = new Promise<void>((r) => (release = r));
  const svc = new BuildQueueReminderService({
    store: {
      list: () => [session(state.status, null)],
      getBuildQueue: () => queue(true, ["pending", "pending"]),
    } as never,
    steer: async (_id, text) => {
      steers.push(text);
      await parked; // the steer is in flight across the next tick
      return true;
    },
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
    maxNudges: 3,
  });
  return { svc, state, steers, release };
}

test("overlapping sweeps never double-steer the same session (the tick is dropped, not queued)", async () => {
  const { svc, state, steers, release } = slowSteerHarness();

  // running → idle → settled, so the next sweep is eligible to nudge.
  state.status = "running";
  await svc.sweep();
  state.status = "idle";
  await svc.sweep();
  state.t += THRESHOLD + 1;

  // Sweep A parks inside its steer. Sweep B fires on the next 15s tick while A is still in flight:
  // A has not yet set firedThisEpisode (that happens only after its steer resolves).
  const a = svc.sweep();
  await new Promise((r) => setTimeout(r, 0));
  const b = svc.sweep();
  await new Promise((r) => setTimeout(r, 0));

  expect(steers).toHaveLength(1); // B must not deliver a duplicate reconcile steer

  release();
  await Promise.all([a, b]);
  expect(steers).toHaveLength(1);
});

test("a rejected steer clears the in-flight guard — the next tick still sweeps", async () => {
  const state = { status: "idle" as SessionStatus, t: 0 };
  const steers: string[] = [];
  let fail = true;
  const svc = new BuildQueueReminderService({
    store: {
      list: () => [session(state.status, null)],
      getBuildQueue: () => queue(true, ["pending", "pending"]),
    } as never,
    steer: async (_id, text) => {
      steers.push(text);
      if (fail) throw new Error("herdr: no such agent");
      return true;
    },
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
    maxNudges: 3,
  });

  state.status = "running";
  await svc.sweep();
  state.status = "idle";
  await svc.sweep();
  state.t += THRESHOLD + 1;

  // The steer rejects — the sweep propagates (index.ts's .catch logs it) but must not wedge.
  await expect(svc.sweep()).rejects.toThrow("no such agent");
  expect(steers).toHaveLength(1);

  fail = false;
  state.t += 1;
  await svc.sweep(); // guard cleared → the retry lands
  expect(steers).toHaveLength(2);
});
