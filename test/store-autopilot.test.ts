import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";

function freshStore(): SessionStore {
  return new SessionStore(":memory:");
}

function seed(store: SessionStore) {
  return store.create({
    name: "t",
    prompt: "p",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/t",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "term_1",
  } as any);
}

test("new sessions default autopilot off/zeroed/unpaused", () => {
  const store = freshStore();
  const s = store.get(seed(store).id)!;
  expect(s.autopilotEnabled).toBeNull();
  expect(s.autopilotStepCount).toBe(0);
  expect(s.autopilotPaused).toBe(false);
  expect(s.autopilotQuestion).toBeNull();
});

test("create honors autopilotEnabled override (false round-trips, default → null)", () => {
  const store = freshStore();
  const off = store.create({
    name: "t",
    prompt: "p",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/t-off",
    worktreePath: "/wt-off",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "term_1",
    autopilotEnabled: false,
  } as any);
  expect(store.get(off.id)!.autopilotEnabled).toBe(false);
  // default create (no override) inherits the repo default → null
  expect(store.get(seed(store).id)!.autopilotEnabled).toBeNull();
});

test("setAutopilotState patches only the given fields", () => {
  const store = freshStore();
  const id = seed(store).id;
  store.setAutopilotState(id, { enabled: true });
  expect(store.get(id)!.autopilotEnabled).toBe(true);
  store.setAutopilotState(id, { stepCount: 3, paused: true, question: "Which auth provider?" });
  let s = store.get(id)!;
  expect(s.autopilotEnabled).toBe(true); // untouched
  expect(s.autopilotStepCount).toBe(3);
  expect(s.autopilotPaused).toBe(true);
  expect(s.autopilotQuestion).toBe("Which auth provider?");
  store.setAutopilotState(id, { paused: false, question: null, stepCount: 0 });
  s = store.get(id)!;
  expect(s.autopilotPaused).toBe(false);
  expect(s.autopilotQuestion).toBeNull();
  expect(s.autopilotStepCount).toBe(0);
});

test("hydrates a pre-autopilot row with defaults", () => {
  // A row written before the autopilot columns existed: the migration backfills the
  // NOT-NULL columns to 0 and leaves the nullable ones NULL. hydrate must coerce a
  // NULL autopilotEnabled to `null` (inherit) and a NULL question to `null`.
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-"));
  const path = join(dir, "s.db");
  const store = new SessionStore(path);
  const id = seed(store).id;
  const raw = new Database(path);
  // Only the nullable columns can hold NULL on a real migrated row.
  raw.run(`UPDATE sessions SET autopilotEnabled=NULL, autopilotQuestion=NULL WHERE id=?`, [id]);
  raw.close();
  const s = new SessionStore(path).get(id)!;
  expect(s.autopilotEnabled).toBeNull(); // NULL → null (inherit repo default)
  expect(s.autopilotStepCount).toBe(0); // NOT NULL DEFAULT 0
  expect(s.autopilotPaused).toBe(false);
  expect(s.autopilotQuestion).toBeNull();
});

test("new sessions default completionRepromptCount to 0", () => {
  const store = freshStore();
  const s = store.get(seed(store).id)!;
  expect(s.completionRepromptCount).toBe(0);
});

test("setAutopilotState completionReprompt increments and resets", () => {
  const store = freshStore();
  const id = seed(store).id;
  store.setAutopilotState(id, { completionReprompt: 1 });
  expect(store.get(id)!.completionRepromptCount).toBe(1);
  store.setAutopilotState(id, { completionReprompt: 2 });
  expect(store.get(id)!.completionRepromptCount).toBe(2);
  store.setAutopilotState(id, { completionReprompt: 0 });
  expect(store.get(id)!.completionRepromptCount).toBe(0);
});

test("partial-patch: stepCount does not clobber completionRepromptCount and vice-versa", () => {
  const store = freshStore();
  const id = seed(store).id;
  store.setAutopilotState(id, { completionReprompt: 3 });
  store.setAutopilotState(id, { stepCount: 5 });
  const s = store.get(id)!;
  expect(s.autopilotStepCount).toBe(5);
  expect(s.completionRepromptCount).toBe(3); // not clobbered by stepCount patch

  store.setAutopilotState(id, { completionReprompt: 7 });
  const s2 = store.get(id)!;
  expect(s2.autopilotStepCount).toBe(5); // not clobbered by completionReprompt patch
  expect(s2.completionRepromptCount).toBe(7);
});

test("repo config autopilotEnabled defaults off and round-trips", () => {
  const store = freshStore();
  expect(store.getRepoConfig("/repo").autopilotEnabled).toBe(false);
  store.setRepoConfig("/repo", {
    criticEnabled: true,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: true,
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
    previewOpenMode: "ask",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
  });
  expect(store.getRepoConfig("/repo").autopilotEnabled).toBe(true);
});
