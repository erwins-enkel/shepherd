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
  const svc = new TurnEndBackstopService({
    store: { list: () => [session(state.status, state.planPhase)] } as never,
    considerPlan: async (s: Session) => {
      plans.push(s.id);
    },
    autopilotDone: async (id: string) => {
      dones.push(id);
    },
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
    maxAttempts: 3,
  });
  return { svc, state, plans, dones };
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

test("stops firing at the lifetime cap", async () => {
  const h = harness("planning");
  for (let i = 0; i < 5; i++) await restWithoutDone(h);
  expect(h.plans).toHaveLength(3); // maxAttempts
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
  const svc = new TurnEndBackstopService({
    store: { list: () => [session(state.status, "planning")] } as never,
    considerPlan: async () => {
      calls++;
      throw new Error("spawn failed");
    },
    autopilotDone: async () => {},
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
    maxAttempts: 3,
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
  // every 15s forever, so failed attempts count toward the cap too.
  for (let i = 0; i < 10; i++) await svc.sweep();
  expect(calls).toBe(3); // maxAttempts
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
    now: () => state.t,
    idleThresholdMs: THRESHOLD,
    maxAttempts: 3,
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
