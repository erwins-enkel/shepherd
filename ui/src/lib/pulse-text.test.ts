import { describe, expect, it } from "vitest";
import { m } from "#lib/paraglide/messages.js";
import { pulseExplanation } from "./pulse-text";
import { sessionPulse } from "./session-pulse";
import type { GitState, Session, SteerLogEntry, WorkflowJob } from "./types";

const MIN = 60_000;
const NOW = 1_000 * MIN;
const session = { id: "s", status: "running", createdAt: NOW - 150 * MIN } as Session;
const green = (i: number): WorkflowJob => ({
  name: `CI / job ${i}`,
  state: "success",
  startedAt: NOW - 40 * MIN,
  completedAt: NOW - 37 * MIN,
});
const gate: WorkflowJob = {
  name: "CI / Release-Gate",
  state: "pending",
  startedAt: NOW - 9 * MIN,
  typicalMs: 43 * MIN,
};
const git = (jobs: WorkflowJob[]): GitState => ({
  kind: "github",
  state: "open",
  number: 128,
  createdAt: NOW - 58 * MIN,
  checks: jobs.some((j) => j.state === "failure") ? "failure" : "pending",
  deployConfigured: false,
  jobs,
});
const log = (...kinds: SteerLogEntry["kind"][]) =>
  kinds.map((kind, i) => ({ ts: NOW - (50 - i) * MIN, kind }));

function explain(jobs: WorkflowJob[], steers?: SteerLogEntry[]) {
  const g = git(jobs);
  const pulse = sessionPulse({ session, git: g, steers, nowMs: NOW })!;
  return pulseExplanation({ pulse, session, git: g, steers, nowMs: NOW });
}

describe("pulseExplanation", () => {
  it("leads with the verdict and what it rests on", () => {
    const e = explain([green(1), gate], log("go", "ci_fix"));
    expect(e.title).toBe(m.pulse_title_waiting_ci());
    expect(e.summary).toContain("Release-Gate");
    expect(e.sections.map((s) => s.label)).toEqual([
      m.pulse_section_ci({ green: 1, total: 2 }),
      m.pulse_section_history(),
      m.pulse_section_loop(),
      m.pulse_section_next(),
    ]);
    expect(e.sections[0]!.rows![0]).toEqual({
      text: "CI / Release-Gate",
      tone: "run",
      aside: m.pulse_minutes_of({ elapsed: 9, typical: 43 }),
    });
    expect(e.sections[2]!.rows).toEqual([{ text: m.pulse_loop_none(), tone: "ok" }]);
  });

  it("caps the CI list, keeping red and running jobs and summarising the green rest", () => {
    const rows = explain([gate, ...Array.from({ length: 8 }, (_, i) => green(i))]).sections[0]!
      .rows!;
    expect(rows).toHaveLength(7);
    expect(rows[0]!.tone).toBe("run");
    expect(rows.at(-1)).toEqual({ text: m.pulse_ci_more_green({ count: 3 }), tone: "ok" });
  });

  it("shows the newest history events and says how many earlier ones it left out", () => {
    const rows = explain([gate], log("go", "nudge", "nudge", "nudge", "ci_fix", "ci_fix"))
      .sections[1]!.rows!;
    expect(rows[0]!.text).toBe(m.pulse_event_earlier({ count: 2 }));
    expect(rows.at(-1)!.text).toBe(m.pulse_event_ci_fix());
  });

  it("the loop check waits for the log, then flags three CI fixes in a row", () => {
    expect(explain([gate]).sections[2]!.text).toBe(m.common_loading());
    const red = { ...green(1), state: "failure" as const };
    const looping = explain([red], log("ci_fix", "ci_fix", "ci_fix"));
    expect(looping.title).toBe(m.pulse_title_looping());
    expect(looping.sections.find((s) => s.label === m.pulse_section_loop())!.rows).toEqual([
      { text: m.pulse_loop_yes({ run: 3 }), tone: "fail" },
    ]);
  });
});
