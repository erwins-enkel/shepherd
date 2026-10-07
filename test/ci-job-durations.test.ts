import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import type { WorkflowJob } from "../src/forge/types";

const done = (name: string, startedAt: number, durationMs: number): WorkflowJob => ({
  name,
  state: "success",
  startedAt,
  completedAt: startedAt + durationMs,
});

test("typical duration is the median of the recorded green runs, per repo and job", () => {
  const store = new SessionStore(":memory:");
  store.recordCiJobDurations("/a", [
    done("CI / gate", 1_000, 40_000),
    done("CI / lint", 1_000, 90),
  ]);
  store.recordCiJobDurations("/a", [done("CI / gate", 2_000, 50_000)]);
  store.recordCiJobDurations("/a", [done("CI / gate", 3_000, 60_000)]);
  store.recordCiJobDurations("/b", [done("CI / gate", 1_000, 1)]);

  expect(store.typicalCiJobDurations("/a")).toEqual(
    new Map([
      ["CI / gate", 50_000],
      ["CI / lint", 90],
    ]),
  );
  expect(store.typicalCiJobDurations("/b")).toEqual(new Map([["CI / gate", 1]]));
  expect(store.typicalCiJobDurations("/none")).toEqual(new Map());
});

test("only finished green runs count, and a re-polled run is recorded once", () => {
  const store = new SessionStore(":memory:");
  const failed: WorkflowJob = { ...done("CI / gate", 1_000, 5), state: "failure" };
  const running: WorkflowJob = { name: "CI / gate", state: "pending", startedAt: 2_000 };
  store.recordCiJobDurations("/a", [failed, running, { name: "CI / gate", state: "success" }]);
  expect(store.typicalCiJobDurations("/a")).toEqual(new Map());

  const green = done("CI / gate", 3_000, 30_000);
  store.recordCiJobDurations("/a", [green]);
  store.recordCiJobDurations("/a", [green]);
  store.recordCiJobDurations("/a", [done("CI / gate", 4_000, 10_000)]);
  // Two distinct runs (30s, 10s) — the duplicate poll of the first did not skew the median.
  expect(store.typicalCiJobDurations("/a").get("CI / gate")).toBe(20_000);
});

test("the median looks at the newest ten runs and the table keeps at most twenty per job", () => {
  const store = new SessionStore(":memory:");
  for (let i = 0; i < 25; i++)
    store.recordCiJobDurations("/a", [done("CI / gate", i, i < 15 ? 1 : 1_000)]);
  expect(store.typicalCiJobDurations("/a").get("CI / gate")).toBe(1_000);
  expect(store.ciJobDurationCount("/a", "CI / gate")).toBe(20);
});
