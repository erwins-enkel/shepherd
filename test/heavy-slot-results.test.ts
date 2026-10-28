import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRevision } from "../src/heavy-slot-revision";
import { parseHeavySlotSnapshot, readLastResults } from "../src/heavy-slot-snapshot";
import { SessionStore } from "../src/store";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slot-res-"));
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function finishedJob(store: SessionStore, exitCode: number) {
  const rev = await captureRevision(dir, dir);
  store.startHeavySlotJob({
    id: "j1",
    sessionId: "s1",
    command: "vitest run",
    repoPath: dir,
    worktreePath: dir,
    startedAt: 1,
    ...rev,
  });
  store.finishHeavySlotJob("j1", { exitCode, endedAt: 2 });
}

test("a passing result is current until the worktree moves on, then stale", async () => {
  const store = new SessionStore(":memory:");
  await finishedJob(store, 0);
  const [fresh] = await readLastResults(store, 10_000);
  expect(fresh).toMatchObject({ sessionId: "s1", result: "passed", exitCode: 0, stale: false });
  writeFileSync(join(dir, "a.txt"), "changed\n");
  const [stale] = await readLastResults(store, 20_000);
  expect(stale).toMatchObject({ result: "passed", stale: true });
});

test("a failed result keeps its result and also turns stale", async () => {
  const store = new SessionStore(":memory:");
  await finishedJob(store, 1);
  git("commit", "--allow-empty", "-qm", "next");
  const [r] = await readLastResults(store, 30_000);
  expect(r).toMatchObject({ result: "failed", exitCode: 1, stale: true });
});

test("a remote snapshot without lastResults parses to an empty list; bad entries are dropped", () => {
  const base = {
    enabled: true,
    capacity: 1,
    holders: [],
    waiters: [],
  };
  expect(parseHeavySlotSnapshot(base)?.lastResults).toEqual([]);
  const parsed = parseHeavySlotSnapshot({
    ...base,
    lastResults: [
      { sessionId: "a", command: "c", startedAt: 1, result: "passed", treeHash: "t", head: "h" },
      { sessionId: "b" },
    ],
  });
  expect(parsed?.lastResults).toHaveLength(1);
  // unreported staleness never reads as current
  expect(parsed?.lastResults[0]).toMatchObject({ sessionId: "a", result: "passed", stale: true });
});
