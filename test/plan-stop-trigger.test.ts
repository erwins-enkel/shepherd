import { test, expect } from "bun:test";
import { PlanStopTrigger } from "../src/plan-stop-trigger";
import type { Session, SessionStatus } from "../src/types";

const DWELL = 10_000;

/** Fake timer queue: `advance(ms)` runs every timer whose deadline has passed. */
function harness(init: { status?: SessionStatus; planPhase?: Session["planPhase"] } = {}) {
  const state = {
    status: (init.status ?? "idle") as SessionStatus,
    planPhase: (init.planPhase ?? "planning") as Session["planPhase"],
    exists: true,
  };
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const plans: string[] = [];
  let reject: Error | null = null;
  const warnings: unknown[] = [];
  const trigger = new PlanStopTrigger({
    store: {
      get: (id: string) =>
        state.exists
          ? ({ id, status: state.status, planPhase: state.planPhase } as unknown as Session)
          : null,
    } as never,
    considerPlan: async (s: Session) => {
      plans.push(s.id);
      if (reject) throw reject;
    },
    dwellMs: DWELL,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id as never;
    },
    clearTimer: (h) => {
      timers.delete(h as unknown as number);
    },
    warn: (...args: unknown[]) => warnings.push(args),
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    trigger,
    state,
    plans,
    warnings,
    advance,
    timers,
    setReject: (e: Error) => (reject = e),
  };
}

test("Stop then a quiet dwell kicks the plan review once", async () => {
  const h = harness();
  h.trigger.onStop("S");
  await h.advance(DWELL - 1);
  expect(h.plans).toEqual([]);
  await h.advance(1);
  expect(h.plans).toEqual(["S"]);
  await h.advance(DWELL * 3);
  expect(h.plans).toEqual(["S"]);
});

test("activity inside the dwell cancels the pending review", async () => {
  const h = harness();
  h.trigger.onStop("S");
  await h.advance(DWELL / 2);
  h.trigger.cancel("S");
  await h.advance(DWELL * 2);
  expect(h.plans).toEqual([]);
});

test("a second Stop re-arms the dwell from scratch", async () => {
  const h = harness();
  h.trigger.onStop("S");
  await h.advance(DWELL - 1);
  h.trigger.onStop("S");
  await h.advance(DWELL - 1);
  expect(h.plans).toEqual([]);
  await h.advance(1);
  expect(h.plans).toEqual(["S"]);
  expect(h.timers.size).toBe(0);
});

test("does not fire when the session is working again at fire time", async () => {
  for (const status of ["running", "blocked"] as const) {
    const h = harness();
    h.trigger.onStop("S");
    h.state.status = status;
    await h.advance(DWELL);
    expect(h.plans).toEqual([]);
  }
});

test("does not fire outside the planning phase or for a vanished session", async () => {
  const exec = harness({ planPhase: "executing" });
  exec.trigger.onStop("S");
  await exec.advance(DWELL);
  expect(exec.plans).toEqual([]);

  const gone = harness();
  gone.trigger.onStop("S");
  gone.state.exists = false;
  await gone.advance(DWELL);
  expect(gone.plans).toEqual([]);
});

test("fires for a `done` resting session too", async () => {
  const h = harness({ status: "done" });
  h.trigger.onStop("S");
  await h.advance(DWELL);
  expect(h.plans).toEqual(["S"]);
});

test("forget drops the pending timer", async () => {
  const h = harness();
  h.trigger.onStop("S");
  h.trigger.forget("S");
  expect(h.timers.size).toBe(0);
  await h.advance(DWELL);
  expect(h.plans).toEqual([]);
});

test("a rejected consider is logged, never thrown", async () => {
  const h = harness();
  h.setReject(new Error("boom"));
  h.trigger.onStop("S");
  await h.advance(DWELL);
  expect(h.plans).toEqual(["S"]);
  expect(h.warnings.length).toBe(1);
});
