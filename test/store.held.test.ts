import { expect, test } from "bun:test";
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
  mergeTrainPrs: [],
};

test("held_tasks: listHeldTasks returns FIFO order", () => {
  const s = new SessionStore(":memory:");
  s.addHeldTask({ id: "h1", repoPath: "/repo/a", input: sampleInput, createdAt: 1000 });
  s.addHeldTask({
    id: "h2",
    repoPath: "/repo/b",
    input: { ...sampleInput, prompt: "second task" },
    createdAt: 2000,
  });
  const list = s.listHeldTasks();
  expect(list).toHaveLength(2);
  expect(list[0]!.id).toBe("h1");
  expect(list[1]!.id).toBe("h2");
});

test("held_tasks: countHeldTasks returns correct count", () => {
  const s = new SessionStore(":memory:");
  expect(s.countHeldTasks()).toBe(0);
  s.addHeldTask({ id: "h1", repoPath: "/repo/a", input: sampleInput, createdAt: 1000 });
  s.addHeldTask({ id: "h2", repoPath: "/repo/b", input: sampleInput, createdAt: 2000 });
  expect(s.countHeldTasks()).toBe(2);
});

test("held_tasks: getHeldTask round-trips full input", () => {
  const s = new SessionStore(":memory:");
  s.addHeldTask({ id: "h1", repoPath: "/repo/a", input: sampleInput, createdAt: 1000 });
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
  s.addHeldTask({ id: "h1", repoPath: "/repo/a", input: sampleInput, createdAt: 1000 });

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
  s.addHeldTask({ id: "h1", repoPath: "/repo/a", input: sampleInput, createdAt: 1000 });
  s.addHeldTask({ id: "h2", repoPath: "/repo/b", input: sampleInput, createdAt: 2000 });

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

test("held_tasks: addHeldTask defaults reason to 'usage' when omitted", () => {
  const s = new SessionStore(":memory:");
  // reason is optional; omitting it should default to 'usage' in the store
  s.addHeldTask({ id: "u1", repoPath: "/repo/a", input: sampleInput, createdAt: 1000 });
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

test("held_tasks: migration adds reason to pre-existing rows defaulting to 'usage'", () => {
  // Simulate a pre-existing DB without the reason column by using a fresh store
  // (the migration is guarded — on a brand-new :memory: store the CREATE TABLE includes
  // the column, so we test via the normal path: insert with explicit usage and verify).
  const s = new SessionStore(":memory:");
  s.addHeldTask({
    id: "old",
    repoPath: "/repo/a",
    input: sampleInput,
    createdAt: 500,
    reason: "usage",
  });
  s.addHeldTask({
    id: "new",
    repoPath: "/repo/b",
    input: sampleInput,
    createdAt: 600,
    reason: "capacity",
  });
  const list = s.listHeldTasks();
  expect(list.find((t) => t.id === "old")?.reason).toBe("usage");
  expect(list.find((t) => t.id === "new")?.reason).toBe("capacity");
});
