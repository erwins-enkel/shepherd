import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-worktree-ep-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function harness() {
  const store = new SessionStore(":memory:");
  const hub = new EventHub();
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: hub,
    usageLimits: { limits: () => ({}) } as any,
  };
  return { app: makeApp(deps), store };
}

function makeSession(store: SessionStore) {
  return store.create({
    name: "worktree-session",
    prompt: "p",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/worktree",
    worktreePath: repoDir,
    isolated: false,
    herdrSession: "sess-x",
    herdrAgentId: "agent-x",
    claudeSessionId: "claude-sess-1",
    model: null,
  });
}

/** Populate the session's worktree with a file, a nested dir, and a `.git` pointer file. */
function seedWorktree() {
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# hi\n");
  writeFileSync(join(repoDir, "src", "index.ts"), "export {};\n");
  writeFileSync(join(repoDir, ".git"), "gitdir: /some/path/.git/worktrees/x\n");
}

test("GET worktree lists the root with .git hidden", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedWorktree();

  const res = await app.fetch(new Request(`http://x/api/sessions/${s.id}/worktree`));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe("");
  expect(body.parent).toBeNull();
  const names = body.entries.map((e: { name: string }) => e.name);
  expect(names).not.toContain(".git");
  expect(names).toContain("README.md");
  expect(names).toContain("src");
});

test("GET worktree of an unknown session is 404", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/sessions/nope/worktree"));
  expect(res.status).toBe(404);
});

test("GET worktree of an archived session is 404 (live only)", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedWorktree();
  store.update(s.id, { status: "archived" });

  const res = await app.fetch(new Request(`http://x/api/sessions/${s.id}/worktree`));
  expect(res.status).toBe(404);
});

test("download streams a worktree file with an attachment Content-Disposition", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedWorktree();

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/worktree/download?path=README.md`),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toBe(
    "attachment; filename=\"README.md\"; filename*=UTF-8''README.md",
  );
  expect(await res.text()).toBe("# hi\n");
});

test("download of a .git path is 404 (hidden segment)", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedWorktree();

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/worktree/download?path=.git`),
  );
  expect(res.status).toBe(404);
});
