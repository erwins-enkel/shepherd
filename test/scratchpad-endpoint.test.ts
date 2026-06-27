import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import { sessionScratchpadDir } from "../src/tmp-sweep";

let tmpRoot: string;
let repoDir: string;
let scratchRoot: string;
const prevEnv = process.env.SHEPHERD_TMP_SWEEP_DIR;
const SID = "claude-sess-1";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-scratch-ep-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
  scratchRoot = mkdtempSync(join(config.repoRoot, "shepherd-scratch-tmp-"));
  process.env.SHEPHERD_TMP_SWEEP_DIR = scratchRoot;
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(scratchRoot, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.SHEPHERD_TMP_SWEEP_DIR;
  else process.env.SHEPHERD_TMP_SWEEP_DIR = prevEnv;
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
    name: "scratch-session",
    prompt: "p",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/scratch",
    worktreePath: repoDir,
    isolated: false,
    herdrSession: "sess-x",
    herdrAgentId: "agent-x",
    claudeSessionId: SID,
    model: null,
  });
}

/** Populate the session's scratchpad with a file, a dotfile, and a nested dir. */
function seedScratchpad() {
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(join(root, "config.yaml"), "yaml: 1\n");
  writeFileSync(join(root, ".env"), "X=1");
  writeFileSync(join(root, "logs", "run.log"), "log");
  return root;
}

test("GET scratchpad lists the root (dirs first, dotfiles shown)", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedScratchpad();

  const res = await app.fetch(new Request(`http://x/api/sessions/${s.id}/scratchpad`));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe("");
  expect(body.parent).toBeNull();
  expect(body.entries.map((e: { name: string }) => e.name)).toEqual([
    "logs",
    ".env",
    "config.yaml",
  ]);
});

test("GET scratchpad?path=logs descends into a subdir", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedScratchpad();

  const res = await app.fetch(new Request(`http://x/api/sessions/${s.id}/scratchpad?path=logs`));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe("logs");
  expect(body.parent).toBe("");
  expect(body.entries[0].path).toBe("logs/run.log");
});

test("GET scratchpad rejects a `..` escape with 404", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedScratchpad();

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/scratchpad?path=${encodeURIComponent("../..")}`),
  );
  expect(res.status).toBe(404);
});

test("download streams a file with an attachment Content-Disposition", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedScratchpad();

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/scratchpad/download?path=config.yaml`),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toBe(
    "attachment; filename=\"config.yaml\"; filename*=UTF-8''config.yaml",
  );
  expect(await res.text()).toBe("yaml: 1\n");
});

test("download of a directory is 404 (files only)", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedScratchpad();

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/scratchpad/download?path=logs`),
  );
  expect(res.status).toBe(404);
});

test("scratchpad of an unknown session is 404", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/sessions/nope/scratchpad"));
  expect(res.status).toBe(404);
});

test("scratchpad of an archived session is 404 (live only)", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedScratchpad();
  store.update(s.id, { status: "archived" });

  const res = await app.fetch(new Request(`http://x/api/sessions/${s.id}/scratchpad`));
  expect(res.status).toBe(404);
});

test("GET /api/sessions enriches active sessions with hasScratchpadFiles", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedScratchpad();

  const res = await app.fetch(new Request("http://x/api/sessions"));
  expect(res.status).toBe(200);
  const list = await res.json();
  const row = list.find((r: { id: string }) => r.id === s.id);
  expect(row.hasScratchpadFiles).toBe(true);
});
