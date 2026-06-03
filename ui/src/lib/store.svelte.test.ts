import { test, expect } from "vitest";
import { HerdStore } from "./store.svelte";
import type { BacklogPayload, GitState, Session } from "./types";

const GIT: GitState = {
  kind: "github",
  state: "open",
  number: 4,
  checks: "pending",
  deployConfigured: false,
};

function session(id: string): Session {
  return {
    id,
    desig: "TASK-01",
    name: "n",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "b",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "a",
    claudeSessionId: "c",
    model: null,
    status: "running",
    readyToMerge: false,
    lastState: "working",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  };
}

test("setGit hydrates the git map", () => {
  const s = new HerdStore();
  s.setGit({ s1: GIT });
  expect(s.git.s1?.state).toBe("open");
});

test("session:git merges into the git map", () => {
  const s = new HerdStore();
  s.apply({ event: "session:git", data: { id: "s1", git: GIT } });
  expect(s.git.s1?.number).toBe(4);
});

test("session:ready patches the target session's readyToMerge", () => {
  const s = new HerdStore();
  s.setAll([session("s1"), session("s2")]);
  s.apply({ event: "session:ready", data: { id: "s1", ready: true } });
  expect(s.byId("s1")?.readyToMerge).toBe(true);
  expect(s.byId("s2")?.readyToMerge).toBe(false);
  s.apply({ event: "session:ready", data: { id: "s1", ready: false } });
  expect(s.byId("s1")?.readyToMerge).toBe(false);
});

test("backlog:update replaces the backlog snapshot so the overview stays live", () => {
  const s = new HerdStore();
  expect(s.backlog).toBeNull();

  const stale: BacklogPayload = {
    pinnedPath: "/r",
    projects: [],
    totals: { openIssues: 2, openPRs: 0 },
  };
  s.apply({ event: "backlog:update", data: stale });
  expect(s.backlog?.totals.openIssues).toBe(2);

  // a later push (server poller warmed fresher counts) overwrites the snapshot
  const fresh: BacklogPayload = {
    pinnedPath: "/r",
    projects: [],
    totals: { openIssues: 4, openPRs: 1 },
  };
  s.apply({ event: "backlog:update", data: fresh });
  expect(s.backlog?.totals.openIssues).toBe(4);
  expect(s.backlog?.totals.openPRs).toBe(1);
});

test("session:archived drops the git entry", () => {
  const s = new HerdStore();
  s.setAll([session("s1")]);
  s.setGit({ s1: GIT });
  s.apply({ event: "session:archived", data: { id: "s1" } });
  expect(s.git.s1).toBeUndefined();
});

test("session:renamed patches the name + branch of the matching session", () => {
  const s = new HerdStore();
  s.setAll([session("s1"), session("s2")]);
  s.apply({
    event: "session:renamed",
    data: { id: "s1", name: "fresh", branch: "shepherd/fresh" },
  });
  const a = s.sessions.find((x) => x.id === "s1");
  const b = s.sessions.find((x) => x.id === "s2");
  expect(a?.name).toBe("fresh");
  expect(a?.branch).toBe("shepherd/fresh");
  expect(b?.name).toBe("n"); // other sessions untouched
});
