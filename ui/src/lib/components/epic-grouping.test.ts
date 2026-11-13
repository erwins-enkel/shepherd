import { test, expect } from "vitest";
import {
  groupSessionsByEpic as groupSessionsByEpicRaw,
  remoteEpicKey,
  sessionlessEpicGroups,
  withRemoteEpics,
} from "./epic-grouping";
import type {
  DrainStatus,
  Session,
  GitState,
  Epic,
  EpicChild,
  RemoteEpic,
  SessionStatus,
} from "#lib/types.js";

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

test("a shelved epic child stays in rest (renders in the Shelved group)", () => {
  const s = { ...session("s1", "/r", 11), shelved: true };
  const out = groupSessionsByEpic(
    [s],
    { [key("/r", 10)]: epic("/r", 10, [11]) },
    new Set([key("/r", 10)]),
    {},
    () => false,
    0,
  );
  expect(out.groups).toHaveLength(0);
  expect(out.rest.map((x) => x.id)).toEqual(["s1"]);
});

// ── #3814: active epics without a child session ──────────────────────────────────────────────

const none: ReadonlySet<string> = new Set();

function sessionless(
  sessions: Session[],
  epics: Record<string, Epic>,
  repoFilter: ReadonlySet<string> = none,
  completedKeys: ReadonlySet<string> = none,
) {
  return sessionlessEpicGroups(
    sessions,
    epics,
    new Set(Object.keys(epics)),
    repoFilter,
    completedKeys,
  );
}

test("a member-less active epic still forms no groupSessionsByEpic group (the rail adds no rows)", () => {
  const epics = { [key("/r", 100)]: epic("/r", 100, [101]) };
  const out = groupSessionsByEpic([], epics, new Set([key("/r", 100)]), {}, () => false, now);
  expect(out.groups).toEqual([]);
});

test("sessionless: running and paused active epics without a child session form empty groups", () => {
  const paused = epic("/r", 200, [201]);
  paused.run = { ...paused.run, status: "paused" };
  const epics = { [key("/r", 100)]: epic("/r", 100, [101]), [key("/r", 200)]: paused };
  const out = sessionless([session("other", "/r", 999)], epics);
  expect(out.map((g) => g.key)).toEqual([key("/r", 100), key("/r", 200)]);
  expect(out.every((g) => g.sessions.length === 0)).toBe(true);
  expect(out[0].epic).toBe(epics[key("/r", 100)]);
});

test("sessionless: only keys in activeEpicKeys with a loaded record qualify", () => {
  const epics = {
    [key("/r", 100)]: epic("/r", 100, [101]),
    [key("/r", 200)]: epic("/r", 200, [201]),
  };
  const out = sessionlessEpicGroups(
    [],
    epics,
    new Set([key("/r", 100), key("/r", 300)]), // #300 has no record yet, #200 is not active
    none,
    none,
  );
  expect(out.map((g) => g.key)).toEqual([key("/r", 100)]);
});

test("sessionless: idle, all-merged and completed epics never show", () => {
  const idle = epic("/r", 100, [101]);
  idle.run = { ...idle.run, status: "idle" };
  const merged = epic("/r", 200, [201, 202]);
  merged.children = merged.children.map((c) => ({ ...c, state: "merged" }));
  const completed = epic("/r", 300, [301]);
  const out = sessionless(
    [],
    { [key("/r", 100)]: idle, [key("/r", 200)]: merged, [key("/r", 300)]: completed },
    none,
    new Set([key("/r", 300)]),
  );
  expect(out).toEqual([]);
});

test("sessionless: any session of a child suppresses the group — plain, shelved or experiment member", () => {
  const epics = {
    [key("/r", 100)]: epic("/r", 100, [101]),
    [key("/r", 200)]: epic("/r", 200, [201]),
    [key("/r", 300)]: epic("/r", 300, [301]),
    [key("/r", 400)]: epic("/r", 400, [401]),
  };
  const shelved = { ...session("s", "/r", 201), shelved: true };
  const variant = {
    ...session("v", "/r", 301),
    experimentId: "exp",
    experimentRole: "variant" as const,
  };
  const out = sessionless([session("p", "/r", 101), shelved, variant], epics);
  expect(out.map((g) => g.key)).toEqual([key("/r", 400)]);
});

test("sessionless: a session matching only the parent number or another repo does not count", () => {
  const epics = { [key("/r", 100)]: epic("/r", 100, [101]) };
  const out = sessionless([session("parent", "/r", 100), session("x", "/other", 101)], epics);
  expect(out.map((g) => g.key)).toEqual([key("/r", 100)]);
});

test("sessionless: the repo filter scopes the groups (empty filter = all repos)", () => {
  const epics = { [key("/a", 1)]: epic("/a", 1, [2]), [key("/b", 1)]: epic("/b", 1, [2]) };
  expect(sessionless([], epics).map((g) => g.key)).toEqual([key("/a", 1), key("/b", 1)]);
  expect(sessionless([], epics, new Set(["/b"])).map((g) => g.key)).toEqual([key("/b", 1)]);
});

test("sessionless: ordered by repo basename then parent number, like the member groups", () => {
  const epics = {
    [key("/x/zeta", 5)]: epic("/x/zeta", 5, [6]),
    [key("/y/alpha", 9)]: epic("/y/alpha", 9, [10]),
    [key("/y/alpha", 3)]: epic("/y/alpha", 3, [4]),
  };
  expect(sessionless([], epics).map((g) => g.key)).toEqual([
    key("/y/alpha", 3),
    key("/y/alpha", 9),
    key("/x/zeta", 5),
  ]);
});

// A session the drain sent to another machine for an epic child (`child.elsewhere`) is mirrored
// back here with the remote checkout's repoPath — it joins its epic by the dispatch record.
const MAC = { instanceId: "mac-1", name: "macbook", platform: "macos" };
function mirroredSession(id: string, issueNumber: number | null, host = MAC): Session {
  return { ...session(id, "/Users/x/repo", issueNumber), host };
}
function epicSentTo(childNumber: number, sessionId: string | null, host = MAC): Epic {
  const e = epic("/r", 100, [childNumber, childNumber + 1]);
  e.children[0] = {
    ...e.children[0],
    elsewhere: { host, sessionId, prNumber: null },
  };
  return e;
}

test("mirrored: a session the drain sent for a child joins its epic group, not mirroredRest", () => {
  const epics = { [key("/r", 100)]: epicSentTo(101, "remote-1") };
  const local = session("local", "/r", 102);
  const remote = mirroredSession("remote-1", 101);
  const loose = mirroredSession("remote-2", 7);
  const out = groupSessionsByEpicRaw(
    [local],
    epics,
    new Set([key("/r", 100)]),
    {},
    () => false,
    () => false,
    now,
    [remote, loose],
  );
  expect(out.groups).toHaveLength(1);
  expect(out.groups[0].sessions.map((s) => s.id).sort()).toEqual(["local", "remote-1"]);
  expect(out.rest).toEqual([]);
  expect(out.mirroredRest.map((s) => s.id)).toEqual(["remote-2"]);
});

test("mirrored: a mirrored session alone forms its epic group", () => {
  const epics = { [key("/r", 100)]: epicSentTo(101, "remote-1") };
  const out = groupSessionsByEpicRaw(
    [],
    epics,
    new Set([key("/r", 100)]),
    {},
    () => false,
    () => false,
    now,
    [mirroredSession("remote-1", 101)],
  );
  expect(out.groups.map((g) => g.key)).toEqual([key("/r", 100)]);
  expect(out.groups[0].sessions.map((s) => s.id)).toEqual(["remote-1"]);
  expect(out.mirroredRest).toEqual([]);
});

test("mirrored: no match on another machine, an unconfirmed start, a shelved row or an inactive epic", () => {
  const other = { instanceId: "other-1", name: "studio", platform: "macos" };
  const run = (e: Epic, s: Session, active = new Set([key("/r", 100)])) =>
    groupSessionsByEpicRaw(
      [],
      { [key("/r", 100)]: e },
      active,
      {},
      () => false,
      () => false,
      now,
      [s],
    );
  // same session id, reported by another machine
  expect(run(epicSentTo(101, "remote-1"), mirroredSession("remote-1", 101, other)).groups).toEqual(
    [],
  );
  // start not confirmed yet: no session id to match
  expect(run(epicSentTo(101, null), mirroredSession("remote-1", 101)).groups).toEqual([]);
  // shelved renders in the Shelved group, like a local child
  const shelved = { ...mirroredSession("remote-1", 101), shelved: true };
  expect(run(epicSentTo(101, "remote-1"), shelved).mirroredRest).toEqual([shelved]);
  // the epic is not active
  expect(
    run(epicSentTo(101, "remote-1"), mirroredSession("remote-1", 101), new Set()).groups,
  ).toEqual([]);
});

test("mirrored: a mirrored member is staged by the PR state its machine reports", () => {
  const epics = { [key("/r", 100)]: epicSentTo(101, "remote-1") };
  const ready = session("a", "/r", 102, "idle", true);
  // still "running" by status: only its machine's merged PR state moves it past the ready row
  const merged = { ...mirroredSession("remote-1", 101, MAC), git: git("merged") };
  const out = groupSessionsByEpicRaw(
    [ready],
    epics,
    new Set([key("/r", 100)]),
    {},
    () => false,
    () => false,
    now,
    [merged],
  );
  // merged sits after ready (STAGE_ORDER) — read off the mirrored session's own git
  expect(out.groups[0].sessions.map((s) => s.id)).toEqual(["a", "remote-1"]);
});

test("sessionless: an epic whose child runs as a listed mirrored session is not session-less", () => {
  const epics = { [key("/r", 100)]: epicSentTo(101, "remote-1") };
  const active = new Set([key("/r", 100)]);
  expect(sessionlessEpicGroups([], epics, active, none, none).map((g) => g.key)).toEqual([
    key("/r", 100),
  ]);
  expect(
    sessionlessEpicGroups([], epics, active, none, none, [mirroredSession("remote-1", 101)]),
  ).toEqual([]);
  // a mirrored session the epic did not send does not count
  expect(
    sessionlessEpicGroups([], epics, active, none, none, [mirroredSession("remote-9", 101)]).map(
      (g) => g.key,
    ),
  ).toEqual([key("/r", 100)]);
});

// ── An epic a connected machine's drain leads (remote epic) ──────────────────────────────────

const LINUX = { instanceId: "linux-1", name: "studio", platform: "linux" };
function remoteEpic(childNumbers: number[], host = LINUX): RemoteEpic {
  return {
    ...epic("/home/u/repo", 50, childNumbers),
    host,
    connection: { state: "connected", since: 1 },
    drain: { repoPath: "/home/u/repo", epicParent: 50 } as DrainStatus,
  };
}
function remoteChild(id: string, issueNumber: number, host = LINUX): Session {
  return { ...session(id, "/home/u/repo", issueNumber), host };
}
function groupWithRemote(
  local: Session[],
  mirrored: Session[],
  ownEpics: Record<string, Epic> = {},
  remote: RemoteEpic[] = [remoteEpic([51, 52])],
) {
  const merged = withRemoteEpics(ownEpics, new Set(Object.keys(ownEpics)), remote);
  return groupSessionsByEpicRaw(
    local,
    merged.epics,
    merged.keys,
    {},
    () => false,
    () => false,
    now,
    mirrored,
  );
}

test("remote epic: keyed by machine, checkout and parent; merged into the active keys", () => {
  const e = remoteEpic([51]);
  expect(remoteEpicKey(e)).toBe("remote:linux-1:/home/u/repo#50");
  const own = { [key("/r", 100)]: epic("/r", 100, [101]) };
  const merged = withRemoteEpics(own, new Set([key("/r", 100)]), [e]);
  expect([...merged.keys]).toEqual([key("/r", 100), remoteEpicKey(e)]);
  expect(merged.epics[remoteEpicKey(e)]).toBe(e);
});

test("remote epic: groups its machine's mirrored children by host + repoPath + issue", () => {
  const out = groupWithRemote(
    [],
    [remoteChild("a", 51), remoteChild("b", 52), remoteChild("c", 9)],
  );
  expect(out.groups.map((g) => g.key)).toEqual(["remote:linux-1:/home/u/repo#50"]);
  expect(out.groups[0].sessions.map((s) => s.id).sort()).toEqual(["a", "b"]);
  expect(out.mirroredRest.map((s) => s.id)).toEqual(["c"]);
});

test("remote epic: the same issue from another machine or another checkout does not group", () => {
  const other = { instanceId: "other-1", name: "mini", platform: "macos" };
  const elsewhere = { ...remoteChild("b", 51), repoPath: "/srv/repo" };
  const out = groupWithRemote([], [remoteChild("a", 51, other), elsewhere]);
  expect(out.groups).toEqual([]);
  expect(out.mirroredRest.map((s) => s.id)).toEqual(["a", "b"]);
});

test("remote epic: a local session with identical repoPath + issue is not pulled in", () => {
  const local = session("local", "/home/u/repo", 51);
  const out = groupWithRemote([local], []);
  expect(out.groups).toEqual([]);
  expect(out.rest).toEqual([local]);
});

test("remote epic: a session this Shepherd's drain sent stays with its own epic", () => {
  // the Mac's own epic claimed this mirrored session for its child 101 (`elsewhere`)
  const own = { [key("/r", 100)]: epicSentTo(101, "sent", LINUX) };
  const sent = remoteChild("sent", 51);
  const out = groupWithRemote([], [sent], own);
  expect(out.groups.map((g) => [g.key, g.sessions.map((s) => s.id)])).toEqual([
    [key("/r", 100), ["sent"]],
  ]);
});

test("remote epic: a shelved mirrored child stays out", () => {
  const shelved = { ...remoteChild("a", 51), shelved: true };
  const out = groupWithRemote([], [shelved]);
  expect(out.groups).toEqual([]);
  expect(out.mirroredRest).toEqual([shelved]);
});

test("sessionless: a remote epic is session-less until a child from its machine is listed", () => {
  const e = remoteEpic([51]);
  const merged = withRemoteEpics({}, new Set(), [e]);
  const run = (local: Session[], mirrored: Session[]) =>
    sessionlessEpicGroups(local, merged.epics, merged.keys, none, none, mirrored).map((g) => g.key);
  expect(run([], [])).toEqual([remoteEpicKey(e)]);
  // a local session with the same checkout path + issue, or another machine's, does not list it
  const other = { instanceId: "other-1", name: "mini", platform: "macos" };
  expect(run([session("l", "/home/u/repo", 51)], [remoteChild("x", 51, other)])).toEqual([
    remoteEpicKey(e),
  ]);
  expect(run([], [remoteChild("a", 51)])).toEqual([]);
  // a repo filter names this Shepherd's paths: the caller filters remote epics by slug instead
  expect(
    sessionlessEpicGroups([], merged.epics, merged.keys, new Set(["/r"]), none, []).map(
      (g) => g.key,
    ),
  ).toEqual([remoteEpicKey(e)]);
});

test("remote epic: a child it sent to a third machine groups it once, never also session-less", () => {
  // Linux leads the epic and sent child 51 to the MacBook; this Shepherd mirrors both.
  const e = remoteEpic([51, 52]);
  e.children[0] = {
    ...e.children[0],
    elsewhere: { host: MAC, sessionId: "on-mac", prNumber: null },
  };
  const merged = withRemoteEpics({}, new Set(), [e]);
  const onMac = mirroredSession("on-mac", 51, MAC);
  const grouped = groupSessionsByEpicRaw(
    [],
    merged.epics,
    merged.keys,
    {},
    () => false,
    () => false,
    now,
    [onMac],
  );
  expect(grouped.groups.map((g) => [g.key, g.sessions.map((s) => s.id)])).toEqual([
    [remoteEpicKey(e), ["on-mac"]],
  ]);
  expect(sessionlessEpicGroups([], merged.epics, merged.keys, none, none, [onMac])).toEqual([]);
});

// ── #3016: integrated work leaves its epic group ─────────────────────────────────────────────
// Epic #3016's view: MacBook TASK-145/146 (PRs #3955/#3973, merged into the epic branch by the
// leading drain) sat among the epic's running sessions with a MERGED badge. A session whose own PR
// is the one its epic integrated is merged work — it goes to the lifecycle groups (Merged), with a
// note. Anything short of that proof keeps it where it was.

function mergedGit(number: number, state: GitState["state"] = "merged"): GitState {
  return { ...git(state), number };
}

/** Epic #100 whose child 101 ran on the Mac as `sessionId`, integrated with PR `integratedPr`. */
function integratedEpic(
  sessionId: string,
  integratedPr: number | null | undefined,
  over: Partial<EpicChild> = {},
): Epic {
  const e = epicSentTo(101, sessionId);
  e.children[0] = {
    ...e.children[0],
    state: "merged",
    ...(integratedPr !== undefined && { integratedPrNumber: integratedPr }),
    ...over,
  };
  return e;
}

const group = (sessions: Session[], epics: Record<string, Epic>, mirrored: Session[] = []) =>
  groupSessionsByEpicRaw(
    sessions,
    epics,
    new Set(Object.keys(epics)),
    {},
    () => false,
    () => false,
    now,
    mirrored,
  );

test("integrated: a mirrored child whose PR the epic integrated leaves the group, noted", () => {
  const epics = {
    [key("/r", 100)]: integratedEpic("remote-1", 3955, {
      remoteSettle: { host: MAC, sessionId: "remote-1", reason: "busy" },
    }),
  };
  const mac = { ...mirroredSession("remote-1", 101), git: mergedGit(3955) };
  const out = group([session("local-102", "/r", 102)], epics, [mac]);
  expect(out.groups[0].sessions.map((s) => s.id)).toEqual(["local-102"]);
  expect(out.mirroredRest.map((s) => s.id)).toEqual(["remote-1"]);
  expect(out.integrated.get("remote-1")).toEqual({
    parentIssueNumber: 100,
    host: MAC,
    settle: "busy",
  });
});

test("integrated: the same rule for a local session", () => {
  const e = epic("/r", 100, [101, 102]);
  e.children[0] = { ...e.children[0], state: "merged", integratedPrNumber: 77 };
  const epics = { [key("/r", 100)]: e };
  const done = session("local-101", "/r", 101, "done");
  const out = groupSessionsByEpicRaw(
    [done, session("local-102", "/r", 102)],
    epics,
    new Set([key("/r", 100)]),
    { "local-101": mergedGit(77) },
    () => false,
    () => false,
    now,
  );
  expect(out.rest.map((s) => s.id)).toEqual(["local-101"]);
  expect(out.integrated.get("local-101")).toEqual({
    parentIssueNumber: 100,
    host: null,
    settle: null,
  });
});

test("integrated: a child merged only by its closed issue, its PR merged into main, stays", () => {
  // deriveChildState says `merged` for a closed issue too; without an integration record for
  // this PR the session is no proof of integrated epic work.
  const epics = {
    [key("/r", 100)]: integratedEpic("remote-1", undefined, { issueClosed: true }),
  };
  const intoMain = {
    ...mirroredSession("remote-1", 101),
    git: { ...mergedGit(4000), baseRefName: "main" },
  };
  const out = group([], epics, [intoMain]);
  expect(out.groups[0].sessions.map((s) => s.id)).toEqual(["remote-1"]);
  expect(out.integrated.size).toBe(0);
});

test("integrated: another PR than the integrated one, an open PR or no known PR stays", () => {
  for (const [integratedPr, sessionGit] of [
    [3955, mergedGit(4000)], // its PR is not the one integrated
    [3955, mergedGit(3955, "open")], // the integrated PR, but this session's is not merged
    [null, mergedGit(3955)], // integrated without a recorded PR: nothing to match
  ] as const) {
    const epics = { [key("/r", 100)]: integratedEpic("remote-1", integratedPr) };
    const mac = { ...mirroredSession("remote-1", 101), git: sessionGit };
    const out = group([], epics, [mac]);
    expect(out.groups[0]?.sessions.map((s) => s.id)).toEqual(["remote-1"]);
    expect(out.integrated.size).toBe(0);
  }
});

test("integrated: the epic is session-less again once only integrated work is listed", () => {
  const epics = { [key("/r", 100)]: integratedEpic("remote-1", 3955) };
  epics[key("/r", 100)].children[1] = { ...epics[key("/r", 100)].children[1], state: "ready" };
  const mac = { ...mirroredSession("remote-1", 101), git: mergedGit(3955) };
  const active = new Set([key("/r", 100)]);
  const out = group([], epics, [mac]);
  expect(out.groups).toEqual([]);
  // same rule as the grouping: the moved session no longer lists the epic's child
  expect(
    sessionlessEpicGroups([], epics, active, none, none, [mac], new Set(out.integrated.keys())).map(
      (g) => g.key,
    ),
  ).toEqual([key("/r", 100)]);
  expect(sessionlessEpicGroups([], epics, active, none, none, [mac])).toEqual([]);
});
