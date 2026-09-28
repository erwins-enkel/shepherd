// ci-watch plugin (#2540): pure rules — run filters, matrix collapse, thresholds, key verdicts.

import { test, expect } from "bun:test";
import {
  collapseMatrix,
  DAILY_CAP,
  evaluateKey,
  globMatch,
  observe,
  RUN_JOB,
  runSkip,
  thresholdFor,
} from "../src/plugins/bundled/ci-watch/rules";
import { DEFAULT_REPO, type KeyRecord } from "../src/plugins/bundled/ci-watch/state";

test.each([
  ["push", "failure", null],
  ["schedule", "failure", null],
  ["workflow_dispatch", "success", null],
  ["pull_request", "failure", "event"],
  ["merge_group", "failure", "event"],
  ["push", "cancelled", "cancelled"],
  ["schedule", "startup_failure", "startup_failure"],
] as const)("runSkip(%s, %s) → %s", (event, conclusion, want) => {
  expect(runSkip({ event, conclusion })).toBe(want);
});

test.each([
  ["test (ubuntu-latest, 20)", "test"],
  ["build / test (x)", "build / test"],
  ["lint", "lint"],
  ["(weird)", "(weird)"],
])("collapseMatrix(%s) → %s", (name, want) => {
  expect(collapseMatrix(name)).toBe(want);
});

test("observe: a red matrix leg makes the base job red; skipped/null ignored", () => {
  const obs = observe({
    conclusion: "failure",
    jobs: [
      { id: 1, name: "test (a)", conclusion: "success" },
      { id: 2, name: "test (b)", conclusion: "failure" },
      { id: 3, name: "lint", conclusion: "success" },
      { id: 4, name: "deploy", conclusion: "skipped" },
      { id: 5, name: "slow", conclusion: "timed_out" },
      { id: 6, name: "pending", conclusion: null },
    ],
  });
  expect(Object.fromEntries(obs)).toEqual({ test: "failure", lint: "success", slow: "failure" });
});

test("observe: a failed run with no red job gets the run pseudo-job", () => {
  expect(Object.fromEntries(observe({ conclusion: "failure", jobs: [] }))).toEqual({
    [RUN_JOB]: "failure",
  });
});

test("observe: a green run observes the run pseudo-job green", () => {
  expect(
    Object.fromEntries(
      observe({ conclusion: "success", jobs: [{ id: 1, name: "test", conclusion: "success" }] }),
    ),
  ).toEqual({ test: "success", [RUN_JOB]: "success" });
});

test("globMatch: anchored, case-insensitive, * and ?; regex chars literal", () => {
  expect(globMatch("Eval*", "Eval — autopilot stop-classifier")).toBe(true);
  expect(globMatch("eval*", "EVAL x")).toBe(true);
  expect(globMatch("Eval*", "My Eval")).toBe(false);
  expect(globMatch("CI?", "CI2")).toBe(true);
  expect(globMatch("a.b", "axb")).toBe(false);
});

test("thresholdFor: first matching override wins, else repo default", () => {
  const cfg = {
    ...DEFAULT_REPO,
    threshold: 1,
    overrides: [
      { glob: "Eval*", threshold: 2 },
      { glob: "*", threshold: 5 },
    ],
  };
  expect(thresholdFor(cfg, "Eval — jev")).toBe(2);
  expect(thresholdFor(cfg, "CI")).toBe(5);
  expect(thresholdFor(DEFAULT_REPO, "CI")).toBe(1);
});

const rec = (over: Partial<KeyRecord> = {}): KeyRecord => ({
  repo: "/r",
  workflowName: "CI",
  workflowFile: "ci.yml",
  job: "test",
  streak: 1,
  lastRunId: 1,
  lastConclusion: "failure",
  ...over,
});

test.each([
  ["forward", rec(), 1, 0, null],
  ["fixed since", rec({ lastConclusion: "success", streak: 0 }), 1, 0, "fixed"],
  [
    "filed + open",
    rec({ filed: { number: 1, url: "u", filedAt: "t", runId: 1, attempts: 1, sync: "open" } }),
    1,
    0,
    "filed",
  ],
  [
    "filed + closed re-forwards",
    rec({ filed: { number: 1, url: "u", filedAt: "t", runId: 1, attempts: 1, sync: "closed" } }),
    1,
    0,
    null,
  ],
  ["classified holds", rec({ classified: { runId: 1, outcome: "rejected" } }), 1, 0, "classified"],
  ["probing holds", rec({ classified: { runId: 1, outcome: "probing" } }), 1, 0, "classified"],
  ["flaky re-forwards", rec({ classified: { runId: 1, outcome: "flaky" } }), 1, 0, null],
  ["below threshold", rec({ streak: 1 }), 2, 0, "threshold"],
  ["at threshold", rec({ streak: 2 }), 2, 0, null],
  ["at cap", rec(), 1, DAILY_CAP, "cap"],
] as const)("evaluateKey: %s", (_n, r, threshold, filedToday, want) => {
  expect(evaluateKey(r, { threshold, filedToday })).toBe(want);
});
