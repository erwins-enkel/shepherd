import { test, expect } from "vitest";
import { groupSessionsByEpic as groupSessionsByEpicRaw } from "./epic-grouping";
import type { Session, GitState, Epic, EpicChild, SessionStatus } from "$lib/types";

function session(
  id: string,
  repoPath: string,
  issueNumber: number | null,
  status: SessionStatus = "running",
  readyToMerge = false,
): Session {
  return {
    id,
    desig: "TASK-01",
    name: "n",
    prompt: "p",
    repoPath,
    baseBranch: "main",
    branch: "b",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "a",
    claudeSessionId: "c",
    model: null,
    status,
    readyToMerge,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    issueNumber,
    lastState: "working",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
  };
}

function child(number: number): EpicChild {
  return {
    number,
    title: `child #${number}`,
    url: `https://x/${number}`,
    order: number,
    body: "",
    blockedBy: [],
    state: "running",
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
  };
}

function epic(repoPath: string, parentIssueNumber: number, childNumbers: number[]): Epic {
  return {
    repoPath,
    parentIssueNumber,
    parentTitle: `epic #${parentIssueNumber}`,
    source: "native",
    children: childNumbers.map(child),
    warnings: [],
    run: { repoPath, parentIssueNumber, mode: "auto", status: "running" },
  };
}

const key = (repoPath: string, parent: number) => `${repoPath}#${parent}`;

function git(state: GitState["state"], checks: GitState["checks"] = "none"): GitState {
  return { kind: "github", state, checks, deployConfigured: false };
}

const now = 1000;

function groupSessionsByEpic(
  sessions: Session[],
  epics: Record<string, Epic>,
  activeEpicKeys: Set<string>,
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean,
  at: number,
  isReworkRunning: (session: Session) => boolean = () => false,
) {
  return groupSessionsByEpicRaw(
    sessions,
    epics,
    activeEpicKeys,
    git,
    isReviewing,
    isReworkRunning,
    at,
  );
}

test("key-alignment: child issue number groups; parent issue number does NOT", () => {
  const e = epic("/r", 100, [101, 102]);
  const epics = { [key("/r", 100)]: e };
  const active = new Set([key("/r", 100)]);

  const childSession = session("s-child", "/r", 101);
  const parentSession = session("s-parent", "/r", 100); // matches parentIssueNumber, not a child

  const { groups, rest } = groupSessionsByEpic(
    [childSession, parentSession],
    epics,
    active,
    {},
    () => false,
    now,
  );

  expect(groups).toHaveLength(1);
  expect(groups[0].sessions.map((s) => s.id)).toEqual(["s-child"]);
  expect(rest.map((s) => s.id)).toEqual(["s-parent"]);
});

test("active-set filtering: an epic not in activeEpicKeys does not group (children → rest)", () => {
  const e = epic("/r", 100, [101]);
  const epics = { [key("/r", 100)]: e };
  const active = new Set<string>(); // empty — epic is idle/stale in store

  const s = session("s1", "/r", 101);
  const { groups, rest } = groupSessionsByEpic([s], epics, active, {}, () => false, now);

  expect(groups).toHaveLength(0);
  expect(rest.map((x) => x.id)).toEqual(["s1"]);
});

test("mixed: a stale epic (absent from activeEpicKeys) is ignored while another is active", () => {
  const stale = epic("/r", 100, [101]); // present in store but no longer active
  const live = epic("/r", 200, [201]);
  const epics = { [key("/r", 100)]: stale, [key("/r", 200)]: live };
  const active = new Set([key("/r", 200)]); // only the live epic is active

  const staleChild = session("s-stale", "/r", 101);
  const liveChild = session("s-live", "/r", 201);

  const { groups, rest } = groupSessionsByEpic(
    [staleChild, liveChild],
    epics,
    active,
    {},
    () => false,
    now,
  );

  expect(groups).toHaveLength(1);
  expect(groups[0].key).toBe(key("/r", 200));
  expect(groups[0].sessions.map((s) => s.id)).toEqual(["s-live"]);
  expect(rest.map((s) => s.id)).toEqual(["s-stale"]); // stale epic's child not pulled in
});

test("multi-repo: same child number in two repos does not cross-group", () => {
  const ea = epic("/repo-a", 100, [5]);
  const eb = epic("/repo-b", 200, [5]);
  const epics = {
    [key("/repo-a", 100)]: ea,
    [key("/repo-b", 200)]: eb,
  };
  const active = new Set([key("/repo-a", 100), key("/repo-b", 200)]);

  const sa = session("sa", "/repo-a", 5);
  const sb = session("sb", "/repo-b", 5);

  const { groups, rest } = groupSessionsByEpic([sa, sb], epics, active, {}, () => false, now);

  expect(rest).toHaveLength(0);
  expect(groups).toHaveLength(2);
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g.sessions.map((s) => s.id)]));
  expect(byKey[key("/repo-a", 100)]).toEqual(["sa"]);
  expect(byKey[key("/repo-b", 200)]).toEqual(["sb"]);
});

test("manual child: a session matching an active epic's child groups even with differing fields", () => {
  const e = epic("/r", 100, [101]);
  const epics = { [key("/r", 100)]: e };
  const active = new Set([key("/r", 100)]);

  // a "manual" session: not auto, idle status — still a child by issueNumber
  const s = session("manual", "/r", 101, "idle");
  s.auto = false;

  const { groups } = groupSessionsByEpic([s], epics, active, {}, () => false, now);
  expect(groups).toHaveLength(1);
  expect(groups[0].sessions.map((x) => x.id)).toEqual(["manual"]);
});

test("no epics / empty active set: all sessions in rest, no groups", () => {
  const s1 = session("a", "/r", 101);
  const s2 = session("b", "/r", null);

  // empty epics
  let res = groupSessionsByEpic([s1, s2], {}, new Set(), {}, () => false, now);
  expect(res.groups).toHaveLength(0);
  expect(res.rest.map((s) => s.id)).toEqual(["a", "b"]);

  // epics present but empty active set
  const epics = { [key("/r", 100)]: epic("/r", 100, [101]) };
  res = groupSessionsByEpic([s1, s2], epics, new Set(), {}, () => false, now);
  expect(res.groups).toHaveLength(0);
  expect(res.rest.map((s) => s.id)).toEqual(["a", "b"]);
});

test("ordering: groups by repo basename then parentIssueNumber; within group by STAGE_ORDER", () => {
  // Three epics: basenames sort zebra < zulu; within zebra two epics by parent number.
  const eZulu = epic("/path/zulu", 10, [1]);
  const eZebraHigh = epic("/path/zebra", 50, [3]);
  const eZebraLow = epic("/path/zebra", 20, [2]);
  const epics = {
    [key("/path/zulu", 10)]: eZulu,
    [key("/path/zebra", 50)]: eZebraHigh,
    [key("/path/zebra", 20)]: eZebraLow,
  };
  const active = new Set([key("/path/zulu", 10), key("/path/zebra", 50), key("/path/zebra", 20)]);

  const sZulu = session("zulu", "/path/zulu", 1);
  const sZebraLow = session("zebraLow", "/path/zebra", 2);
  const sZebraHigh = session("zebraHigh", "/path/zebra", 3);

  const { groups } = groupSessionsByEpic(
    [sZulu, sZebraHigh, sZebraLow],
    epics,
    active,
    {},
    () => false,
    now,
  );

  // zebra (basename) before zulu; within zebra, parent 20 before 50
  expect(groups.map((g) => g.key)).toEqual([
    key("/path/zebra", 20),
    key("/path/zebra", 50),
    key("/path/zulu", 10),
  ]);
});

test("ordering: within a group, members come back in STAGE_ORDER lifecycle order", () => {
  const e = epic("/r", 100, [1, 2, 3]);
  const epics = { [key("/r", 100)]: e };
  const active = new Set([key("/r", 100)]);

  // member A: active (running, no PR); member B: merged; member C: ready
  const a = session("a", "/r", 1, "running");
  const merged = session("m", "/r", 2, "idle");
  const ready = session("r", "/r", 3, "idle", true);

  const gitMap: Record<string, GitState> = {
    m: git("merged"),
  };

  // Pass in mixed input order — output must follow STAGE_ORDER: active < ready < merged
  const { groups } = groupSessionsByEpic(
    [merged, ready, a],
    epics,
    active,
    gitMap,
    () => false,
    now,
  );

  expect(groups).toHaveLength(1);
  expect(groups[0].sessions.map((s) => s.id)).toEqual(["a", "r", "m"]);
});

test("ordering: review-blocked and branch-blocked sit before waiting-on-reviewer", () => {
  const e = epic("/r", 100, [1, 2, 3, 4, 5]);
  const epics = { [key("/r", 100)]: e };
  const active = new Set([key("/r", 100)]);

  const wait = session("wait", "/r", 1, "idle");
  const rework = session("rework", "/r", 2, "running");
  const review = session("review", "/r", 3, "running");
  const needs = session("needs", "/r", 4, "idle");
  const branch = session("branch", "/r", 5, "idle");

  const { groups } = groupSessionsByEpic(
    [wait, rework, review, needs, branch],
    epics,
    active,
    {
      wait: { ...git("open", "success"), handoff: "reviewer", handoffWho: "scoop" },
      needs: {
        ...git("open", "success"),
        reviewBlock: { reviewer: "scoop", state: "changes_requested", latestAt: 1 },
      },
      branch: { ...git("open", "success"), mergeStateStatus: "blocked" },
    },
    (id) => id === "review",
    now,
    (s) => s.id === "rework",
  );

  expect(groups).toHaveLength(1);
  expect(groups[0].sessions.map((s) => s.id)).toEqual([
    "review",
    "rework",
    "needs",
    "branch",
    "wait",
  ]);
});

test("issueNumber == null never groups", () => {
  const e = epic("/r", 100, [101]);
  const epics = { [key("/r", 100)]: e };
  const active = new Set([key("/r", 100)]);

  const s = session("nullish", "/r", null);
  const { groups, rest } = groupSessionsByEpic([s], epics, active, {}, () => false, now);
  expect(groups).toHaveLength(0);
  expect(rest.map((x) => x.id)).toEqual(["nullish"]);
});

test("rest preserves input order and is not flattened/reordered", () => {
  const e = epic("/r", 100, [101]);
  const epics = { [key("/r", 100)]: e };
  const active = new Set([key("/r", 100)]);

  // non-members in a deliberate order, interleaved with a member
  const x = session("x", "/r", 999, "idle", true); // ready non-member
  const member = session("member", "/r", 101);
  const y = session("y", "/r", null, "running"); // active non-member

  const { groups, rest } = groupSessionsByEpic([x, member, y], epics, active, {}, () => false, now);

  expect(groups).toHaveLength(1);
  // rest keeps input order x, y (NOT lifecycle-sorted, which would put y before x)
  expect(rest.map((s) => s.id)).toEqual(["x", "y"]);
});
