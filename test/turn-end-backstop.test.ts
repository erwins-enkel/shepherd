import { test, expect } from "bun:test";
import { TurnEndBackstopService } from "../src/turn-end-backstop";
import type { Session, SessionStatus } from "../src/types";

// ── fixtures ────────────────────────────────────────────────────────────────

function session(status: SessionStatus, planPhase: Session["planPhase"]): Session {
  // Only id + status + planPhase are read by the service; the rest is filler.
  return { id: "S", status, planPhase } as unknown as Session;
}

const THRESHOLD = 1000;

/** Build a service over a single session whose status + phase are mutable between sweeps. */
function harness(planPhase: Session["planPhase"] = "planning") {
  const state = { status: "running" as SessionStatus, planPhase, t: 0 };
  const plans: string[] = [];
  const dones: string[] = [];
  const pushes: string[] = [];
  const svc = new TurnEndBackstopService({
    store: { list: () => [session(state.status, state.planPhase)] } as never,
    considerPlan: async (s: Session) => {
      plans.push(s.id);
    },
    autopilotDone: async (id: string) => {
      dones.push(id);
    },
    notifyDone: async (id: string) => {
      pushes.push(id);
    },
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
    maxConsecutiveFailures: 3,
  });
  return { svc, state, plans, dones, pushes };
}

/** running → idle → settle. The exact shape of the bug: a turn that ends without `done`. */
async function restWithoutDone(h: ReturnType<typeof harness>): Promise<void> {
  h.state.status = "running";
  await h.svc.sweep(); // observe running → evidence gate armed
  h.state.status = "idle";
  await h.svc.sweep(); // first settled tick → start the clock only
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep(); // settled → evaluate
}

// ── the regression ──────────────────────────────────────────────────────────

test("planning session that rests as idle (never done) gets its plan review re-driven", async () => {
  const h = harness("planning");
  await restWithoutDone(h);
  expect(h.plans).toEqual(["S"]);
  expect(h.dones).toEqual([]);
});

test("does not fire before the settle threshold elapses", async () => {
  const h = harness("planning");
  h.state.status = "running";
  await h.svc.sweep();
  h.state.status = "idle";
  await h.svc.sweep(); // first settled tick — never fires (house rule)
  expect(h.plans).toEqual([]);
  h.state.t += THRESHOLD - 1; // still short of the threshold
  await h.svc.sweep();
  expect(h.plans).toEqual([]);
});

// ── guards ──────────────────────────────────────────────────────────────────

test("never fires for a session it did not observe running (restart safety)", async () => {
  const h = harness("planning");
  // Process starts with the session already at rest — no running was ever observed.
  h.state.status = "idle";
  await h.svc.sweep();
  h.state.t += THRESHOLD * 10;
  await h.svc.sweep();
  expect(h.plans).toEqual([]);
});

test("a delivered done edge suppresses the backstop for that resting episode", async () => {
  const h = harness("planning");
  h.state.status = "running";
  await h.svc.sweep();
  h.state.status = "done"; // herdr reported done → the real edge fired
  h.svc.markDelivered("S");
  await h.svc.sweep();
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep();
  expect(h.plans).toEqual([]);
});

test("done that decays to idle stays one episode — still suppressed", async () => {
  const h = harness("planning");
  h.state.status = "running";
  await h.svc.sweep();
  h.state.status = "done";
  h.svc.markDelivered("S");
  await h.svc.sweep();
  h.state.status = "idle"; // operator viewed the pane; herdr cleared `done`
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep();
  expect(h.plans).toEqual([]);
});

test("fires at most once per resting episode", async () => {
  const h = harness("planning");
  await restWithoutDone(h);
  h.state.t += THRESHOLD * 5;
  await h.svc.sweep();
  await h.svc.sweep();
  expect(h.plans).toEqual(["S"]);
});

test("re-arms after the session goes back to work and rests again", async () => {
  const h = harness("planning");
  await restWithoutDone(h);
  expect(h.plans).toEqual(["S"]);
  await restWithoutDone(h); // running resets the episode; a fresh rest fires again
  expect(h.plans).toEqual(["S", "S"]);
});

test("successful recoveries are NOT capped — every lost turn end is recovered", async () => {
  // The bug this service exists for repeats on EVERY turn of a watched session, so a lifetime cap
  // on successes would let it hang (and go un-notified) again from the 4th turn on.
  const h = harness("planning");
  for (let i = 0; i < 5; i++) await restWithoutDone(h);
  expect(h.plans).toHaveLength(5);
  expect(h.pushes).toHaveLength(5);
});

test("an executing session routes to autopilot, not the plan gate", async () => {
  const h = harness("executing");
  await restWithoutDone(h);
  expect(h.dones).toEqual(["S"]);
  expect(h.plans).toEqual([]);
});

test("a session with the plan gate off still gets its autopilot turn-end", async () => {
  const h = harness(null);
  await restWithoutDone(h);
  expect(h.dones).toEqual(["S"]);
  expect(h.plans).toEqual([]);
});

test("blocked is not a resting state — it never accrues settle time", async () => {
  const h = harness("planning");
  h.state.status = "running";
  await h.svc.sweep();
  h.state.status = "blocked"; // waiting on the operator, not finished
  await h.svc.sweep();
  h.state.t += THRESHOLD * 10;
  await h.svc.sweep();
  expect(h.plans).toEqual([]);
});

test("forget() drops a session's state so a stale episode can't fire after archive", async () => {
  const h = harness("planning");
  h.state.status = "running";
  await h.svc.sweep();
  h.state.status = "idle";
  await h.svc.sweep();
  h.svc.forget("S");
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep(); // forget cleared the evidence gate → this is a first sighting again
  expect(h.plans).toEqual([]);
});

test("a rejected dispatch does not burn the episode — the next sweep retries", async () => {
  const state = { status: "running" as SessionStatus, t: 0 };
  let calls = 0;
  const pushes: string[] = [];
  const svc = new TurnEndBackstopService({
    store: { list: () => [session(state.status, "planning")] } as never,
    considerPlan: async () => {
      calls++;
      throw new Error("spawn failed");
    },
    autopilotDone: async () => {},
    notifyDone: async (id: string) => {
      pushes.push(id);
    },
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
    maxConsecutiveFailures: 3,
  });
  await svc.sweep();
  state.status = "idle";
  await svc.sweep();
  state.t += THRESHOLD + 1;
  await svc.sweep(); // throws internally, must not escape the sweep
  expect(calls).toBe(1);
  await svc.sweep(); // episode not burned → retried
  expect(calls).toBe(2);
  // ...but the retry is BOUNDED: a dependency that throws every time must not be re-driven
  // every 15s forever, so consecutive failed passes stop it.
  for (let i = 0; i < 10; i++) await svc.sweep();
  expect(calls).toBe(3); // maxConsecutiveFailures
  // The push consumer succeeded on the first pass and must NOT be replayed by the retries of the
  // one that failed — the whole reason the episode flags are per consumer.
  expect(pushes).toEqual(["S"]);
});

test("a clean pass resets the failure streak", async () => {
  const state = { status: "running" as SessionStatus, t: 0, fail: true };
  let calls = 0;
  const svc = new TurnEndBackstopService({
    store: { list: () => [session(state.status, "planning")] } as never,
    considerPlan: async () => {
      calls++;
      if (state.fail) throw new Error("spawn failed");
    },
    autopilotDone: async () => {},
    notifyDone: async () => {},
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
    maxConsecutiveFailures: 3,
  });
  const rest = async () => {
    state.status = "running";
    await svc.sweep();
    state.status = "idle";
    await svc.sweep();
    state.t += THRESHOLD + 1;
    await svc.sweep();
  };
  await rest(); // fail #1
  await rest(); // fail #2
  expect(calls).toBe(2);
  state.fail = false;
  await rest(); // succeeds → streak back to 0
  expect(calls).toBe(3);
  state.fail = true;
  // A fresh run of failures gets the full budget again, rather than the session being permanently
  // written off by two failures that a healthy pass has since disproved.
  await rest();
  await rest();
  await rest();
  expect(calls).toBe(6);
  await rest(); // streak exhausted again
  expect(calls).toBe(6);
});

// ── 1 Hz markActive path: a working burst between two sweeps is invisible to the sample ──────

test("markActive arms the evidence gate for a burst the sweep never samples", async () => {
  const h = harness("planning");
  // The session ran and finished entirely between two sweeps — every sample sees it resting.
  h.state.status = "idle";
  h.svc.markActive("S"); // the 1 Hz running transition
  h.state.status = "idle";
  await h.svc.sweep(); // first settled tick
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep();
  expect(h.plans).toEqual(["S"]);
});

test("markActive clears a previous turn's delivered flag", async () => {
  const h = harness("planning");
  h.state.status = "running";
  await h.svc.sweep();
  h.state.status = "done";
  h.svc.markDelivered("S"); // turn 1 ended normally
  await h.svc.sweep();
  // Turn 2: the session resumes and finishes between sweeps, and THIS turn end is lost.
  h.svc.markActive("S");
  h.state.status = "idle";
  await h.svc.sweep();
  h.state.t += THRESHOLD + 1;
  await h.svc.sweep();
  expect(h.plans).toEqual(["S"]); // not suppressed by turn 1's delivered flag
});

test("markActive resets the settle clock so a resumed session can't fire mid-turn", async () => {
  const h = harness("planning");
  h.state.status = "running";
  await h.svc.sweep();
  h.state.status = "idle";
  await h.svc.sweep(); // clock starts
  h.state.t += THRESHOLD * 5; // a long rest accrues
  h.svc.markActive("S"); // ...then the operator steers it; it's working again
  h.state.status = "idle"; // a sample lands while it is briefly at its prompt mid-turn
  await h.svc.sweep(); // must be treated as a FIRST settled tick, not an overdue one
  expect(h.plans).toEqual([]);
  h.state.t += THRESHOLD + 1; // only a fresh full settle may fire
  await h.svc.sweep();
  expect(h.plans).toEqual(["S"]);
});

test("sweep prunes state for sessions that are no longer listed", async () => {
  const state = { status: "running" as SessionStatus, t: 0, listed: true };
  const plans: string[] = [];
  const svc = new TurnEndBackstopService({
    store: { list: () => (state.listed ? [session(state.status, "planning")] : []) } as never,
    considerPlan: async (s: Session) => {
      plans.push(s.id);
    },
    autopilotDone: async () => {},
    notifyDone: async () => {},
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
    maxConsecutiveFailures: 3,
  });
  await svc.sweep(); // observe running
  state.listed = false;
  await svc.sweep(); // gone → pruned
  state.listed = true;
  state.status = "idle";
  await svc.sweep(); // first sighting again, no running observed since the prune
  state.t += THRESHOLD + 1;
  await svc.sweep();
  expect(plans).toEqual([]);
});

// ── the finish push (#2267): a third consumer of the same lost edge ──────────

test("recovers the finish push for a session that rests as idle (never done)", async () => {
  const h = harness("planning");
  await restWithoutDone(h);
  expect(h.pushes).toEqual(["S"]);
});

test("recovers the finish push regardless of plan phase", async () => {
  // attachPush() does not look at planPhase, so neither may the recovery: an executing session
  // that loses its `done` edge must still notify.
  for (const phase of ["executing", null] as const) {
    const h = harness(phase);
    await restWithoutDone(h);
    expect(h.pushes).toEqual(["S"]);
  }
});

test("a delivered done edge suppresses the recovered push — no duplicate notification", async () => {
  const h = harness("planning");
  h.state.status = "running";
  await h.svc.sweep();
  h.state.status = "done"; // attachPush() already notified off this edge
  h.svc.markDelivered("S");
  await h.svc.sweep();
  h.state.status = "idle"; // operator views the pane; herdr clears `done`
  h.state.t += THRESHOLD * 10;
  await h.svc.sweep();
  expect(h.pushes).toEqual([]);
});

test("does not push before the settle threshold, or without observed activity", async () => {
  const early = harness("planning");
  early.state.status = "running";
  await early.svc.sweep();
  early.state.status = "idle";
  await early.svc.sweep();
  early.state.t += THRESHOLD - 1;
  await early.svc.sweep();
  expect(early.pushes).toEqual([]);

  // Restart safety: a session already at rest when the process started was never observed active.
  const restarted = harness("planning");
  restarted.state.status = "idle";
  await restarted.svc.sweep();
  restarted.state.t += THRESHOLD * 10;
  await restarted.svc.sweep();
  expect(restarted.pushes).toEqual([]);
});

test("pushes at most once per resting episode, and again on the next lost turn end", async () => {
  const h = harness("planning");
  await restWithoutDone(h);
  h.state.t += THRESHOLD * 5;
  await h.svc.sweep();
  await h.svc.sweep();
  expect(h.pushes).toEqual(["S"]);
  await restWithoutDone(h); // next turn, edge lost again
  expect(h.pushes).toEqual(["S", "S"]);
});

test("a failing push does not suppress the phase-routed recovery", async () => {
  const state = { status: "running" as SessionStatus, t: 0 };
  const plans: string[] = [];
  const svc = new TurnEndBackstopService({
    store: { list: () => [session(state.status, "planning")] } as never,
    considerPlan: async (s: Session) => {
      plans.push(s.id);
    },
    autopilotDone: async () => {},
    notifyDone: async () => {
      throw new Error("no subscriptions");
    },
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
    maxConsecutiveFailures: 3,
  });
  await svc.sweep();
  state.status = "idle";
  await svc.sweep();
  state.t += THRESHOLD + 1;
  await svc.sweep();
  expect(plans).toEqual(["S"]); // the hang fix must not depend on the notification succeeding
});

test("a permanently failing phase consumer does not silence the finish push", async () => {
  // The runaway guard is per consumer for this reason: a plan-gate spawn that throws every time is
  // a different dependency from web-push, and must not write the session off for both.
  const state = { status: "running" as SessionStatus, t: 0 };
  let plans = 0;
  const pushes: string[] = [];
  const svc = new TurnEndBackstopService({
    store: { list: () => [session(state.status, "planning")] } as never,
    considerPlan: async () => {
      plans++;
      throw new Error("spawn failed");
    },
    autopilotDone: async () => {},
    notifyDone: async (id: string) => {
      pushes.push(id);
    },
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
    maxConsecutiveFailures: 3,
  });
  for (let i = 0; i < 6; i++) {
    state.status = "running";
    await svc.sweep();
    state.status = "idle";
    await svc.sweep();
    state.t += THRESHOLD + 1;
    await svc.sweep();
  }
  expect(plans).toBe(3); // written off by its own streak
  expect(pushes).toHaveLength(6); // every lost turn end still notified
});
