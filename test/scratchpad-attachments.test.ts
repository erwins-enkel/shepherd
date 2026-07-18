import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import { sessionScratchpadDir } from "../src/tmp-sweep";
import { worktreeUploadsDir } from "../src/uploads";
import { ATTACHMENTS_DIR } from "../src/scratchpad";

// Coverage for the #1717 Scratchpad→Attachments overlay: New Task (and mid-session compose-box)
// attachments live in <worktree>/.shepherd-uploads and are surfaced in the Scratchpad view as a
// synthetic `attachments/` folder — provider-agnostically, including non-Claude sessions with a
// blank claudeSessionId that have no scratchpad of their own.

let tmpRoot: string;
let repoDir: string;
let scratchRoot: string;
const prevEnv = process.env.SHEPHERD_TMP_SWEEP_DIR;
const SID = "claude-sess-1";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-att-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
  scratchRoot = mkdtempSync(join(config.repoRoot, "shepherd-att-tmp-"));
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
    service: {} as unknown as AppDeps["service"],
    events: hub,
    usageLimits: { limits: () => ({}) } as unknown as AppDeps["usageLimits"],
  };
  return { app: makeApp(deps), store };
}

function makeSession(store: SessionStore, claudeSessionId = SID) {
  return store.create({
    name: "att-session",
    prompt: "p",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/att",
    worktreePath: repoDir,
    isolated: false,
    herdrSession: "sess-x",
    herdrAgentId: "agent-x",
    claudeSessionId,
    model: null,
  });
}

/** Write files into the worktree's `.shepherd-uploads` dir — where both New Task and ?session= uploads land. */
function seedUploads(files: Record<string, string>) {
  const dir = worktreeUploadsDir(repoDir);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const names = (body: { entries: { name: string }[] }) => body.entries.map((e) => e.name);

test("merged root overlays a sorted-in Attachments folder alongside real scratchpad entries", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  // Seed real scratchpad entries as dirs (mkdir only — no file writes into the tmpdir-derived
  // scratchpad root). "aaa-dir" sorts BEFORE "attachments", proving the synthetic folder is sorted
  // in by the standard dirs-first/alpha comparator, NOT pinned first.
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(join(root, "aaa-dir"), { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
  seedUploads({ "shot.png": "png" });

  const res = await app.fetch(new Request(`http://x/api/sessions/${s.id}/scratchpad`));
  expect(res.status).toBe(200);
  const body = await res.json();
  // Sorted in among the dirs (locale-alpha): "aaa-dir" < "attachments" < "logs".
  expect(names(body)).toEqual(["aaa-dir", ATTACHMENTS_DIR, "logs"]);
  const att = body.entries.find((e: { name: string }) => e.name === ATTACHMENTS_DIR);
  expect(att).toMatchObject({ type: "dir", path: ATTACHMENTS_DIR, attachments: true });
});

test("Attachments folder is provider-agnostic — present with a blank claudeSessionId (no scratchpad)", async () => {
  const { app, store } = harness();
  const s = makeSession(store, ""); // non-Claude session: no scratchpad of its own
  seedUploads({ "shot.png": "png" });

  const res = await app.fetch(new Request(`http://x/api/sessions/${s.id}/scratchpad`));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(names(body)).toEqual([ATTACHMENTS_DIR]);
  expect(body.entries[0]).toMatchObject({ attachments: true });
});

test("lists the Attachments subtree from the uploads dir with remapped paths", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedUploads({ "a.png": "a", "b.png": "b" });

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/scratchpad?path=${ATTACHMENTS_DIR}`),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe(ATTACHMENTS_DIR);
  expect(body.parent).toBe(""); // parent of the folder is the merged scratchpad root
  expect(names(body)).toEqual(["a.png", "b.png"]);
  expect(body.entries.map((e: { path: string }) => e.path)).toEqual([
    `${ATTACHMENTS_DIR}/a.png`,
    `${ATTACHMENTS_DIR}/b.png`,
  ]);
});

test("a mid-session ?session= upload appears in the Attachments folder", async () => {
  const { app, store } = harness();
  const s = makeSession(store);

  // Exercise the real compose-box path: POST /api/uploads?session= writes into .shepherd-uploads.
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1, 2, 3])], "paste.png", { type: "image/png" }));
  const up = await app.fetch(
    new Request(`http://x/api/uploads?session=${s.id}`, { method: "POST", body: fd }),
  );
  expect(up.status).toBe(200);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/scratchpad?path=${ATTACHMENTS_DIR}`),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.entries).toHaveLength(1);
  expect(body.entries[0].path.startsWith(`${ATTACHMENTS_DIR}/`)).toBe(true);
});

test("downloads a file from the Attachments subtree", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedUploads({ "shot.png": "PNGDATA" });

  const res = await app.fetch(
    new Request(
      `http://x/api/sessions/${s.id}/scratchpad/download?path=${ATTACHMENTS_DIR}/shot.png`,
    ),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toContain('filename="shot.png"');
  expect(await res.text()).toBe("PNGDATA");
});

test("rejects a `..` escape out of the Attachments subtree with 404", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedUploads({ "shot.png": "png" });

  const res = await app.fetch(
    new Request(
      `http://x/api/sessions/${s.id}/scratchpad?path=${encodeURIComponent(`${ATTACHMENTS_DIR}/../../escape`)}`,
    ),
  );
  expect(res.status).toBe(404);
});

test("an upload targeting path=attachments fails closed (404) and never writes into .shepherd-uploads", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  seedUploads({ "existing.png": "x" });

  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([9])], "evil.png", { type: "image/png" }));
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/scratchpad/upload?path=${ATTACHMENTS_DIR}`, {
      method: "POST",
      body: fd,
    }),
  );
  expect(res.status).toBe(404); // routes to the real scratchpad root, where `attachments` doesn't exist
  // The uploads dir is untouched — the overlay is read-only server-side.
  expect(readdirSync(worktreeUploadsDir(repoDir))).toEqual(["existing.png"]);
});

test("dedupe: a real scratchpad dir named `attachments` yields exactly one (synthetic) row", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  // A real scratchpad dir literally named `attachments` (mkdir only — no tmpdir file write). It is
  // shadowed by the synthetic overlay and must not produce a second row.
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(join(root, ATTACHMENTS_DIR), { recursive: true });
  seedUploads({ "shot.png": "png" });

  const res = await app.fetch(new Request(`http://x/api/sessions/${s.id}/scratchpad`));
  const body = await res.json();
  const rows = body.entries.filter((e: { name: string }) => e.name === ATTACHMENTS_DIR);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ attachments: true }); // the synthetic overlay wins

  // Navigating into it shows the uploads content, not the shadowed real scratchpad dir.
  const sub = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/scratchpad?path=${ATTACHMENTS_DIR}`),
  );
  expect(names(await sub.json())).toEqual(["shot.png"]);
});

test("root is 404 when there is neither a scratchpad nor any attachment (blank sid, no uploads)", async () => {
  const { app, store } = harness();
  const s = makeSession(store, "");

  const res = await app.fetch(new Request(`http://x/api/sessions/${s.id}/scratchpad`));
  expect(res.status).toBe(404);
});
