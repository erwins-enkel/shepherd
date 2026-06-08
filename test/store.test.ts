import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import type { ReviewVerdict } from "../src/types";

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
    autopilotEnabled: false,
    autoDrainEnabled: false,
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
  });
  store.setRepoConfig("/repo/a", {
    criticEnabled: false,
    autoAddressEnabled: true,
    learningsEnabled: false,
    autopilotEnabled: false,
    autoDrainEnabled: false,
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
  });
  expect(store.getRepoConfig("/repo/a")).toEqual({
    criticEnabled: false,
    autoAddressEnabled: true,
    learningsEnabled: false,
    autopilotEnabled: false,
    autoDrainEnabled: false,
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
  });
  store.setRepoConfig("/repo/a", {
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    autoDrainEnabled: false,
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
  });
  expect(store.getRepoConfig("/repo/a")).toEqual({
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    autoDrainEnabled: false,
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
  });
});

test("repo_config: drain fields default off/cap-1/default-label/ceiling-80, persist round-trip", () => {
  const store = new SessionStore(":memory:");
  expect(store.getRepoConfig("/repo/d")).toMatchObject({
    autoDrainEnabled: false,
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
  });
  store.setRepoConfig("/repo/d", {
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    autoDrainEnabled: true,
    maxAuto: 3,
    autoLabel: "auto-go",
    usageCeilingPct: 65,
  });
  expect(store.getRepoConfig("/repo/d")).toMatchObject({
    autoDrainEnabled: true,
    maxAuto: 3,
    autoLabel: "auto-go",
    usageCeilingPct: 65,
  });
});

test("create: auto + issueNumber default false/null, persist when set, survive hydrate", () => {
  const s = mk();
  const a = s.create(base);
  expect(a.auto).toBe(false);
  expect(a.issueNumber).toBeNull();
  const b = s.create({ ...base, herdrAgentId: "t2", auto: true, issueNumber: 42 });
  expect(b.auto).toBe(true);
  expect(b.issueNumber).toBe(42);
  // re-read through hydrate()
  expect(s.get(b.id)?.auto).toBe(true);
  expect(s.get(b.id)?.issueNumber).toBe(42);
  expect(s.get(a.id)?.auto).toBe(false);
  expect(s.get(a.id)?.issueNumber).toBeNull();
  expect(s.list({ activeOnly: true }).find((x) => x.id === b.id)?.auto).toBe(true);
});

test("reviews: upsert + read by session, snapshot all", () => {
  const store = new SessionStore(":memory:");
  expect(store.getReview("s1")).toBeNull();
  const v = {
    sessionId: "s1",
    headSha: "abc",
    patchId: "pid-abc",
    decision: "changes_requested" as const,
    summary: "2 issues",
    body: "## findings",
    findings: ["fix the off-by-one", "handle the null case"],
    addressRound: 1,
    addressCap: 3,
    errorRound: 0,
    finalRoundPending: false,
    finalRoundTimeoutMs: 900_000,
    seenNoteIds: ["c1", "c2"],
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

test("reviews: findings/addressRound/addressCap/errorRound/seenNoteIds default when absent", () => {
  const store = new SessionStore(":memory:");
  // a verdict row written before the #247 columns existed (missing the new fields)
  store.putReview({
    sessionId: "s2",
    headSha: "abc",
    decision: "commented",
    summary: "",
    body: "",
    findings: [],
    addressRound: 0,
    updatedAt: 1,
  } as unknown as ReviewVerdict);
  const r = store.getReview("s2");
  expect(r?.findings).toEqual([]);
  expect(r?.addressRound).toBe(0);
  expect(r?.addressCap).toBe(3); // backfilled to the migration default
  expect(r?.errorRound).toBe(0);
  expect(r?.seenNoteIds).toEqual([]);
  expect(r?.patchId).toBe(""); // pre-rebase-skip rows backfill to '' (unknown → always reviews)
  expect(r?.finalRoundPending).toBe(false); // backfilled to the migration default
  expect(r?.finalRoundTimeoutMs).toBe(900_000);
});

test("bumpReviewHead: re-points head + updatedAt, leaves the verdict otherwise intact", () => {
  const store = new SessionStore(":memory:");
  const v = {
    sessionId: "s1",
    headSha: "abc",
    patchId: "pid-1",
    decision: "changes_requested" as const,
    summary: "still broken",
    body: "## findings",
    findings: ["fix the off-by-one"],
    addressRound: 2,
    addressCap: 3,
    errorRound: 0,
    finalRoundPending: false,
    finalRoundTimeoutMs: 900_000,
    seenNoteIds: ["c1"],
    url: "u",
    updatedAt: 100,
  };
  store.putReview(v);
  store.bumpReviewHead("s1", "def", 200);
  // identical-content rebase: head + clock move, everything else (incl. patchId) holds
  expect(store.getReview("s1")).toEqual({ ...v, headSha: "def", updatedAt: 200 });
});

test("putReview round-trips finalRoundPending + finalRoundTimeoutMs", () => {
  const store = new SessionStore(":memory:");
  store.putReview({
    sessionId: "s1",
    headSha: "abc",
    patchId: "",
    decision: "changes_requested",
    summary: "",
    body: "",
    findings: ["x"],
    addressRound: 3,
    addressCap: 3,
    errorRound: 0,
    finalRoundPending: true,
    finalRoundTimeoutMs: 900_000,
    seenNoteIds: [],
    updatedAt: 1,
  });
  const got = store.getReview("s1");
  expect(got?.finalRoundPending).toBe(true);
  expect(got?.finalRoundTimeoutMs).toBe(900_000);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

test("pruneArchivedSessions: count rule keeps newest N, deletes older archived", async () => {
  const s = mk();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const a = s.create({ ...base, herdrAgentId: `t${i}` });
    s.archive(a.id);
    ids.push(a.id);
    await sleep(2); // distinct archivedAt so the rank ordering is deterministic
  }
  // huge age window → only the count rule bites; keep the newest 2
  const removed = s.pruneArchivedSessions({ maxAgeMs: YEAR_MS, keepNewest: 2 });
  expect(removed).toBe(1);
  expect(s.get(ids[0]!)).toBeNull(); // oldest evicted
  expect(s.get(ids[1]!)).not.toBeNull();
  expect(s.get(ids[2]!)).not.toBeNull();
});

test("pruneArchivedSessions: age rule deletes archived older than the window (even within count)", async () => {
  const s = mk();
  const a = s.create(base);
  s.archive(a.id);
  await sleep(5);
  // 1ms window → the 5ms-old row is past it; keepNewest is generous so only age bites
  const removed = s.pruneArchivedSessions({ maxAgeMs: 1, keepNewest: 250 });
  expect(removed).toBe(1);
  expect(s.get(a.id)).toBeNull();
});

test("pruneArchivedSessions: recent archived within both limits is kept", () => {
  const s = mk();
  const a = s.create(base);
  s.archive(a.id);
  const removed = s.pruneArchivedSessions({ maxAgeMs: 30 * 24 * 60 * 60 * 1000, keepNewest: 250 });
  expect(removed).toBe(0);
  expect(s.get(a.id)).not.toBeNull();
});

test("pruneArchivedSessions: never deletes non-archived rows, however aggressive the sweep", () => {
  const s = mk();
  const a = s.create(base); // status 'running', never archived
  // keepNewest 0 + zero age window would evict every *archived* row — live rows are exempt
  const removed = s.pruneArchivedSessions({ maxAgeMs: 0, keepNewest: 0 });
  expect(removed).toBe(0);
  expect(s.get(a.id)).not.toBeNull();
});

test("pruneArchivedSessions: cascades the victim's review, keeps survivors', leaves signals", async () => {
  const s = mk();
  const victim = s.create({ ...base, herdrAgentId: "tv" });
  s.archive(victim.id);
  await sleep(2);
  const keep = s.create({ ...base, herdrAgentId: "tk" });
  s.archive(keep.id);
  const review = (sessionId: string, headSha: string) =>
    ({
      sessionId,
      headSha,
      decision: "commented",
      summary: "",
      body: "",
      findings: [],
      addressRound: 0,
      updatedAt: 1,
    }) as unknown as ReviewVerdict;
  s.putReview(review(victim.id, "a"));
  s.putReview(review(keep.id, "b"));
  s.addSignal({ repoPath: base.repoPath, sessionId: victim.id, kind: "reply", payload: "x" });
  const removed = s.pruneArchivedSessions({ maxAgeMs: YEAR_MS, keepNewest: 1 });
  expect(removed).toBe(1);
  expect(s.get(victim.id)).toBeNull();
  expect(s.getReview(victim.id)).toBeNull(); // review cascaded with the session
  expect(s.getReview(keep.id)).not.toBeNull(); // survivor's review intact
  expect(s.listSignals(base.repoPath).length).toBe(1); // signals untouched (own prune)
});

test("pruneArchivedSessions: legacy archived row with null archivedAt expires via COALESCE fallback", async () => {
  const s = mk();
  const a = s.create(base);
  // legacy path: status flipped to archived without stamping archivedAt
  s.update(a.id, { status: "archived" });
  expect(s.get(a.id)?.archivedAt).toBeNull();
  await sleep(5); // age updatedAt/createdAt past the window so the fallback rank is "old"
  const removed = s.pruneArchivedSessions({ maxAgeMs: 1, keepNewest: 250 });
  expect(removed).toBe(1);
  expect(s.get(a.id)).toBeNull();
});

function newMergeInput() {
  return {
    name: "n",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "a",
  };
}

test("merging fields default null and round-trip through update", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(newMergeInput());
  expect(s.mergingSince).toBeNull();
  expect(s.mergingTrainId).toBeNull();

  store.update(s.id, { mergingSince: 1234, mergingTrainId: "train-1" });
  const got = store.get(s.id)!;
  expect(got.mergingSince).toBe(1234);
  expect(got.mergingTrainId).toBe("train-1");

  // a later unrelated update preserves them (mirrors readyToMerge survival)
  store.update(s.id, { status: "idle" });
  const after = store.get(s.id)!;
  expect(after.mergingSince).toBe(1234);
  expect(after.mergingTrainId).toBe("train-1");

  store.update(s.id, { mergingSince: null, mergingTrainId: null });
  const cleared = store.get(s.id)!;
  expect(cleared.mergingSince).toBeNull();
  expect(cleared.mergingTrainId).toBeNull();
});
