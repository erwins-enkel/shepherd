import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import { jsonlPathFor } from "../src/usage";
import type { Session } from "../src/types";

// A Claude agent reaped shortly after spawn with no transcript died at launch: the session must
// read "halted on an error", not a healthy done (autonomous egress runner /dev/null-stdin bug).

const baseSession = {
  name: "x",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/x",
  worktreePath: "/wt-launch-failure",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_a",
  claudeSessionId: "93e3c0d4-d492-4b16-b493-c9bdaa89fcc6",
};

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** Poller over an empty herdr listing (the agent is gone → reapGone), `elapsedMs` after create. */
function reapAfter(s: Session, store: SessionStore, elapsedMs: number) {
  const halts: Array<{ id: string; reason: string | null }> = [];
  const poller = new StatusPoller(
    store,
    { listAsync: () => Promise.resolve([]), readAsync: async () => "" } as any,
    () => {},
    () => {},
    1000,
    3000,
    undefined,
    () => s.createdAt + elapsedMs,
    () => ({ snapshot: null, activity: null }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined, // onWorkingBlocked
    undefined, // pruneHooks
    () => {}, // onStopWindow
    (id, reason) => halts.push({ id, reason }), // onHalt
  );
  return { poller, halts };
}

/** Point the session at a temp account dir so a test can create (or not) its transcript. */
function withAccountDir(store: SessionStore, s: Session): Session {
  const dir = mkdtempSync(join(tmpdir(), "poller-launch-"));
  dirs.push(dir);
  store.setSpawnIdentity(s.id, null, dir);
  const out = store.get(s.id)!;
  // Guard: never let a test resolve (and write) a transcript under the operator's real ~/.claude.
  expect(out.spawnAccountDir).toBe(dir);
  return out;
}

test("agent gone right after spawn with no transcript → halted as error", async () => {
  const store = new SessionStore(":memory:");
  const s = withAccountDir(store, store.create(baseSession));
  const { poller, halts } = reapAfter(s, store, 5_000);
  await poller.tick();
  expect(store.get(s.id)?.status).toBe("done");
  expect(store.get(s.id)?.haltReason).toBe("error");
  expect(halts).toEqual([{ id: s.id, reason: "error" }]);
});

test("agent gone with a transcript → plain done, no halt", async () => {
  const store = new SessionStore(":memory:");
  const s = withAccountDir(store, store.create(baseSession));
  const path = jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}\n");
  const { poller, halts } = reapAfter(s, store, 5_000);
  await poller.tick();
  expect(store.get(s.id)?.status).toBe("done");
  expect(store.get(s.id)?.haltReason).toBeNull();
  expect(halts).toEqual([]);
});

test("agent gone long after spawn → no launch-failure halt", async () => {
  const store = new SessionStore(":memory:");
  const s = withAccountDir(store, store.create(baseSession));
  const { poller, halts } = reapAfter(s, store, 10 * 60_000);
  await poller.tick();
  expect(store.get(s.id)?.haltReason).toBeNull();
  expect(halts).toEqual([]);
});

test("an existing halt reason is left untouched", async () => {
  const store = new SessionStore(":memory:");
  const s0 = withAccountDir(store, store.create(baseSession));
  store.setHaltReason(s0.id, "usage_limit", s0.createdAt);
  const s = store.get(s0.id)!;
  const { poller, halts } = reapAfter(s, store, 5_000);
  await poller.tick();
  expect(store.get(s.id)?.haltReason).toBe("usage_limit");
  expect(halts).toEqual([]);
});

test("a codex session is never flagged", async () => {
  const store = new SessionStore(":memory:");
  const s = withAccountDir(store, store.create({ ...baseSession, agentProvider: "codex" }));
  const { poller, halts } = reapAfter(s, store, 5_000);
  await poller.tick();
  expect(store.get(s.id)?.haltReason).toBeNull();
  expect(halts).toEqual([]);
});
