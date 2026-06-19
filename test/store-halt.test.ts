import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionStore } from "../src/store";

const base = {
  name: "halt-test",
  prompt: "test session",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/halt-test",
  worktreePath: "/r-wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_1",
};

test("freshly created session has haltReason=null, haltedAt=null", () => {
  const s = new SessionStore(":memory:");
  const row = s.create(base);
  expect(row.haltReason).toBeNull();
  expect(row.haltedAt).toBeNull();
});

test("setHaltReason persists usage_limit + haltedAt", () => {
  const s = new SessionStore(":memory:");
  const row = s.create(base);
  s.setHaltReason(row.id, "usage_limit", 123);
  const got = s.get(row.id);
  expect(got?.haltReason).toBe("usage_limit");
  expect(got?.haltedAt).toBe(123);
});

test("setHaltReason with null clears halt fields (retry path)", () => {
  const s = new SessionStore(":memory:");
  const row = s.create(base);
  s.setHaltReason(row.id, "usage_limit", 123);
  s.setHaltReason(row.id, null, null);
  const got = s.get(row.id);
  expect(got?.haltReason).toBeNull();
  expect(got?.haltedAt).toBeNull();
});

test("halt fields persist across store reopen (migration + round-trip)", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-halt-test-"));
  const dbPath = join(dir, "test.db");
  try {
    const s1 = new SessionStore(dbPath);
    const row = s1.create(base);
    s1.setHaltReason(row.id, "operator", 456);

    // reopen same DB
    const s2 = new SessionStore(dbPath);
    const got = s2.get(row.id);
    expect(got?.haltReason).toBe("operator");
    expect(got?.haltedAt).toBe(456);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
