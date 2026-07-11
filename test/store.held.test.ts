import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionStore } from "../src/store";
import type { CreateSessionInput } from "../src/types";

const sampleInput: CreateSessionInput = {
  repoPath: "/home/user/myrepo",
  baseBranch: "main",
  prompt: "fix the bug",
  model: "claude-sonnet-4-5",
  images: [],
  issueRef: { number: 42, url: "https://github.com/foo/bar/issues/42", title: "Bug", body: "" },
  auto: false,
  planGateEnabled: null,
  autopilotEnabled: null,
  sandboxProfile: null,
  research: false,
  epicAuthoring: false,
  mergeTrainPrs: [],
};

test("held_tasks: listHeldTasks returns FIFO order", () => {
  const s = new SessionStore(":memory:");
  s.addHeldTask({
    id: "h1",
    repoPath: "/repo/a",
    input: sampleInput,
    createdAt: 1000,
    reason: "usage",
  });
  s.addHeldTask({
    id: "h2",
    repoPath: "/repo/b",
    input: { ...sampleInput, prompt: "second task" },
    createdAt: 2000,
    reason: "usage",
  });
  const list = s.listHeldTasks();
  expect(list).toHaveLength(2);
  expect(list[0]!.id).toBe("h1");
  expect(list[1]!.id).toBe("h2");
});

test("held_tasks: countHeldTasks returns correct count", () => {
  const s = new SessionStore(":memory:");
  expect(s.countHeldTasks()).toBe(0);
  s.addHeldTask({
    id: "h1",
    repoPath: "/repo/a",
    input: sampleInput,
    createdAt: 1000,
    reason: "usage",
  });
  s.addHeldTask({
    id: "h2",
    repoPath: "/repo/b",
    input: sampleInput,
    createdAt: 2000,
    reason: "usage",
  });
  expect(s.countHeldTasks()).toBe(2);
});

test("held_tasks: getHeldTask round-trips full input", () => {
  const s = new SessionStore(":memory:");
  s.addHeldTask({
    id: "h1",
    repoPath: "/repo/a",
    input: sampleInput,
    createdAt: 1000,
    reason: "usage",
  });
  const got = s.getHeldTask("h1");
  expect(got).not.toBeNull();
  expect(got?.id).toBe("h1");
  expect(got?.repoPath).toBe("/repo/a");
  expect(got?.createdAt).toBe(1000);
  expect(got?.input).toEqual(sampleInput);
});

test("held_tasks: getHeldTask returns null for unknown id", () => {
  const s = new SessionStore(":memory:");
  expect(s.getHeldTask("nonexistent")).toBeNull();
});

test("held_tasks: updateHeldTask replaces input and mirrors repoPath", () => {
  const s = new SessionStore(":memory:");
  s.addHeldTask({
    id: "h1",
    repoPath: "/repo/a",
    input: sampleInput,
    createdAt: 1000,
    reason: "usage",
  });

  const edited: CreateSessionInput = {
    ...sampleInput,
    repoPath: "/repo/b",
    prompt: "edited prompt",
    model: "fable",
  };
  s.updateHeldTask("h1", edited);

  const got = s.getHeldTask("h1");
  expect(got?.repoPath).toBe("/repo/b"); // top-level column mirrors input.repoPath
  expect(got?.createdAt).toBe(1000); // queue position (FIFO key) is preserved
  expect(got?.input).toEqual(edited);
  expect(s.countHeldTasks()).toBe(1); // edit never changes the count
});

test("held_tasks: removeHeldTask removes row and leaves others intact", () => {
  const s = new SessionStore(":memory:");
  s.addHeldTask({
    id: "h1",
    repoPath: "/repo/a",
    input: sampleInput,
    createdAt: 1000,
    reason: "usage",
  });
  s.addHeldTask({
    id: "h2",
    repoPath: "/repo/b",
    input: sampleInput,
    createdAt: 2000,
    reason: "usage",
  });

  s.removeHeldTask("h1");

  expect(s.countHeldTasks()).toBe(1);
  expect(s.getHeldTask("h1")).toBeNull();
  expect(s.getHeldTask("h2")).not.toBeNull();
  expect(s.listHeldTasks()[0]!.id).toBe("h2");
});

// ── capacity hold: reason column + ordering ───────────────────────────────────

test("held_tasks: addHeldTask with reason='capacity' round-trips via getHeldTask", () => {
  const s = new SessionStore(":memory:");
  s.addHeldTask({
    id: "c1",
    repoPath: "/repo/a",
    input: sampleInput,
    createdAt: 1000,
    reason: "capacity",
  });
  const got = s.getHeldTask("c1");
  expect(got?.reason).toBe("capacity");
});

test("held_tasks: addHeldTask with reason='usage' round-trips via getHeldTask", () => {
  const s = new SessionStore(":memory:");
  s.addHeldTask({
    id: "u1",
    repoPath: "/repo/a",
    input: sampleInput,
    createdAt: 1000,
    reason: "usage",
  });
  const got = s.getHeldTask("u1");
  expect(got?.reason).toBe("usage");
});

test("held_tasks: listHeldTasks orders usage before capacity regardless of createdAt", () => {
  const s = new SessionStore(":memory:");
  // capacity added earlier (lower createdAt), usage added later
  s.addHeldTask({
    id: "c1",
    repoPath: "/repo/a",
    input: sampleInput,
    createdAt: 1000,
    reason: "capacity",
  });
  s.addHeldTask({
    id: "u1",
    repoPath: "/repo/b",
    input: sampleInput,
    createdAt: 2000,
    reason: "usage",
  });
  const list = s.listHeldTasks();
  expect(list).toHaveLength(2);
  expect(list[0]!.id).toBe("u1"); // usage first even though later
  expect(list[1]!.id).toBe("c1"); // capacity last
});

test("held_tasks: migrateHeldTaskColumns ALTER path — legacy DB without reason column", () => {
  // Build a pre-existing DB with the OLD held_tasks schema (no reason column),
  // insert a legacy row, then open SessionStore on the same file so the
  // constructor's migrateHeldTaskColumns() runs ALTER TABLE and the legacy row
  // surfaces with reason === 'usage' (the DEFAULT).
  const dir = mkdtempSync(join(tmpdir(), "shepherd-held-migration-"));
  const dbPath = join(dir, "test.db");
  try {
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE held_tasks (
      id TEXT PRIMARY KEY,
      repoPath TEXT NOT NULL,
      input TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )`);
    raw.run(
      `INSERT INTO held_tasks (id, repoPath, input, createdAt)
       VALUES ('legacy-1', '/repo/a', '${JSON.stringify(sampleInput)}', 500)`,
    );
    raw.close();

    // Opening the store triggers migrateHeldTaskColumns → ALTER TABLE ADD COLUMN reason
    const s = new SessionStore(dbPath);
    const list = s.listHeldTasks();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("legacy-1");
    expect(list[0]!.reason).toBe("usage"); // DEFAULT 'usage' applied by ALTER
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
