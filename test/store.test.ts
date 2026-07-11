import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionStore } from "../src/store";
import type { PrReview, Recap, ReviewVerdict, SessionLaunchMetadata } from "../src/types";
import type { SessionUsage } from "../src/usage";

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

test("session agentProvider defaults to claude and round-trips codex", () => {
  const s = mk();
  const claude = s.create(base);
  expect(claude.agentProvider).toBe("claude");
  expect(s.get(claude.id)?.agentProvider).toBe("claude");

  const codex = s.create({ ...base, herdrAgentId: "term_codex", agentProvider: "codex" });
  expect(codex.agentProvider).toBe("codex");
  expect(s.get(codex.id)?.agentProvider).toBe("codex");
});

test("session providerSessionId: defaults '', accepts create input, set via setProviderSessionId", () => {
  const s = mk();
  const a = s.create(base);
  expect(a.providerSessionId).toBe("");
  expect(s.get(a.id)?.providerSessionId).toBe("");

  const b = s.create({ ...base, herdrAgentId: "t2", providerSessionId: "rollout-uuid" });
  expect(b.providerSessionId).toBe("rollout-uuid");
  expect(s.get(b.id)?.providerSessionId).toBe("rollout-uuid");

  s.setProviderSessionId(a.id, "captured-uuid");
  expect(s.get(a.id)?.providerSessionId).toBe("captured-uuid");
});

test("session providerSessionId: update() preserves it when absent from patch, resets when passed", () => {
  const s = mk();
  const a = s.create({ ...base, providerSessionId: "keep-me" });
  // a patch that doesn't mention providerSessionId leaves it intact
  s.update(a.id, { status: "archived", lastState: "done" });
  expect(s.get(a.id)?.providerSessionId).toBe("keep-me");
  // an explicit reset (relaunch path) clears it
  s.update(a.id, { providerSessionId: "" });
  expect(s.get(a.id)?.providerSessionId).toBe("");
});

test("session launchMetadata persists and legacy rows hydrate as null", () => {
  const s = mk();
  const launchMetadata = {
    sourceKind: "user",
    prompt: "inspect the upload",
    issue: { number: 7, title: "Broken", url: "https://example.test/7" },
    attachments: [
      {
        submittedName: "design.png",
        launchedName: "design.png",
        dropped: false,
        storedName: "uuid.png",
      },
    ],
    branch: {
      baseBranch: "main",
      workBranch: "shepherd/repo-flatten",
      sharedCheckout: false,
    },
    uiState: {
      researchChecked: false,
      planGateChecked: true,
      autopilotChecked: true,
    },
    submittedChoices: {
      planGateOverride: true,
      autopilotOverride: true,
      sandboxProfile: "autonomous",
      model: "opus",
      effort: "high",
    },
    resolvedLaunch: {
      research: false,
      planGateOptIn: true,
      autopilotOptIn: true,
      storedModel: "opus",
      effort: "high",
      sandboxApplied: "autonomous",
      sandboxDegraded: false,
      egressApplied: true,
      egressDegraded: false,
    },
    agent: {
      provider: "claude",
      model: "opus",
      effort: "high",
    },
  } satisfies SessionLaunchMetadata;

  const modern = s.create({ ...base, launchMetadata });
  expect(s.get(modern.id)?.launchMetadata).toEqual(launchMetadata);

  const legacy = s.create({ ...base, herdrAgentId: "term_legacy" });
  expect(s.get(legacy.id)?.launchMetadata).toBeNull();
});

test("session migration: an old sessions row without providerSessionId gains the '' default", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-sess-migrate-"));
  const dbPath = join(dir, "test.db");
  try {
    // Pre-create the sessions table as it was BEFORE the providerSessionId column.
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, desig TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
      repoPath TEXT NOT NULL, baseBranch TEXT NOT NULL, branch TEXT,
      worktreePath TEXT NOT NULL, isolated INTEGER NOT NULL,
      herdrSession TEXT NOT NULL, herdrAgentId TEXT NOT NULL,
      claudeSessionId TEXT NOT NULL DEFAULT '',
      agentProvider TEXT NOT NULL DEFAULT 'claude',
      model TEXT, effort TEXT, status TEXT NOT NULL, lastState TEXT NOT NULL,
      auto INTEGER NOT NULL DEFAULT 0, issueNumber INTEGER,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER)`);
    raw.run(
      `INSERT INTO sessions (id, desig, name, prompt, repoPath, baseBranch, branch, worktreePath,
        isolated, herdrSession, herdrAgentId, status, lastState, createdAt, updatedAt)
       VALUES ('old', 'TASK-01', 'n', 'p', '/r', 'main', 'shepherd/n', '/wt', 1, 'default', 't',
        'running', 'idle', 1, 1)`,
    );
    raw.close();
    // opening through the store runs migrateSessionColumns, adding providerSessionId with its default
    const store = new SessionStore(dbPath);
    expect(store.get("old")?.providerSessionId).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update can replace a session's agent identity without changing the row", () => {
  const s = mk();
  const orig = s.create({ ...base, claudeSessionId: "claude-old", model: "opus" });

  s.update(orig.id, {
    herdrAgentId: "term_codex",
    claudeSessionId: "",
    agentProvider: "codex",
    model: "gpt-5.5",
    status: "running",
    lastState: "idle",
    planGateEnabled: false,
    planPhase: null,
  });

  const got = s.get(orig.id)!;
  expect(got.id).toBe(orig.id);
  expect(got.worktreePath).toBe(orig.worktreePath);
  expect(got.herdrAgentId).toBe("term_codex");
  expect(got.claudeSessionId).toBe("");
  expect(got.agentProvider).toBe("codex");
  expect(got.model).toBe("gpt-5.5");
  expect(got.planGateEnabled).toBe(false);
  expect(got.planPhase).toBeNull();
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

test("recentSessionCountsByRepo counts sessions per repo within the window", () => {
  const s = mk();
  s.create({ ...base, repoPath: "/a", herdrAgentId: "t1" });
  s.create({ ...base, repoPath: "/b", herdrAgentId: "t2" });
  s.create({ ...base, repoPath: "/b", herdrAgentId: "t3" });
  s.create({ ...base, repoPath: "/b", herdrAgentId: "t4" });
  const counts = s.recentSessionCountsByRepo(0);
  expect(counts["/a"]).toBe(1);
  expect(counts["/b"]).toBe(3);
  // A future `since` excludes every session — the window bound is applied.
  expect(s.recentSessionCountsByRepo(Date.now() + 60_000)["/b"]).toBeUndefined();
});

test("repo_config: defaults to critic on + auto-address off + learnings on, persists toggles", () => {
  const store = new SessionStore(":memory:");
  // absent → critic on, learnings on, auto-address off (the spendier loop is explicit opt-in)
  expect(store.getRepoConfig("/repo/a")).toEqual({
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    hidden: false,
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
  });
  store.setRepoConfig("/repo/a", {
    criticEnabled: false,
    criticAllPrs: false,
    autoAddressEnabled: true,
    learningsEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    hidden: false,
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "tab",
  });
  expect(store.getRepoConfig("/repo/a")).toEqual({
    criticEnabled: false,
    criticAllPrs: false,
    autoAddressEnabled: true,
    learningsEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    hidden: false,
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "tab",
  });
  store.setRepoConfig("/repo/a", {
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: true,
    signoffAuthority: "critic",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    hidden: false,
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
  });
  expect(store.getRepoConfig("/repo/a")).toEqual({
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: true,
    signoffAuthority: "critic",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    hidden: false,
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
  });
});

test("repo_config: drain fields default off/cap-1/default-label/ceiling-80, persist round-trip", () => {
  const store = new SessionStore(":memory:");
  expect(store.getRepoConfig("/repo/d")).toMatchObject({
    autoDrainEnabled: false,
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
  });
  store.setRepoConfig("/repo/d", {
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: true,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 3,
    autoLabel: "auto-go",
    usageCeilingPct: 65,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    hidden: false,
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
  });
  expect(store.getRepoConfig("/repo/d")).toMatchObject({
    autoDrainEnabled: true,
    maxAuto: 3,
    autoLabel: "auto-go",
    usageCeilingPct: 65,
  });
});

test("repo_config: defaultModel defaults to 'inherit', persists an explicit override round-trip", () => {
  const store = new SessionStore(":memory:");
  expect(store.getRepoConfig("/repo/m").defaultModel).toBe("inherit");
  const cfg = store.getRepoConfig("/repo/m");
  store.setRepoConfig("/repo/m", { ...cfg, defaultModel: "opus" });
  expect(store.getRepoConfig("/repo/m").defaultModel).toBe("opus");
  // an unrecognised stored value normalises back to "inherit" on read
  store.setRepoConfig("/repo/m", { ...cfg, defaultModel: "bogus" });
  expect(store.getRepoConfig("/repo/m").defaultModel).toBe("inherit");
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
    streakReviews: 2,
    reviewedPatchIds: ["pid-old", "pid-abc"],
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

test("reviews: dismissed round-trips; legacy rows default falsy", () => {
  const store = new SessionStore(":memory:");
  const v = {
    sessionId: "s1",
    headSha: "abc",
    patchId: "pid",
    decision: "changes_requested" as const,
    summary: "",
    body: "",
    findings: ["f"],
    addressRound: 3,
    addressCap: 3,
    streakReviews: 1,
    reviewedPatchIds: [],
    errorRound: 0,
    finalRoundPending: false,
    finalRoundTimeoutMs: 900_000,
    seenNoteIds: [],
    updatedAt: 1,
  };
  store.putReview(v);
  expect(store.getReview("s1")?.dismissed).toBeFalsy();
  store.putReview({ ...v, dismissed: true, updatedAt: 2 });
  expect(store.getReview("s1")?.dismissed).toBe(true);
  expect(store.snapshotReviews().s1!.dismissed).toBe(true);
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
  expect(r?.streakReviews).toBe(0); // backfilled to the migration default
  expect(r?.reviewedPatchIds).toEqual([]); // backfilled to '[]'
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
    streakReviews: 2,
    reviewedPatchIds: ["pid-1"],
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
    streakReviews: 0,
    reviewedPatchIds: [],
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

test("unarchive clears archivedAt to null", () => {
  const s = mk();
  const a = s.create(base);
  s.archive(a.id);
  expect(s.get(a.id)?.archivedAt).toBeGreaterThan(0);
  s.unarchive(a.id);
  expect(s.get(a.id)?.archivedAt).toBeNull();
  // status stays archived (finishResumeSpawn updates it separately)
  expect(s.get(a.id)?.status).toBe("archived");
});

test("unarchive is a no-op for an already-null archivedAt (legacy row)", () => {
  const s = mk();
  const a = s.create(base);
  // legacy: status flipped without stamping archivedAt
  s.update(a.id, { status: "archived" });
  expect(s.get(a.id)?.archivedAt).toBeNull();
  s.unarchive(a.id); // must not throw
  expect(s.get(a.id)?.archivedAt).toBeNull();
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

const recap = (sessionId: string, over: Partial<Recap> = {}): Recap => ({
  sessionId,
  state: "ready",
  headSha: "sha",
  base: "",
  verdict: "ready",
  headline: "done",
  body: "",
  openItems: [],
  changedFiles: [],
  spawnSessionId: "spawn",
  cwd: "/tmp",
  model: null,
  spawnedAt: 1,
  generatedAt: 2,
  updatedAt: 2,
  ...over,
});

test("listRecentlyArchived: only archived sessions with archivedAt >= cutoff, newest-first", async () => {
  const s = mk();
  // a running (never-archived) session must be excluded regardless of cutoff
  s.create({ ...base, herdrAgentId: "live" });
  const old = s.create({ ...base, herdrAgentId: "old" });
  s.archive(old.id);
  await sleep(5);
  const cutoff = Date.now();
  await sleep(2);
  const mid = s.create({ ...base, herdrAgentId: "mid" });
  s.archive(mid.id);
  await sleep(2);
  const recent = s.create({ ...base, herdrAgentId: "recent" });
  s.archive(recent.id);

  const got = s.listRecentlyArchived(cutoff);
  // old archived (before cutoff) and the live row are both excluded; newest-first ordering
  expect(got.map((x) => x.id)).toEqual([recent.id, mid.id]);
});

test("pruneArchivedSessions: cascades the victim's recap, keeps survivor's", async () => {
  const s = mk();
  const victim = s.create({ ...base, herdrAgentId: "tv" });
  s.archive(victim.id);
  await sleep(2);
  const keep = s.create({ ...base, herdrAgentId: "tk" });
  s.archive(keep.id);
  s.putRecap(recap(victim.id, { changedFiles: ["a.ts"] }));
  s.putRecap(recap(keep.id, { changedFiles: ["b.ts"] }));
  const removed = s.pruneArchivedSessions({ maxAgeMs: YEAR_MS, keepNewest: 1 });
  expect(removed).toBe(1);
  expect(s.getRecap(victim.id)).toBeNull(); // recap pruned with the session
  expect(s.getRecap(keep.id)).not.toBeNull(); // survivor's recap intact
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

test("repo config: autoMergeEnabled defaults false and round-trips", () => {
  const store = new SessionStore(":memory:");
  expect(store.getRepoConfig("/r").autoMergeEnabled).toBe(false);
  const cfg = store.getRepoConfig("/r");
  store.setRepoConfig("/r", { ...cfg, autoMergeEnabled: true });
  expect(store.getRepoConfig("/r").autoMergeEnabled).toBe(true);
});

test("repo config: buildQueueEnabled defaults false and round-trips", () => {
  const store = new SessionStore(":memory:");
  expect(store.getRepoConfig("/r").buildQueueEnabled).toBe(false);
  const cfg = store.getRepoConfig("/r");
  store.setRepoConfig("/r", { ...cfg, buildQueueEnabled: true });
  expect(store.getRepoConfig("/r").buildQueueEnabled).toBe(true);
});

test("repo config: sandboxProfile defaults trusted on a fresh DB", () => {
  const store = new SessionStore(":memory:");
  expect(store.getRepoConfig("/r").sandboxProfile).toBe("trusted");
});

test("repo config: sandboxProfile round-trips through set/get", () => {
  const store = new SessionStore(":memory:");
  const cfg = store.getRepoConfig("/r");
  store.setRepoConfig("/r", { ...cfg, sandboxProfile: "autonomous" });
  expect(store.getRepoConfig("/r").sandboxProfile).toBe("autonomous");
  store.setRepoConfig("/r", { ...cfg, sandboxProfile: "standard" });
  expect(store.getRepoConfig("/r").sandboxProfile).toBe("standard");
});

test("repo config: a garbage stored sandboxProfile falls back to trusted", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-sandbox-"));
  const dbPath = join(dir, "test.db");
  try {
    // Seed the row through a real store, then scribble a garbage value directly.
    const store = new SessionStore(dbPath);
    const cfg = store.getRepoConfig("/r");
    store.setRepoConfig("/r", { ...cfg, sandboxProfile: "standard" });
    const raw = new Database(dbPath);
    raw.run(`UPDATE repo_config SET sandboxProfile = 'bogus' WHERE repoPath = '/r'`);
    raw.close();
    // a fresh store reads the legacy/garbage value and the guard maps it to trusted
    expect(new SessionStore(dbPath).getRepoConfig("/r").sandboxProfile).toBe("trusted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo_config migration: an old row without sandboxProfile gains the trusted default", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-migrate-"));
  const dbPath = join(dir, "test.db");
  try {
    // Pre-create a minimal repo_config table predating the sandboxProfile column.
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE repo_config (
      repoPath TEXT PRIMARY KEY, criticEnabled INTEGER NOT NULL DEFAULT 1,
      updatedAt INTEGER NOT NULL)`);
    raw.run(`INSERT INTO repo_config (repoPath, criticEnabled, updatedAt) VALUES ('/old', 1, 1)`);
    raw.close();
    // opening through the store runs migrateRepoConfigColumns, adding the column with its default
    const store = new SessionStore(dbPath);
    expect(store.getRepoConfig("/old").sandboxProfile).toBe("trusted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo_config migration: an old row without previewOpenMode gains the ask default", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-preview-mode-migrate-"));
  const dbPath = join(dir, "test.db");
  try {
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE repo_config (
      repoPath TEXT PRIMARY KEY, criticEnabled INTEGER NOT NULL DEFAULT 1,
      updatedAt INTEGER NOT NULL)`);
    raw.run(`INSERT INTO repo_config (repoPath, criticEnabled, updatedAt) VALUES ('/old', 1, 1)`);
    raw.close();
    const store = new SessionStore(dbPath);
    expect(store.getRepoConfig("/old").previewOpenMode).toBe("ask");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo_config: invalid previewOpenMode hydrates to ask", () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...store.getRepoConfig("/repo"), previewOpenMode: "inline" });
  (store as unknown as { db: import("bun:sqlite").Database }).db.run(
    `UPDATE repo_config SET previewOpenMode = 'sideways' WHERE repoPath = '/repo'`,
  );
  expect(store.getRepoConfig("/repo").previewOpenMode).toBe("ask");
});

test("session: sandboxApplied/sandboxDegraded default null/false, set via setSandboxState, round-trip", () => {
  const s = mk();
  const a = s.create(base);
  expect(a.sandboxApplied).toBeNull();
  expect(a.sandboxDegraded).toBe(false);
  expect(s.get(a.id)?.sandboxApplied).toBeNull();
  expect(s.get(a.id)?.sandboxDegraded).toBe(false);
  s.setSandboxState(a.id, { applied: "autonomous", degraded: true });
  expect(s.get(a.id)?.sandboxApplied).toBe("autonomous");
  expect(s.get(a.id)?.sandboxDegraded).toBe(true);
  // partial patch leaves the untouched field intact
  s.setSandboxState(a.id, { degraded: false });
  expect(s.get(a.id)?.sandboxApplied).toBe("autonomous");
  expect(s.get(a.id)?.sandboxDegraded).toBe(false);
  // clearing applied back to null
  s.setSandboxState(a.id, { applied: null });
  expect(s.get(a.id)?.sandboxApplied).toBeNull();
});

test("session: create accepts sandboxApplied/sandboxDegraded inputs and survives hydrate", () => {
  const s = mk();
  const a = s.create({ ...base, sandboxApplied: "standard", sandboxDegraded: true });
  expect(a.sandboxApplied).toBe("standard");
  expect(a.sandboxDegraded).toBe(true);
  expect(s.get(a.id)?.sandboxApplied).toBe("standard");
  expect(s.get(a.id)?.sandboxDegraded).toBe(true);
});

test("session: egressApplied/egressDegraded default false, round-trip via create", () => {
  const s = mk();
  const a = s.create(base);
  expect(a.egressApplied).toBe(false);
  expect(a.egressDegraded).toBe(false);
  expect(s.get(a.id)?.egressApplied).toBe(false);
  expect(s.get(a.id)?.egressDegraded).toBe(false);
  const b = s.create({ ...base, herdrAgentId: "t2", egressApplied: true, egressDegraded: true });
  expect(b.egressApplied).toBe(true);
  expect(b.egressDegraded).toBe(true);
  expect(s.get(b.id)?.egressApplied).toBe(true);
  expect(s.get(b.id)?.egressDegraded).toBe(true);
});

test("session: setSandboxState patches egressApplied/egressDegraded without disturbing sandboxApplied/sandboxDegraded", () => {
  const s = mk();
  const a = s.create({ ...base, sandboxApplied: "autonomous", sandboxDegraded: false });
  s.setSandboxState(a.id, { egressApplied: true, egressDegraded: false });
  const r1 = s.get(a.id)!;
  expect(r1.sandboxApplied).toBe("autonomous"); // untouched
  expect(r1.sandboxDegraded).toBe(false); // untouched
  expect(r1.egressApplied).toBe(true);
  expect(r1.egressDegraded).toBe(false);
  // patch egressDegraded only
  s.setSandboxState(a.id, { egressDegraded: true });
  const r2 = s.get(a.id)!;
  expect(r2.egressApplied).toBe(true); // untouched
  expect(r2.egressDegraded).toBe(true);
  expect(r2.sandboxApplied).toBe("autonomous"); // still untouched
});

test("session: legacy row (egressApplied/egressDegraded columns defaulting 0) reads as false", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-egress-legacy-"));
  const dbPath = join(dir, "test.db");
  try {
    // Seed a DB without the egress columns, simulating a pre-feature DB.
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, desig TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
      repoPath TEXT NOT NULL, baseBranch TEXT NOT NULL, branch TEXT,
      worktreePath TEXT NOT NULL, isolated INTEGER NOT NULL,
      herdrSession TEXT NOT NULL, herdrAgentId TEXT NOT NULL,
      claudeSessionId TEXT NOT NULL DEFAULT '',
      model TEXT, status TEXT NOT NULL, lastState TEXT NOT NULL,
      auto INTEGER NOT NULL DEFAULT 0, issueNumber INTEGER,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER)`);
    raw.run(
      `INSERT INTO sessions (id, desig, name, prompt, repoPath, baseBranch, worktreePath, isolated, herdrSession, herdrAgentId, status, lastState, createdAt, updatedAt)
       VALUES ('leg1', 'TASK-01', 'n', 'p', '/r', 'main', '/wt', 1, 'h', 't', 'running', 'idle', 1, 1)`,
    );
    raw.close();
    const store = new SessionStore(dbPath);
    const s = store.get("leg1")!;
    expect(s.egressApplied).toBe(false);
    expect(s.egressDegraded).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo_config: egressExtraHosts round-trips through set/get", () => {
  const store = new SessionStore(":memory:");
  expect(store.getRepoConfig("/r").egressExtraHosts).toEqual([]);
  const cfg = store.getRepoConfig("/r");
  store.setRepoConfig("/r", { ...cfg, egressExtraHosts: ["registry.npmjs.org"] });
  expect(store.getRepoConfig("/r").egressExtraHosts).toEqual(["registry.npmjs.org"]);
  store.setRepoConfig("/r", { ...cfg, egressExtraHosts: ["a.example.com", "b.example.com"] });
  expect(store.getRepoConfig("/r").egressExtraHosts).toEqual(["a.example.com", "b.example.com"]);
});

test("repo_config: egressExtraHosts missing/null in DB → []", () => {
  const store = new SessionStore(":memory:");
  // No row → default []
  expect(store.getRepoConfig("/missing").egressExtraHosts).toEqual([]);
});

test("repo_config: invalid JSON in egressExtraHosts column → []", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-egress-json-"));
  const dbPath = join(dir, "test.db");
  try {
    const store = new SessionStore(dbPath);
    const cfg = store.getRepoConfig("/r");
    store.setRepoConfig("/r", { ...cfg, egressExtraHosts: ["pkg.example.com"] });
    // Scribble invalid JSON directly into the column.
    const raw = new Database(dbPath);
    raw.run(`UPDATE repo_config SET egressExtraHosts = 'NOT_JSON' WHERE repoPath = '/r'`);
    raw.close();
    expect(new SessionStore(dbPath).getRepoConfig("/r").egressExtraHosts).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session: research defaults false, round-trips via create + get", () => {
  const s = mk();
  // absent → false
  const a = s.create(base);
  expect(a.research).toBe(false);
  expect(s.get(a.id)?.research).toBe(false);
  // explicitly true → true
  const b = s.create({ ...base, herdrAgentId: "t2", research: true });
  expect(b.research).toBe(true);
  expect(s.get(b.id)?.research).toBe(true);
  // explicitly false → false
  const c = s.create({ ...base, herdrAgentId: "t3", research: false });
  expect(c.research).toBe(false);
  expect(s.get(c.id)?.research).toBe(false);
});

test("session: research migration — pre-existing row without column reads as false", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-research-legacy-"));
  const dbPath = join(dir, "test.db");
  try {
    // Seed a DB without the research column, simulating a pre-feature DB.
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, desig TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
      repoPath TEXT NOT NULL, baseBranch TEXT NOT NULL, branch TEXT,
      worktreePath TEXT NOT NULL, isolated INTEGER NOT NULL,
      herdrSession TEXT NOT NULL, herdrAgentId TEXT NOT NULL,
      claudeSessionId TEXT NOT NULL DEFAULT '',
      model TEXT, status TEXT NOT NULL, lastState TEXT NOT NULL,
      auto INTEGER NOT NULL DEFAULT 0, issueNumber INTEGER,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER)`);
    raw.run(
      `INSERT INTO sessions (id, desig, name, prompt, repoPath, baseBranch, worktreePath, isolated, herdrSession, herdrAgentId, status, lastState, createdAt, updatedAt)
       VALUES ('leg1', 'TASK-01', 'n', 'p', '/r', 'main', '/wt', 1, 'h', 't', 'running', 'idle', 1, 1)`,
    );
    raw.close();
    const store = new SessionStore(dbPath);
    const s = store.get("leg1")!;
    expect(s.research).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session: landingRepair defaults false, round-trips via create + get", () => {
  const s = mk();
  // absent → false
  const a = s.create(base);
  expect(a.landingRepair).toBe(false);
  expect(s.get(a.id)?.landingRepair).toBe(false);
  // explicitly true → true
  const b = s.create({ ...base, herdrAgentId: "t2", landingRepair: true });
  expect(b.landingRepair).toBe(true);
  expect(s.get(b.id)?.landingRepair).toBe(true);
  // explicitly false → false
  const c = s.create({ ...base, herdrAgentId: "t3", landingRepair: false });
  expect(c.landingRepair).toBe(false);
  expect(s.get(c.id)?.landingRepair).toBe(false);
});

test("session: landingRepair migration — pre-existing row without column reads as false", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-landingrepair-legacy-"));
  const dbPath = join(dir, "test.db");
  try {
    // Seed a DB without the landingRepair column, simulating a pre-feature DB.
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, desig TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
      repoPath TEXT NOT NULL, baseBranch TEXT NOT NULL, branch TEXT,
      worktreePath TEXT NOT NULL, isolated INTEGER NOT NULL,
      herdrSession TEXT NOT NULL, herdrAgentId TEXT NOT NULL,
      claudeSessionId TEXT NOT NULL DEFAULT '',
      model TEXT, status TEXT NOT NULL, lastState TEXT NOT NULL,
      auto INTEGER NOT NULL DEFAULT 0, issueNumber INTEGER,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER)`);
    raw.run(
      `INSERT INTO sessions (id, desig, name, prompt, repoPath, baseBranch, worktreePath, isolated, herdrSession, herdrAgentId, status, lastState, createdAt, updatedAt)
       VALUES ('leg1', 'TASK-01', 'n', 'p', '/r', 'main', '/wt', 1, 'h', 't', 'running', 'idle', 1, 1)`,
    );
    raw.close();
    const store = new SessionStore(dbPath);
    const s = store.get("leg1")!;
    expect(s.landingRepair).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session: autoMergeEnabled override + rebase count round-trip", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(base);
  expect(s.autoMergeEnabled).toBeNull();
  expect(s.autoMergeRebaseCount).toBe(0);
  store.setAutoMergeState(s.id, { enabled: true });
  expect(store.get(s.id)!.autoMergeEnabled).toBe(true);
  store.setAutoMergeState(s.id, { rebaseCount: 3 });
  expect(store.get(s.id)!.autoMergeRebaseCount).toBe(3);
  // rebaseHead round-trip: string then null
  expect(s.autoMergeRebaseHead).toBeNull();
  store.setAutoMergeState(s.id, { rebaseHead: "deadbeef" });
  expect(store.get(s.id)!.autoMergeRebaseHead).toBe("deadbeef");
  store.setAutoMergeState(s.id, { rebaseHead: null });
  expect(store.get(s.id)!.autoMergeRebaseHead).toBeNull();
});

test("desig: no reuse after prune — counter is strictly monotonic", async () => {
  const s = mk();
  const a = s.create(base);
  expect(a.desig).toBe("TASK-01");
  s.archive(a.id);
  // negative maxAgeMs makes cutoff land in the future → the just-archived row is within the age
  // window AND keepNewest:0 evicts it by rank; confirm it's gone
  const removed = s.pruneArchivedSessions({ maxAgeMs: -Number.MAX_SAFE_INTEGER, keepNewest: 0 });
  expect(removed).toBe(1);
  expect(s.get(a.id)).toBeNull();
  // pre-fix: COUNT(*) would drop to 0 → next desig is TASK-01 again (collision)
  const b = s.create({ ...base, herdrAgentId: "term_2" });
  expect(b.desig).toBe("TASK-02");
});

test("desig: seed from pre-existing DB high-water mark", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-seed-"));
  const dbPath = join(dir, "test.db");
  try {
    // Pre-populate a raw DB with desig='TASK-09' so the seed subquery finds max=9.
    // Use the full sessions schema so migrateSessionColumns + INSERT in create() work.
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, desig TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
      repoPath TEXT NOT NULL, baseBranch TEXT NOT NULL, branch TEXT,
      worktreePath TEXT NOT NULL, isolated INTEGER NOT NULL,
      herdrSession TEXT NOT NULL, herdrAgentId TEXT NOT NULL,
      claudeSessionId TEXT NOT NULL DEFAULT '',
      model TEXT, status TEXT NOT NULL, lastState TEXT NOT NULL,
      auto INTEGER NOT NULL DEFAULT 0, issueNumber INTEGER,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER)`);
    raw.run(
      `INSERT INTO sessions (id, desig, name, prompt, repoPath, baseBranch, worktreePath, isolated, herdrSession, herdrAgentId, status, lastState, createdAt, updatedAt)
       VALUES ('s1', 'TASK-09', 'old', 'old', '/r', 'main', '/wt', 1, 'default', 'term_0', 'archived', 'idle', 1, 1)`,
    );
    raw.close();

    const store = new SessionStore(dbPath);
    const s = store.create(base);
    expect(s.desig).toBe("TASK-10");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── first-run classification migration (see src/first-run.ts) ───────────────
// :memory: is discarded on close, so the boot-2/pre-existing cases (which need to reopen the
// *same* db to observe run-once idempotency) use a temp file db instead.

test("first-run migration: new install boot-1 runs the migration but leaves firstRunResolved unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-firstrun-boot1-"));
  const dbPath = join(dir, "test.db");
  try {
    const store = new SessionStore(dbPath);
    expect(store.getSetting("firstRunResolved")).toBeNull();
    expect(store.getSetting("firstRunMigrated")).toBe("1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-run migration: boot-2 after auth secrets exist does NOT retroactively resolve — regression guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-firstrun-boot2-"));
  const dbPath = join(dir, "test.db");
  try {
    // Boot 1: fresh, empty DB — the migration runs, sees nothing pre-existing, and stamps only
    // firstRunMigrated (not firstRunResolved).
    const boot1 = new SessionStore(dbPath);
    expect(boot1.getSetting("firstRunResolved")).toBeNull();
    // Simulate bootstrapAuth seeding secrets on this same boot, AFTER the migration already ran.
    boot1.setSetting("cookieSecret", "secret");
    boot1.setSetting("passwordHash", "hash");
    // Boot 2: reopen the same db. A per-boot (rather than run-once) stamp would see these
    // secrets and wrongly mark firstRunResolved here — the bug this migration exists to avoid.
    const boot2 = new SessionStore(dbPath);
    expect(boot2.getSetting("firstRunResolved")).toBeNull();
    expect(boot2.getSetting("firstRunMigrated")).toBe("1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-run migration: pre-existing settings (cookieSecret) before first construction marks resolved", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-firstrun-preexisting-settings-"));
  const dbPath = join(dir, "test.db");
  try {
    // Raw-seed the settings table BEFORE any SessionStore is ever constructed over this file,
    // modeling a pre-feature DB that already had auth bootstrapped.
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    raw.run(`INSERT INTO settings (key, value) VALUES ('cookieSecret', 'preexisting-secret')`);
    raw.close();
    const store = new SessionStore(dbPath);
    expect(store.getSetting("firstRunResolved")).toBe("1");
    expect(store.getSetting("firstRunMigrated")).toBe("1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-run migration: pre-existing session row (no settings) before first construction marks resolved", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-firstrun-preexisting-session-"));
  const dbPath = join(dir, "test.db");
  try {
    // Raw-seed a sessions row BEFORE any SessionStore is ever constructed, modeling a
    // pre-feature DB with existing session history but no settings rows at all.
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, desig TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
      repoPath TEXT NOT NULL, baseBranch TEXT NOT NULL, branch TEXT,
      worktreePath TEXT NOT NULL, isolated INTEGER NOT NULL,
      herdrSession TEXT NOT NULL, herdrAgentId TEXT NOT NULL,
      claudeSessionId TEXT NOT NULL DEFAULT '',
      model TEXT, status TEXT NOT NULL, lastState TEXT NOT NULL,
      auto INTEGER NOT NULL DEFAULT 0, issueNumber INTEGER,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER)`);
    raw.run(
      `INSERT INTO sessions (id, desig, name, prompt, repoPath, baseBranch, worktreePath, isolated, herdrSession, herdrAgentId, status, lastState, createdAt, updatedAt)
       VALUES ('leg1', 'TASK-01', 'n', 'p', '/r', 'main', '/wt', 1, 'h', 't', 'running', 'idle', 1, 1)`,
    );
    raw.close();
    const store = new SessionStore(dbPath);
    expect(store.getSetting("firstRunResolved")).toBe("1");
    expect(store.getSetting("firstRunMigrated")).toBe("1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── reviewer spawn cost attribution ──────────────────────────────────────────
const usage = (over: Partial<SessionUsage> = {}): SessionUsage => ({
  input: 10,
  output: 20,
  cacheRead: 30,
  cacheWrite: 40,
  total: 100,
  messageCount: 1,
  lastActivity: 123,
  byModel: {},
  fullRecaches: 0,
  sidechainCount: 0,
  ...over,
});

test("recordReviewerSpawn then listReviewerSpawns returns the row with NULL token/completed fields", () => {
  const s = mk();
  s.recordReviewerSpawn({
    reviewerSessionId: "rev-1",
    taskSessionId: "task-1",
    kind: "review",
    worktreePath: "/rev-wt",
    reviewerProvider: null,
    model: null,
    reviewerEffort: null,
    spawnedAt: 1000,
  });
  const rows = s.listReviewerSpawns();
  expect(rows.length).toBe(1);
  expect(rows[0]).toEqual({
    reviewerSessionId: "rev-1",
    taskSessionId: "task-1",
    kind: "review",
    worktreePath: "/rev-wt",
    reviewerProvider: null,
    model: null,
    reviewerEffort: null,
    spawnedAt: 1000,
    completedAt: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
  });
});

test("recordReviewerSpawn persists reviewer provider and effort", () => {
  const s = mk();
  s.recordReviewerSpawn({
    reviewerSessionId: "rev-1",
    taskSessionId: "task-1",
    kind: "plan_gate",
    worktreePath: "/rev-wt",
    reviewerProvider: "codex",
    model: "gpt-5.5",
    reviewerEffort: "high",
    spawnedAt: 1000,
  });
  expect(s.listReviewerSpawns()[0]).toMatchObject({
    reviewerProvider: "codex",
    model: "gpt-5.5",
    reviewerEffort: "high",
  });
});

test("completeReviewerSpawn fills token totals + completedAt", () => {
  const s = mk();
  s.recordReviewerSpawn({
    reviewerSessionId: "rev-1",
    taskSessionId: "task-1",
    kind: "plan_gate",
    worktreePath: "/rev-wt",
    model: "opus",
    spawnedAt: 1000,
  });
  s.completeReviewerSpawn("rev-1", usage(), 2000);
  const row = s.listReviewerSpawns()[0]!;
  expect(row.completedAt).toBe(2000);
  expect(row.inputTokens).toBe(10);
  expect(row.outputTokens).toBe(20);
  expect(row.cacheReadTokens).toBe(30);
  expect(row.cacheWriteTokens).toBe(40);
  expect(row.totalTokens).toBe(100);
  expect(row.model).toBe("opus");
});

test("completeReviewerSpawn backfills the true model from the transcript when spawn-time was auto (null)", () => {
  const s = mk();
  s.recordReviewerSpawn({
    reviewerSessionId: "rev-1",
    taskSessionId: "task-1",
    kind: "review",
    worktreePath: "/rev-wt",
    model: null, // auto — unknown at spawn
    spawnedAt: 1000,
  });
  s.completeReviewerSpawn(
    "rev-1",
    usage({ byModel: { "claude-opus-4-8": 80, "claude-haiku-4-5": 20 } }),
    2000,
  );
  // dominant model (most tokens) backfilled onto the previously-null column
  expect(s.listReviewerSpawns()[0]!.model).toBe("claude-opus-4-8");
});

test("completeReviewerSpawn keeps the recorded model when the transcript yielded none (COALESCE)", () => {
  const s = mk();
  s.recordReviewerSpawn({
    reviewerSessionId: "rev-1",
    taskSessionId: "task-1",
    kind: "review",
    worktreePath: "/rev-wt",
    model: "sonnet",
    spawnedAt: 1000,
  });
  s.completeReviewerSpawn("rev-1", usage({ byModel: {} }), 2000); // empty usage → no model
  expect(s.listReviewerSpawns()[0]!.model).toBe("sonnet");
});

test("completeReviewerSpawn ignores the 'unknown' model sentinel: a real model wins, sentinel never overwrites", () => {
  const s = mk();
  s.recordReviewerSpawn({
    reviewerSessionId: "rev-real",
    taskSessionId: "task-1",
    kind: "review",
    worktreePath: "/rev-wt",
    model: null,
    spawnedAt: 1000,
  });
  // sentinel has more tokens but must lose to the real model
  s.completeReviewerSpawn("rev-real", usage({ byModel: { unknown: 90, sonnet: 10 } }), 2000);
  expect(s.listReviewerSpawns().find((r) => r.reviewerSessionId === "rev-real")!.model).toBe(
    "sonnet",
  );

  // sentinel-only usage must NOT overwrite a previously-recorded model
  s.recordReviewerSpawn({
    reviewerSessionId: "rev-sentinel",
    taskSessionId: "task-1",
    kind: "review",
    worktreePath: "/rev-wt",
    model: "opus",
    spawnedAt: 1000,
  });
  s.completeReviewerSpawn("rev-sentinel", usage({ byModel: { unknown: 100 } }), 2000);
  expect(s.listReviewerSpawns().find((r) => r.reviewerSessionId === "rev-sentinel")!.model).toBe(
    "opus",
  );
});

test("pruneReviewerSpawns deletes only rows older than beforeTs, returns the count", () => {
  const s = mk();
  for (const [id, ts] of [
    ["old-1", 100],
    ["old-2", 200],
    ["new-1", 500],
  ] as const) {
    s.recordReviewerSpawn({
      reviewerSessionId: id,
      taskSessionId: "task-1",
      kind: "review",
      worktreePath: "/rev-wt",
      model: null,
      spawnedAt: ts,
    });
  }
  const removed = s.pruneReviewerSpawns(300);
  expect(removed).toBe(2);
  const remaining = s.listReviewerSpawns();
  expect(remaining.map((r) => r.reviewerSessionId)).toEqual(["new-1"]);
});

test("reviewer_spawns survive task archive + prune (the load-bearing guarantee)", () => {
  const s = mk();
  const task = s.create(base);
  s.recordReviewerSpawn({
    reviewerSessionId: "rev-1",
    taskSessionId: task.id,
    kind: "review",
    worktreePath: "/rev-wt",
    model: null,
    spawnedAt: 1000,
  });
  s.archive(task.id);
  const removed = s.pruneArchivedSessions({ maxAgeMs: 0, keepNewest: 0 });
  expect(removed).toBe(1);
  expect(s.get(task.id)).toBeNull(); // task evicted
  const rows = s.listReviewerSpawns();
  expect(rows.length).toBe(1); // but the cost-attribution fact outlives it
  expect(rows[0]!.reviewerSessionId).toBe("rev-1");
  expect(rows[0]!.taskSessionId).toBe(task.id);
});

// ── criticAllPrs ─────────────────────────────────────────────────────────────

test("repo_config: criticAllPrs defaults false for an unconfigured repo", () => {
  const store = new SessionStore(":memory:");
  expect(store.getRepoConfig("/repo/a").criticAllPrs).toBe(false);
});

test("repo_config: criticAllPrs round-trips true and false", () => {
  const store = new SessionStore(":memory:");
  const cfg = store.getRepoConfig("/repo/a");
  store.setRepoConfig("/repo/a", { ...cfg, criticAllPrs: true });
  expect(store.getRepoConfig("/repo/a").criticAllPrs).toBe(true);
  store.setRepoConfig("/repo/a", { ...cfg, criticAllPrs: false });
  expect(store.getRepoConfig("/repo/a").criticAllPrs).toBe(false);
});

test("repo_config: criticAllPrs toggle doesn't disturb other fields", () => {
  const store = new SessionStore(":memory:");
  const before = {
    ...store.getRepoConfig("/repo/a"),
    criticEnabled: false,
    learningsEnabled: false,
    autoDrainEnabled: true,
    maxAuto: 5,
    autoLabel: "go",
  };
  store.setRepoConfig("/repo/a", before);
  store.setRepoConfig("/repo/a", { ...store.getRepoConfig("/repo/a"), criticAllPrs: true });
  const after = store.getRepoConfig("/repo/a");
  expect(after.criticAllPrs).toBe(true);
  expect(after.criticEnabled).toBe(false);
  expect(after.learningsEnabled).toBe(false);
  expect(after.autoDrainEnabled).toBe(true);
  expect(after.maxAuto).toBe(5);
  expect(after.autoLabel).toBe("go");
});

test("repo_config migration: old DB without criticAllPrs gains the default-0 column", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-criticallprs-"));
  const dbPath = join(dir, "test.db");
  try {
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE repo_config (
      repoPath TEXT PRIMARY KEY, criticEnabled INTEGER NOT NULL DEFAULT 1,
      updatedAt INTEGER NOT NULL)`);
    raw.run(`INSERT INTO repo_config (repoPath, criticEnabled, updatedAt) VALUES ('/old', 1, 1)`);
    raw.close();
    const store = new SessionStore(dbPath);
    expect(store.getRepoConfig("/old").criticAllPrs).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── pr_reviews ────────────────────────────────────────────────────────────────

function prReview(over: Partial<PrReview> = {}): PrReview {
  return {
    repoPath: "/repo/x",
    prNumber: 42,
    headSha: "abc123",
    patchId: "pid-abc",
    decision: "changes_requested",
    reviewedPatchIds: ["pid-old", "pid-abc"],
    updatedAt: 1000,
    ...over,
  };
}

test("pr_reviews: getPrReview returns null when absent", () => {
  const store = new SessionStore(":memory:");
  expect(store.getPrReview("/repo/x", 42)).toBeNull();
});

test("pr_reviews: putPrReview then getPrReview round-trips all fields incl. reviewedPatchIds array", () => {
  const store = new SessionStore(":memory:");
  const r = prReview();
  store.putPrReview(r);
  expect(store.getPrReview("/repo/x", 42)).toEqual(r);
});

test("pr_reviews: putPrReview upserts — second put on same key updates, doesn't duplicate", () => {
  const store = new SessionStore(":memory:");
  store.putPrReview(prReview());
  const updated = prReview({ headSha: "def456", decision: "commented", updatedAt: 2000 });
  store.putPrReview(updated);
  expect(store.getPrReview("/repo/x", 42)).toEqual(updated);
});

test("pr_reviews: bumpPrReviewHead changes only headSha + updatedAt", () => {
  const store = new SessionStore(":memory:");
  const r = prReview();
  store.putPrReview(r);
  store.bumpPrReviewHead("/repo/x", 42, "newhead", 9999);
  expect(store.getPrReview("/repo/x", 42)).toEqual({ ...r, headSha: "newhead", updatedAt: 9999 });
});

test("pr_reviews: bumpPrReviewHead is a no-op when row doesn't exist", () => {
  const store = new SessionStore(":memory:");
  store.bumpPrReviewHead("/repo/x", 42, "newhead", 9999);
  expect(store.getPrReview("/repo/x", 42)).toBeNull();
});

test("pr_reviews: rows for different (repoPath, prNumber) are independent", () => {
  const store = new SessionStore(":memory:");
  const a = prReview({ repoPath: "/repo/a", prNumber: 1, headSha: "sha-a" });
  const b = prReview({ repoPath: "/repo/b", prNumber: 2, headSha: "sha-b" });
  store.putPrReview(a);
  store.putPrReview(b);
  expect(store.getPrReview("/repo/a", 1)?.headSha).toBe("sha-a");
  expect(store.getPrReview("/repo/b", 2)?.headSha).toBe("sha-b");
});

test("getCreditSnapshot returns null on a fresh store", () => {
  const store = mk();
  expect(store.getCreditSnapshot()).toBeNull();
});

test("putCreditSnapshot round-trips exact values", () => {
  const store = mk();
  const row = {
    spent: 4.2,
    cap: 25,
    currency: "USD",
    pct: 17,
    resetAt: 1_700_000_000_000,
    scrapedAt: 1_699_000_000_000,
  };
  store.putCreditSnapshot(row);
  expect(store.getCreditSnapshot()).toEqual(row);
});

test("putCreditSnapshot overwrites latest (single row wins)", () => {
  const store = mk();
  store.putCreditSnapshot({
    spent: 4.2,
    cap: 25,
    currency: "USD",
    pct: 17,
    resetAt: 1_700_000_000_000,
    scrapedAt: 1_699_000_000_000,
  });
  const next = {
    spent: 9.99,
    cap: 50,
    currency: "EUR",
    pct: 20,
    resetAt: 1_710_000_000_000,
    scrapedAt: 1_709_000_000_000,
  };
  store.putCreditSnapshot(next);
  expect(store.getCreditSnapshot()).toEqual(next);
});

test("putCreditSnapshot round-trips a null resetAt as null", () => {
  const store = mk();
  const row = {
    spent: 1,
    cap: 10,
    currency: "USD",
    pct: 10,
    resetAt: null,
    scrapedAt: 1_699_000_000_000,
  };
  store.putCreditSnapshot(row);
  const got = store.getCreditSnapshot();
  expect(got).toEqual(row);
  expect(got!.resetAt).toBeNull();
});

test("mergeTrainPrs: absent → null, array round-trips, empty array round-trips", () => {
  const store = new SessionStore(":memory:");
  // absent → null
  const plain = store.create(base);
  expect(plain.mergeTrainPrs).toBeNull();

  // array round-trips
  const withPrs = store.create({ ...base, herdrAgentId: "t2", mergeTrainPrs: [1, 2, 3] });
  expect(store.get(withPrs.id)!.mergeTrainPrs).toEqual([1, 2, 3]);

  // empty array round-trips as [] (not null)
  const empty = store.create({ ...base, herdrAgentId: "t3", mergeTrainPrs: [] });
  expect(store.get(empty.id)!.mergeTrainPrs).toEqual([]);
});

test("mergingPrNumber: defaults null, set via update, clears back to null", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(base);
  expect(s.mergingPrNumber).toBeNull();

  store.update(s.id, { mergingPrNumber: 42 });
  expect(store.get(s.id)!.mergingPrNumber).toBe(42);

  store.update(s.id, { mergingPrNumber: null });
  expect(store.get(s.id)!.mergingPrNumber).toBeNull();
});

test("parseMergeTrainPrsJson: non-number elements treated as corrupt → null", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-mtp-"));
  const dbPath = join(dir, "test.db");
  try {
    const store = new SessionStore(dbPath);
    const s = store.create({ ...base, herdrAgentId: "mtp1" });
    // inject a corrupt value: JSON array of strings, not numbers
    const raw = new Database(dbPath);
    raw.run(`UPDATE sessions SET mergeTrainPrs = '["a"]' WHERE id = ?`, [s.id]);
    raw.close();
    expect(new SessionStore(dbPath).get(s.id)!.mergeTrainPrs).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ackManualSteps stamps manualStepsAckedAt and is idempotent (first ack wins) — #1060", () => {
  const s = mk();
  const a = s.create(base);
  expect(s.get(a.id)!.manualStepsAckedAt).toBeNull();

  s.ackManualSteps(a.id);
  const first = s.get(a.id)!.manualStepsAckedAt;
  expect(first).not.toBeNull();

  // Re-ack is a durable no-op: COALESCE keeps the original ack time.
  s.ackManualSteps(a.id);
  expect(s.get(a.id)!.manualStepsAckedAt).toBe(first);
});
