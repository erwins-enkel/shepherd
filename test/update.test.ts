import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateService, type GitRunner } from "../src/update";

/** A logPath guaranteed not to exist, so applyState() reads "idle". */
function freshLog(): string {
  return join(mkdtempSync(join(tmpdir(), "shepherd-update-test-")), "deploy.log");
}

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

test("apply() launches once and guards double-launch with a reason", () => {
  let launches = 0;
  const svc = new UpdateService({
    git: fakeGit(UP_TO_DATE),
    logPath: freshLog(),
    launch: () => launches++,
  });
  expect(svc.apply()).toEqual({ started: true });
  const second = svc.apply();
  expect(second.started).toBe(false);
  expect(second.error).toBeTruthy(); // never a bare status — the UI shows this
  expect(launches).toBe(1);
});

test("apply() surfaces a launch failure instead of throwing", () => {
  const svc = new UpdateService({
    git: fakeGit(UP_TO_DATE),
    logPath: freshLog(),
    launch: () => {
      throw new Error("systemd-run not found");
    },
  });
  const r = svc.apply();
  expect(r.started).toBe(false);
  expect(r.error).toContain("systemd-run not found");
});

test("applyState() reads the deploy log: idle → running → failed", () => {
  const logPath = freshLog();
  const svc = new UpdateService({ git: fakeGit(UP_TO_DATE), logPath, launch: () => {} });

  expect(svc.applyState().phase).toBe("idle"); // no log yet

  writeFileSync(logPath, "\x1b[36m▸ installing deps\x1b[0m\nbuilding UI\n");
  const running = svc.applyState();
  expect(running.phase).toBe("running");
  expect(running.log).toContain("installing deps");
  expect(running.log).not.toContain("\x1b["); // ANSI stripped

  writeFileSync(logPath, "build failed: tsc error\n__SHEPHERD_UPDATE_EXIT__:1\n");
  const failed = svc.applyState();
  expect(failed.phase).toBe("failed");
  expect(failed.exitCode).toBe(1);
  expect(failed.log).toContain("build failed: tsc error");
  expect(failed.log).not.toContain("__SHEPHERD_UPDATE_EXIT__"); // marker hidden from the UI
});

test("applyState() reports done on a clean exit", () => {
  const logPath = freshLog();
  const svc = new UpdateService({ git: fakeGit(UP_TO_DATE), logPath, launch: () => {} });
  writeFileSync(logPath, "✓ shepherd healthy\n__SHEPHERD_UPDATE_EXIT__:0\n");
  const s = svc.applyState();
  expect(s.phase).toBe("done");
  expect(s.exitCode).toBe(0);
});

test("apply() retries after a previous deploy failed (latch self-heals)", () => {
  const logPath = freshLog();
  let launches = 0;
  const svc = new UpdateService({ git: fakeGit(UP_TO_DATE), logPath, launch: () => launches++ });
  expect(svc.apply().started).toBe(true);
  // a failed deploy left a non-zero exit marker behind
  writeFileSync(logPath, "boom\n__SHEPHERD_UPDATE_EXIT__:1\n");
  expect(svc.apply().started).toBe(true); // not stuck — retry is allowed
  expect(launches).toBe(2);
});
