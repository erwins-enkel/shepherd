import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
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
const SID = "claude-sess-upload-1";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-scratch-up-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
  scratchRoot = mkdtempSync(join(config.repoRoot, "shepherd-scratch-tmp-up-"));
  process.env.SHEPHERD_TMP_SWEEP_DIR = scratchRoot;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(scratchRoot, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.SHEPHERD_TMP_SWEEP_DIR;
  else process.env.SHEPHERD_TMP_SWEEP_DIR = prevEnv;
});

function harness(maxUploadBytes?: number) {
  const store = new SessionStore(":memory:");
  const hub = new EventHub();
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: hub,
    usageLimits: { limits: () => ({}) } as any,
    maxUploadBytes,
  };
  return { app: makeApp(deps), store };
}

function makeSession(store: SessionStore) {
  return store.create({
    name: "upload-session",
    prompt: "p",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/upload",
    worktreePath: repoDir,
    isolated: false,
    herdrSession: "sess-x",
    herdrAgentId: "agent-x",
    claudeSessionId: SID,
    model: null,
  });
}

function makeUploadRequest(sessionId: string, file: File, path = ""): Request {
  const form = new FormData();
  form.append("file", file);
  const url = `http://x/api/sessions/${sessionId}/scratchpad/upload${path ? `?path=${encodeURIComponent(path)}` : ""}`;
  return new Request(url, { method: "POST", body: form });
}

// ── Root absent → upload creates it and the file lands ──────────────────────

test("POST upload: root absent → creates it, file lands at root, returns { path }", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  // Do NOT pre-create scratchpad root — this is the start-of-session path

  const content = new Uint8Array([1, 2, 3, 4]);
  const file = new File([content], "hello.bin", { type: "application/octet-stream" });
  const res = await app.fetch(makeUploadRequest(s.id, file));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe("hello.bin");

  const root = sessionScratchpadDir(repoDir, SID);
  const abs = join(root, "hello.bin");
  const written = await Bun.file(abs).bytes();
  expect(written).toEqual(content);
});

// ── Upload into an existing subdir ──────────────────────────────────────────

test("POST upload: existing subdir → file lands there, path is sub/<name>", async () => {
  const { app, store } = harness();
  const s = makeSession(store);

  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(join(root, "sub"), { recursive: true });

  const file = new File(["subdata"], "note.txt", { type: "text/plain" });
  const res = await app.fetch(makeUploadRequest(s.id, file, "sub"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe("sub/note.txt");

  const abs = join(root, "sub", "note.txt");
  expect(await Bun.file(abs).text()).toBe("subdata");
});

// ── Path-escape destinations → 404 ──────────────────────────────────────────

test("POST upload: ?path=.. → 404", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(root, { recursive: true });

  const file = new File(["x"], "f.txt", { type: "text/plain" });
  const res = await app.fetch(makeUploadRequest(s.id, file, ".."));
  expect(res.status).toBe(404);
});

test("POST upload: ?path=/etc → 404", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(root, { recursive: true });

  const file = new File(["x"], "f.txt", { type: "text/plain" });
  const res = await app.fetch(makeUploadRequest(s.id, file, "/etc"));
  expect(res.status).toBe(404);
});

test("POST upload: symlink dir pointing outside → 404", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(root, { recursive: true });

  // Create a dir outside the root and symlink it in
  const outside = mkdtempSync(join(tmpRoot, "outside-"));
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(root, "escape-link"));

  const file = new File(["x"], "f.txt", { type: "text/plain" });
  const res = await app.fetch(makeUploadRequest(s.id, file, "escape-link"));
  expect(res.status).toBe(404);
});

// ── ?path pointing at a file → 404 (not 500) ────────────────────────────────

test("POST upload: ?path pointing at existing file → 404", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "existing.txt"), "content");

  const file = new File(["y"], "new.txt", { type: "text/plain" });
  const res = await app.fetch(makeUploadRequest(s.id, file, "existing.txt"));
  expect(res.status).toBe(404);
});

// ── Oversize → 413 ──────────────────────────────────────────────────────────

// Runs against an injected tiny limit (maxUploadBytes seam) instead of allocating a
// MAX_UPLOAD_BYTES-sized fixture (250 MiB); a boundary-sized file also proves the check
// is strictly-greater-than.
test("POST upload: oversize file → 413, at-limit file accepted", async () => {
  const { app, store } = harness(8);
  const s = makeSession(store);
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(root, { recursive: true });

  const atLimit = new File(["A".repeat(8)], "ok.bin", { type: "application/octet-stream" });
  expect((await app.fetch(makeUploadRequest(s.id, atLimit))).status).toBe(200);

  const over = new File(["A".repeat(9)], "big.bin", { type: "application/octet-stream" });
  const res = await app.fetch(makeUploadRequest(s.id, over));
  expect(res.status).toBe(413);
});

// ── Missing file field → 400 ────────────────────────────────────────────────

test("POST upload: missing file field → 400", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(root, { recursive: true });

  const form = new FormData();
  form.append("not-file", "value");
  const req = new Request(`http://x/api/sessions/${s.id}/scratchpad/upload`, {
    method: "POST",
    body: form,
  });
  const res = await app.fetch(req);
  expect(res.status).toBe(400);
});

// ── Filename sanitization ────────────────────────────────────────────────────

test("POST upload: filename with path separators sanitized to single segment", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(root, { recursive: true });

  // A filename with path traversal attempts
  const file = new File(["data"], "../evil/../../etc/passwd", { type: "text/plain" });
  const res = await app.fetch(makeUploadRequest(s.id, file));
  expect(res.status).toBe(200);
  const body = await res.json();
  // Path must be a single segment (no slashes, no dots-only)
  expect(body.path).not.toContain("/");
  expect(body.path).not.toContain("\\");
  expect(body.path).not.toBe("..");
  expect(body.path).not.toBe(".");
  // File must be inside the root
  const abs = join(realpathSync(root), body.path);
  expect(abs.startsWith(realpathSync(root))).toBe(true);
});

test("POST upload: filename '.' → sanitized to fallback", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(root, { recursive: true });

  const file = new File(["data"], ".", { type: "text/plain" });
  const res = await app.fetch(makeUploadRequest(s.id, file));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).not.toBe(".");
  expect(body.path.length).toBeGreaterThan(0);
});

// ── Collision → numeric suffix ───────────────────────────────────────────────

test("POST upload: collision → second file gets numeric suffix (e.g. report (2).pdf)", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(root, { recursive: true });

  const file1 = new File(["first"], "report.pdf", { type: "application/pdf" });
  const res1 = await app.fetch(makeUploadRequest(s.id, file1));
  expect(res1.status).toBe(200);
  expect((await res1.json()).path).toBe("report.pdf");

  const file2 = new File(["second"], "report.pdf", { type: "application/pdf" });
  const res2 = await app.fetch(makeUploadRequest(s.id, file2));
  expect(res2.status).toBe(200);
  expect((await res2.json()).path).toBe("report (2).pdf");

  // Original untouched
  expect(await Bun.file(join(root, "report.pdf")).text()).toBe("first");
  expect(await Bun.file(join(root, "report (2).pdf")).text()).toBe("second");
});

test("POST upload: collision on extensionless name → suffix without extension", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(root, { recursive: true });

  const file1 = new File(["a"], "report", { type: "application/octet-stream" });
  const res1 = await app.fetch(makeUploadRequest(s.id, file1));
  expect(res1.status).toBe(200);
  expect((await res1.json()).path).toBe("report");

  const file2 = new File(["b"], "report", { type: "application/octet-stream" });
  const res2 = await app.fetch(makeUploadRequest(s.id, file2));
  expect(res2.status).toBe(200);
  expect((await res2.json()).path).toBe("report (2)");
});

// ── lstat symlink-escape on the leaf name ────────────────────────────────────

test("POST upload: symlink at target name pointing outside → treated as collision, suffix used", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  const root = sessionScratchpadDir(repoDir, SID);
  mkdirSync(root, { recursive: true });

  // Plant a symlink at "target.txt" pointing outside the root
  const outside = mkdtempSync(join(tmpRoot, "outside2-"));
  const outsideFile = join(outside, "victim.txt");
  writeFileSync(outsideFile, "original");
  symlinkSync(outsideFile, join(root, "target.txt"));

  const file = new File(["safe"], "target.txt", { type: "text/plain" });
  const res = await app.fetch(makeUploadRequest(s.id, file));
  expect(res.status).toBe(200);
  const body = await res.json();
  // Must not be the symlink name itself (collision detected via lstat)
  expect(body.path).not.toBe("target.txt");
  // The outside file must NOT be overwritten
  expect(await Bun.file(outsideFile).text()).toBe("original");
  // The actual written file must be inside the root
  const writtenPath = join(realpathSync(root), body.path);
  expect(writtenPath.startsWith(realpathSync(root))).toBe(true);
});

// ── Unknown / archived session → 404 ────────────────────────────────────────

test("POST upload: unknown session → 404", async () => {
  const { app } = harness();
  const file = new File(["x"], "f.txt", { type: "text/plain" });
  const res = await app.fetch(makeUploadRequest("no-such-session", file));
  expect(res.status).toBe(404);
});

test("POST upload: archived session → 404", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  store.update(s.id, { status: "archived" });

  const file = new File(["x"], "f.txt", { type: "text/plain" });
  const res = await app.fetch(makeUploadRequest(s.id, file));
  expect(res.status).toBe(404);
});

// ── GET empty-root → synthetic empty listing ─────────────────────────────────

test("GET scratchpad: fresh session with no root → empty listing (not 404)", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  // Do NOT create the scratchpad root

  const res = await app.fetch(new Request(`http://x/api/sessions/${s.id}/scratchpad`));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe("");
  expect(body.parent).toBeNull();
  expect(body.entries).toEqual([]);
});

test("GET scratchpad: missing non-root subdir still 404s", async () => {
  const { app, store } = harness();
  const s = makeSession(store);
  // Do NOT create the scratchpad root

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/scratchpad?path=nonexistent`),
  );
  expect(res.status).toBe(404);
});
