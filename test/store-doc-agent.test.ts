import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import type { DocAgentRun } from "../src/types";

function mk() {
  return new SessionStore(":memory:");
}

const run1: DocAgentRun = { at: 1000, url: "https://forge/pr/1", outcome: "pr" };
const run2: DocAgentRun = { at: 2000, url: null, outcome: "observe" };
const run3: DocAgentRun = { at: 3000, url: null, outcome: "nochange" };

test("listDocAgentRuns returns [] for unknown repo", () => {
  const s = mk();
  expect(s.listDocAgentRuns("/no/such/repo")).toEqual([]);
});

test("listDocAgentRuns returns [] on corrupt stored value", () => {
  const s = mk();
  s.setSetting("docagent:runs:/repo", "not-valid-json{{{");
  expect(s.listDocAgentRuns("/repo")).toEqual([]);
});

test("recordDocAgentRun prepends newest-first", () => {
  const s = mk();
  s.recordDocAgentRun("/repo", run1);
  s.recordDocAgentRun("/repo", run2);
  s.recordDocAgentRun("/repo", run3);
  // newest first: run3 → run2 → run1
  expect(s.listDocAgentRuns("/repo")).toEqual([run3, run2, run1]);
});

test("recordDocAgentRun caps at 10 most recent", () => {
  const s = mk();
  for (let i = 1; i <= 12; i++) {
    s.recordDocAgentRun("/repo", { at: i * 100, url: null, outcome: "nochange" });
  }
  const runs = s.listDocAgentRuns("/repo");
  expect(runs).toHaveLength(10);
  // newest (i=12, at=1200) is first; oldest kept is i=3 (at=300)
  expect(runs[0]!.at).toBe(1200);
  expect(runs[9]!.at).toBe(300);
});

test("recordDocAgentRun is repo-isolated", () => {
  const s = mk();
  s.recordDocAgentRun("/repo-a", run1);
  s.recordDocAgentRun("/repo-b", run2);
  expect(s.listDocAgentRuns("/repo-a")).toEqual([run1]);
  expect(s.listDocAgentRuns("/repo-b")).toEqual([run2]);
});
