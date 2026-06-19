import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionStore } from "../src/store";

// ── Part A: repoMode column ────────────────────────────────────────────────

test("repoMode defaults to 'forge' for a repo with no repo_config row", () => {
  const store = new SessionStore(":memory:");
  expect(store.getRepoConfig("/repo/new").repoMode).toBe("forge");
});

test("repoMode round-trips 'lightweight' through setRepoConfig/getRepoConfig", () => {
  const store = new SessionStore(":memory:");
  const cfg = store.getRepoConfig("/repo/lw");
  store.setRepoConfig("/repo/lw", { ...cfg, repoMode: "lightweight" });
  expect(store.getRepoConfig("/repo/lw").repoMode).toBe("lightweight");
});

test("repoMode round-trips 'forge' after updating from lightweight", () => {
  const store = new SessionStore(":memory:");
  const cfg = store.getRepoConfig("/repo/fg");
  store.setRepoConfig("/repo/fg", { ...cfg, repoMode: "lightweight" });
  store.setRepoConfig("/repo/fg", { ...cfg, repoMode: "forge" });
  expect(store.getRepoConfig("/repo/fg").repoMode).toBe("forge");
});

test("migration: store opened on pre-existing DB without repoMode column yields forge default", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-lpr-test-"));
  const dbPath = join(dir, "test.db");
  try {
    // Build the old-schema DB at the file path (no repoMode column)
    const oldDb = new Database(dbPath);
    oldDb.run(`CREATE TABLE IF NOT EXISTS repo_config (
      repoPath TEXT PRIMARY KEY, criticEnabled INTEGER NOT NULL DEFAULT 1,
      criticAllPrs INTEGER NOT NULL DEFAULT 0,
      learningsEnabled INTEGER NOT NULL DEFAULT 1,
      autoDrainEnabled INTEGER NOT NULL DEFAULT 0,
      autoMergeEnabled INTEGER NOT NULL DEFAULT 0,
      maxAuto INTEGER NOT NULL DEFAULT 1,
      autoLabel TEXT NOT NULL DEFAULT 'shepherd:auto',
      usageCeilingPct INTEGER NOT NULL DEFAULT 80,
      updatedAt INTEGER NOT NULL
    )`);
    oldDb.run(
      `INSERT INTO repo_config (repoPath, criticEnabled, criticAllPrs, learningsEnabled,
        autoDrainEnabled, autoMergeEnabled, maxAuto, autoLabel, usageCeilingPct, updatedAt)
       VALUES ('/repo/old', 1, 0, 1, 0, 0, 1, 'shepherd:auto', 80, ${Date.now()})`,
    );
    oldDb.close();

    // Open via SessionStore (triggers migrations)
    const store = new SessionStore(dbPath);
    expect(store.getRepoConfig("/repo/old").repoMode).toBe("forge");

    // Opening a second time (re-running migration) must not throw
    const store2 = new SessionStore(dbPath);
    expect(store2.getRepoConfig("/repo/old").repoMode).toBe("forge");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── Part B: local_prs table ────────────────────────────────────────────────

test("ensureLocalPr creates a row with a positive number and open state", () => {
  const store = new SessionStore(":memory:");
  const pr = store.ensureLocalPr("/repo/x", "feature/abc", "main");
  expect(pr.number).toBeGreaterThan(0);
  expect(pr.repoPath).toBe("/repo/x");
  expect(pr.branch).toBe("feature/abc");
  expect(pr.base).toBe("main");
  expect(pr.state).toBe("open");
  expect(pr.createdAt).toBeGreaterThan(0);
  expect(pr.mergedAt).toBeNull();
});

test("ensureLocalPr is idempotent — same (repoPath, branch) returns same row", () => {
  const store = new SessionStore(":memory:");
  const first = store.ensureLocalPr("/repo/x", "feature/abc", "main");
  const second = store.ensureLocalPr("/repo/x", "feature/abc", "main");
  expect(second.number).toBe(first.number);
  expect(second.createdAt).toBe(first.createdAt);
  expect(second.state).toBe("open");
});

test("ensureLocalPr for two different branches returns distinct, increasing numbers", () => {
  const store = new SessionStore(":memory:");
  const a = store.ensureLocalPr("/repo/x", "feature/a", "main");
  const b = store.ensureLocalPr("/repo/x", "feature/b", "main");
  expect(b.number).toBeGreaterThan(a.number);
});

test("getLocalPr returns the row by (repoPath, branch); null for missing", () => {
  const store = new SessionStore(":memory:");
  const pr = store.ensureLocalPr("/repo/x", "feature/abc", "main");
  const found = store.getLocalPr("/repo/x", "feature/abc");
  expect(found).not.toBeNull();
  expect(found!.number).toBe(pr.number);
  expect(store.getLocalPr("/repo/x", "feature/nonexistent")).toBeNull();
});

test("getLocalPrByNumber returns the row; null for missing number", () => {
  const store = new SessionStore(":memory:");
  const pr = store.ensureLocalPr("/repo/x", "feature/abc", "main");
  const found = store.getLocalPrByNumber(pr.number);
  expect(found).not.toBeNull();
  expect(found!.branch).toBe("feature/abc");
  expect(store.getLocalPrByNumber(9999)).toBeNull();
});

test("markLocalPrMerged flips state to merged and sets mergedAt", () => {
  const store = new SessionStore(":memory:");
  const before = Date.now();
  const pr = store.ensureLocalPr("/repo/x", "feature/abc", "main");
  expect(pr.state).toBe("open");
  expect(pr.mergedAt).toBeNull();
  store.markLocalPrMerged(pr.number);
  const after = store.getLocalPrByNumber(pr.number)!;
  expect(after.state).toBe("merged");
  expect(after.mergedAt).not.toBeNull();
  expect(after.mergedAt!).toBeGreaterThanOrEqual(before);
});
