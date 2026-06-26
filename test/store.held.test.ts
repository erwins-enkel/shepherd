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
