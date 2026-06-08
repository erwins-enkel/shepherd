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

test("repo config autopilotEnabled defaults off and round-trips", () => {
  const store = freshStore();
  expect(store.getRepoConfig("/repo").autopilotEnabled).toBe(false);
  store.setRepoConfig("/repo", {
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: true,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
  });
  expect(store.getRepoConfig("/repo").autopilotEnabled).toBe(true);
});
