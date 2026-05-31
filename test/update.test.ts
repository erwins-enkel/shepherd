import { test, expect } from "bun:test";
import { UpdateService, type GitRunner } from "../src/update";

/** Build a git runner from a map of "joined args" → stdout. */
function fakeGit(responses: Record<string, string>): GitRunner {
  return (args) => {
    const key = args.join(" ");
    if (!(key in responses)) throw new Error(`unexpected git: ${key}`);
    return responses[key]!;
  };
}

const UP_TO_DATE = {
  "fetch --quiet origin main": "",
  "rev-parse --short HEAD": "abc1234\n",
  "rev-parse --short origin/main": "abc1234\n",
  "rev-list --count HEAD..origin/main": "0\n",
};

const BEHIND_TWO = {
  "fetch --quiet origin main": "",
  "rev-parse --short HEAD": "abc1234\n",
  "rev-parse --short origin/main": "def5678\n",
  "rev-list --count HEAD..origin/main": "2\n",
  "log --max-count=20 --format=%h%x09%s HEAD..origin/main":
    "def5678\tfeat(ui): add update badge\nbbb2222\tfix(server): guard route\n",
};

test("up to date → behind 0, no commits", () => {
  const svc = new UpdateService({ git: fakeGit(UP_TO_DATE), launch: () => {} });
  const s = svc.check(1000);
  expect(s.behind).toBe(0);
  expect(s.commits).toEqual([]);
  expect(s.current).toBe("abc1234");
  expect(s.latest).toBe("abc1234");
  expect(s.error).toBeUndefined();
});

test("behind main → behind count + parsed commit list (newest first)", () => {
  const svc = new UpdateService({ git: fakeGit(BEHIND_TWO), launch: () => {} });
  const s = svc.check(2000);
  expect(s.behind).toBe(2);
  expect(s.current).toBe("abc1234");
  expect(s.latest).toBe("def5678");
  expect(s.commits).toEqual([
    { sha: "def5678", subject: "feat(ui): add update badge" },
    { sha: "bbb2222", subject: "fix(server): guard route" },
  ]);
});

test("subjects containing tabs survive parsing", () => {
  const svc = new UpdateService({
    git: fakeGit({
      ...BEHIND_TWO,
      "rev-list --count HEAD..origin/main": "1\n",
      "log --max-count=20 --format=%h%x09%s HEAD..origin/main": "def5678\tfix: a\tb\tc\n",
    }),
    launch: () => {},
  });
  const s = svc.check(3000);
  expect(s.commits).toEqual([{ sha: "def5678", subject: "fix: a\tb\tc" }]);
});

test("git failure fails safe to behind 0 with an error", () => {
  const svc = new UpdateService({
    git: () => {
      throw new Error("network down");
    },
    launch: () => {},
  });
  const s = svc.check(4000);
  expect(s.behind).toBe(0);
  expect(s.error).toContain("network down");
});

test("current() caches the last check", () => {
  const svc = new UpdateService({ git: fakeGit(BEHIND_TWO), launch: () => {} });
  expect(svc.current()).toBeNull();
  svc.check(5000);
  expect(svc.current()?.behind).toBe(2);
});

test("apply() launches once and guards double-launch", () => {
  let launches = 0;
  const svc = new UpdateService({ git: fakeGit(UP_TO_DATE), launch: () => launches++ });
  expect(svc.apply()).toEqual({ started: true });
  expect(svc.apply()).toEqual({ started: false });
  expect(launches).toBe(1);
});
