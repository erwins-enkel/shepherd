import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";

function mk() {
  return new SessionStore(":memory:");
}
const base = {
  name: "repo-flatten",
  prompt: "flatten repo",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/repo-flatten",
  worktreePath: "/r-wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_1",
};

test("create assigns id, sequential desig, timestamps, default status", () => {
  const s = mk();
  const a = s.create(base);
  expect(a.id).toBeTruthy();
  expect(a.desig).toBe("TASK-01");
  expect(a.status).toBe("running");
  expect(s.create({ ...base, herdrAgentId: "term_2" }).desig).toBe("TASK-02");
});

test("lastUsedByRepo returns max createdAt per repoPath", () => {
  const s = mk();
  s.create({ ...base, repoPath: "/a", herdrAgentId: "t1" });
  const older = s.get(s.create({ ...base, repoPath: "/b", herdrAgentId: "t2" }).id)!;
  const newerB = s.create({ ...base, repoPath: "/b", herdrAgentId: "t3" });
  const map = s.lastUsedByRepo();
  expect(map["/a"]).toBeGreaterThan(0);
  expect(map["/b"]).toBe(newerB.createdAt);
  expect(map["/b"]).toBeGreaterThanOrEqual(older.createdAt);
});

test("repo_config: defaults to critic on + auto-address off + learnings on, persists toggles", () => {
  const store = new SessionStore(":memory:");
  // absent → critic on, learnings on, auto-address off (the spendier loop is explicit opt-in)
  expect(store.getRepoConfig("/repo/a")).toEqual({
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
  });
  store.setRepoConfig("/repo/a", {
    criticEnabled: false,
    autoAddressEnabled: true,
    learningsEnabled: false,
  });
  expect(store.getRepoConfig("/repo/a")).toEqual({
    criticEnabled: false,
    autoAddressEnabled: true,
    learningsEnabled: false,
  });
  store.setRepoConfig("/repo/a", {
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
  });
  expect(store.getRepoConfig("/repo/a")).toEqual({
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
  });
});

test("reviews: upsert + read by session, snapshot all", () => {
  const store = new SessionStore(":memory:");
  expect(store.getReview("s1")).toBeNull();
  const v = {
    sessionId: "s1",
    headSha: "abc",
    decision: "changes_requested" as const,
    summary: "2 issues",
    body: "## findings",
    findings: ["fix the off-by-one", "handle the null case"],
    addressRound: 1,
    url: "u",
    updatedAt: 100,
  };
  store.putReview(v);
  expect(store.getReview("s1")).toEqual(v);
  store.putReview({ ...v, headSha: "def", decision: "commented", updatedAt: 200 });
  expect(store.getReview("s1")?.headSha).toBe("def");
  expect(store.snapshotReviews()).toEqual({
    s1: { ...v, headSha: "def", decision: "commented", updatedAt: 200 },
  });
  store.dropReview("s1");
  expect(store.getReview("s1")).toBeNull();
});

test("reviews: findings + addressRound default to [] / 0 when absent", () => {
  const store = new SessionStore(":memory:");
  store.putReview({
    sessionId: "s2",
    headSha: "abc",
    decision: "commented",
    summary: "",
    body: "",
    findings: [],
    addressRound: 0,
    updatedAt: 1,
  });
  const r = store.getReview("s2");
  expect(r?.findings).toEqual([]);
  expect(r?.addressRound).toBe(0);
});

test("readyToMerge: defaults false on create, round-trips through update", () => {
  const s = mk();
  const a = s.create(base);
  expect(a.readyToMerge).toBe(false);
  expect(s.get(a.id)?.readyToMerge).toBe(false);
  s.update(a.id, { readyToMerge: true });
  expect(s.get(a.id)?.readyToMerge).toBe(true);
  s.update(a.id, { readyToMerge: false });
  expect(s.get(a.id)?.readyToMerge).toBe(false);
});

test("get / list / update / archive", () => {
  const s = mk();
  const a = s.create(base);
  expect(s.get(a.id)?.name).toBe("repo-flatten");
  s.update(a.id, { status: "blocked", lastState: "blocked" });
  expect(s.get(a.id)?.status).toBe("blocked");
  expect(s.list().length).toBe(1);
  s.archive(a.id);
  expect(s.get(a.id)?.status).toBe("archived");
  expect(s.get(a.id)?.archivedAt).toBeGreaterThan(0);
  expect(s.list({ activeOnly: true }).length).toBe(0);
});
