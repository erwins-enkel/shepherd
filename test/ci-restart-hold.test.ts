import { describe, expect, it } from "bun:test";
import {
  CiRestartHolds,
  restartCiRun,
  runIdFromJobUrl,
  type CiRestartRelease,
} from "../src/ci-restart-hold";
import { EventHub } from "../src/events";
import type { GitState } from "../src/forge/types";

/** Fake timers: one pending backstop per arm, fired by hand; `armed` counts set() calls. */
function harness() {
  const timers = new Map<number, () => void>();
  let next = 0;
  const holds = new CiRestartHolds({
    set: (fn) => {
      timers.set(++next, fn);
      return next;
    },
    clear: (h) => timers.delete(h as number),
  });
  const events = new EventHub();
  holds.attach(events);
  const released: [string, CiRestartRelease][] = [];
  holds.onRelease((id, reason) => released.push([id, reason]));
  const fire = () => [...timers.values()].forEach((fn) => fn());
  const git = (running: boolean) =>
    ({
      kind: "github",
      state: "open",
      checks: running ? "pending" : "failure",
      jobs: [{ name: "t", state: running ? "pending" : "failure" }],
    }) as GitState;
  const sample = (running: boolean) => events.emit("session:git", { id: "s1", git: git(running) });
  return { holds, events, released, fire, sample, pending: () => timers.size };
}

describe("CiRestartHolds", () => {
  it("moves cancelling → rerun and lifts on the re-run's first in-flight sample only", () => {
    const h = harness();
    h.holds.hold("s1");
    expect(h.holds.phase("s1")).toBe("cancelling");
    h.sample(true); // the cancel itself can still show jobs running: not the re-run yet
    expect(h.holds.held("s1")).toBe(true);
    h.holds.rerunIssued("s1");
    expect(h.holds.phase("s1")).toBe("rerun");
    h.sample(false);
    expect(h.holds.held("s1")).toBe(true);
    h.sample(true);
    expect(h.holds.held("s1")).toBe(false);
    expect(h.released).toEqual([["s1", "running"]]);
    expect(h.pending()).toBe(0);
  });

  it("expires on the backstop, which rerunIssued restarts", () => {
    const h = harness();
    h.holds.hold("s1");
    h.holds.rerunIssued("s1");
    expect(h.pending()).toBe(1); // the first backstop was cleared, one remains
    h.fire();
    expect(h.released).toEqual([["s1", "expired"]]);
    expect(h.holds.held("s1")).toBe(false);
  });

  it("reports a failed restart, ignores a re-run on an unheld session, drops archived silently", () => {
    const h = harness();
    h.holds.hold("s1");
    h.holds.release("s1", "failed");
    expect(h.released).toEqual([["s1", "failed"]]);
    h.holds.rerunIssued("s1");
    expect(h.holds.held("s1")).toBe(false);
    h.holds.hold("s1");
    h.events.emit("session:archived", { id: "s1" });
    expect(h.holds.held("s1")).toBe(false);
    expect(h.released).toHaveLength(1);
    expect(h.pending()).toBe(0);
  });
});

describe("runIdFromJobUrl", () => {
  it("reads the run id off an Actions job URL", () => {
    expect(runIdFromJobUrl("https://github.com/o/r/actions/runs/123/job/456")).toBe(123);
    expect(runIdFromJobUrl("https://github.com/o/r/actions/runs/123")).toBe(123);
    expect(runIdFromJobUrl("https://github.com/o/r/pull/9/checks")).toBeNull();
    expect(runIdFromJobUrl(undefined)).toBeNull();
  });
});

describe("restartCiRun", () => {
  function forge(statuses: string[], fail?: "cancel" | "rerun") {
    const calls: string[] = [];
    return {
      calls,
      forge: {
        cancelWorkflowRun: async (id: number) => {
          calls.push(`cancel ${id}`);
          if (fail === "cancel") throw new Error("boom");
        },
        getRunDetail: async (id: number) => {
          calls.push(`detail ${id}`);
          return { status: statuses.shift() ?? "in_progress" };
        },
        rerunWorkflowRun: async (id: number, o: { failedOnly: boolean }) => {
          calls.push(`rerun ${id} ${o.failedOnly}`);
          if (fail === "rerun") throw new Error("boom");
        },
      },
    };
  }

  it("cancels, waits for completion, re-runs failed jobs, then arms the re-run phase", async () => {
    const h = harness();
    const f = forge(["in_progress", "completed"]);
    const polled: string[] = [];
    h.holds.hold("s1");
    await restartCiRun({
      id: "s1",
      runId: 7,
      forge: f.forge,
      holds: h.holds,
      refreshPr: (id) => polled.push(id),
      sleep: async () => {},
    });
    expect(f.calls).toEqual(["cancel 7", "detail 7", "detail 7", "rerun 7 true"]);
    expect(h.holds.phase("s1")).toBe("rerun");
    expect(polled).toEqual(["s1"]);
  });

  it("releases the hold as failed when the run never completes or a call throws", async () => {
    for (const [f, calls] of [
      [forge([]), 31],
      [forge(["completed"], "rerun"), 3],
      [forge([], "cancel"), 1],
    ] as const) {
      const h = harness();
      h.holds.hold("s1");
      await restartCiRun({
        id: "s1",
        runId: 7,
        forge: f.forge,
        holds: h.holds,
        refreshPr: () => {},
        sleep: async () => {},
      });
      expect(f.calls).toHaveLength(calls);
      expect(h.released).toEqual([["s1", "failed"]]);
    }
  });
});
