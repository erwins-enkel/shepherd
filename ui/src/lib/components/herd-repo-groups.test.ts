import { test, expect } from "vitest";
import { repoKeyFn, groupByRepo } from "./herd-repo-groups";
import { herdStatusOf, countHerdStatuses, HERD_STATUS_ORDER } from "./herd-status";
import type { HerdStatus, HerdStatusCtx } from "./herd-status";
import type { Session, GitState, SessionStatus } from "#lib/types.js";

function session(
  id: string,
  repoPath: string,
  status: SessionStatus = "idle",
  over: Partial<Session> = {},
): Session {
  return {
    id,
    repoPath,
    status,
    readyToMerge: false,
    mergingSince: null,
    ...over,
  } as Session;
}

const MAC = { instanceId: "m1", name: "Mac", platform: "macos" };
const green: GitState = {
  kind: "github",
  state: "open",
  checks: "success",
  deployConfigured: false,
};

test("local sessions key by repoPath; sections sort alphabetically by name", () => {
  const sessions = [
    session("a", "/w/zeta"),
    session("b", "/w/Alpha"),
    session("c", "/w/community-map"),
    session("d", "/w/zeta"),
  ];
  const groups = groupByRepo(sessions, repoKeyFn(sessions));
  expect(groups.map((g) => g.name)).toEqual(["Alpha", "community-map", "zeta"]);
  expect(groups.map((g) => g.key)).toEqual(["/w/Alpha", "/w/community-map", "/w/zeta"]);
  expect(groups[2]!.sessions.map((s) => s.id)).toEqual(["a", "d"]);
  expect(groups[2]!.iconPath).toBe("/w/zeta");
});

test("a section keeps its sessions in input (stage) order", () => {
  const ordered = [session("s3", "/w/x"), session("s1", "/w/y"), session("s2", "/w/x")];
  const groups = groupByRepo(ordered, repoKeyFn(ordered));
  expect(groups.find((g) => g.key === "/w/x")!.sessions.map((s) => s.id)).toEqual(["s3", "s2"]);
});

test("same-name checkouts stay separate sections, ordered by key", () => {
  const sessions = [session("a", "/w/forks/shep"), session("b", "/w/shep")];
  const groups = groupByRepo(sessions, repoKeyFn(sessions));
  expect(groups.map((g) => g.key)).toEqual(["/w/forks/shep", "/w/shep"]);
});

test("a mirrored session joins the same-name local section, else its own", () => {
  const local = [session("l", "/home/me/shepherd")];
  const joining = session("r1", "/Users/them/shepherd", "idle", { host: MAC });
  const alone = session("r2", "/Users/them/atlas", "idle", { host: MAC });
  const keyOf = repoKeyFn(local);
  expect(keyOf(joining)).toBe("/home/me/shepherd");
  expect(keyOf(alone)).toBe("remote:atlas");
  const groups = groupByRepo([...local, joining, alone], keyOf);
  expect(groups.map((g) => [g.name, g.iconPath, g.sessions.length])).toEqual([
    ["atlas", null, 1],
    ["shepherd", "/home/me/shepherd", 2],
  ]);
});

test("repo heading counts add up to the top-bar tally under every status filter", () => {
  const ctx: HerdStatusCtx = {
    git: { merge1: green, merge2: green, shelvedGreen: green },
    isReviewing: () => false,
    isReworkRunning: () => false,
    workingBlocked: { latched: true },
    backgroundBusy: {},
    now: 0,
  };
  const all = [
    session("run", "/w/a", "running"),
    session("latched", "/w/a", "blocked"),
    session("idle", "/w/a", "idle"),
    session("merge1", "/w/b", "done"),
    session("merge2", "/w/a", "idle"),
    session("blocked", "/w/b", "blocked"),
    session("doneNoPr", "/w/b", "done"),
    session("shelvedGreen", "/w/c", "idle", { shelved: true }),
    session("shelvedRun", "/w/c", "running", { shelved: true }),
    // an epic child renders in its group above but still counts in its repo heading
    session("epicChild", "/w/c", "idle", { issueNumber: 7 }),
    session("remoteMerge", "/x/b", "done", { host: MAC, git: green }),
    session("remoteRun", "/x/d", "running", { host: MAC }),
  ];
  const topBar = countHerdStatuses(all, ctx);
  const filters: (HerdStatus | null)[] = [null, ...HERD_STATUS_ORDER];
  for (const filter of filters) {
    const listed = filter ? all.filter((s) => herdStatusOf(s, ctx) === filter) : all;
    const groups = groupByRepo(listed, repoKeyFn(listed));
    const summed = { running: 0, idle: 0, blocked: 0, merge: 0 };
    for (const g of groups) {
      const c = countHerdStatuses(g.sessions, ctx);
      for (const st of HERD_STATUS_ORDER) summed[st] += c[st];
    }
    for (const st of filter ? [filter] : HERD_STATUS_ORDER)
      expect(summed[st], `${st} under filter ${filter}`).toBe(topBar[st]);
  }
  expect(topBar).toEqual({ running: 4, idle: 2, blocked: 1, merge: 3 });
});
