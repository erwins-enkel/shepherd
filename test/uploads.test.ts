import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extForMime,
  MAX_UPLOAD_BYTES,
  stagingDir,
  worktreeUploadsDir,
  moveStagedIntoWorktree,
  sweepStaging,
  uploadFilename,
  handleUpload,
} from "../src/uploads";
import { SessionStore } from "../src/store";

test("extForMime maps supported image types, rejects others", () => {
  expect(extForMime("image/png")).toBe("png");
  expect(extForMime("image/jpeg")).toBe("jpg");
  expect(extForMime("image/gif")).toBe("gif");
  expect(extForMime("image/webp")).toBe("webp");
  expect(extForMime("image/svg+xml")).toBeNull();
  expect(extForMime("application/pdf")).toBeNull();
  expect(extForMime("")).toBeNull();
});

test("MAX_UPLOAD_BYTES is 10 MB", () => {
  expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
});

test("stagingDir / worktreeUploadsDir build the expected paths", () => {
  expect(stagingDir("/repos")).toBe(join("/repos", ".shepherd-uploads-staging"));
  expect(worktreeUploadsDir("/wt/x")).toBe(join("/wt/x", ".shepherd-uploads"));
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shepherd-uploads-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("moveStagedIntoWorktree moves files in and returns new absolute paths", () => {
  const staging = stagingDir(root);
  mkdirSync(staging, { recursive: true });
  const a = join(staging, "a.png");
  const b = join(staging, "b.jpg");
  writeFileSync(a, "AAA");
  writeFileSync(b, "BBB");
  const wt = join(root, "wt");
  mkdirSync(wt);

  const moved = moveStagedIntoWorktree([a, b], wt);

  expect(moved).toEqual([
    join(worktreeUploadsDir(wt), "a.png"),
    join(worktreeUploadsDir(wt), "b.jpg"),
  ]);
  expect(existsSync(a)).toBe(false); // moved, not copied
  expect(existsSync(b)).toBe(false);
  expect(readFileSync(moved[0]!, "utf8")).toBe("AAA");
  expect(readFileSync(moved[1]!, "utf8")).toBe("BBB");
});

test("sweepStaging deletes files older than maxAge, keeps fresh ones", () => {
  const staging = stagingDir(root);
  mkdirSync(staging, { recursive: true });
  const old = join(staging, "old.png");
  const fresh = join(staging, "fresh.png");
  writeFileSync(old, "x");
  writeFileSync(fresh, "y");
  const now = Date.now();
  // backdate `old` by 48h via utimes
  const twoDaysAgoSec = (now - 48 * 3600_000) / 1000;
  utimesSync(old, twoDaysAgoSec, twoDaysAgoSec);

  sweepStaging(root, 24 * 3600_000, now);

  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});

test("sweepStaging is a no-op when staging dir is absent", () => {
  expect(() => sweepStaging(root, 1000, Date.now())).not.toThrow();
});

test("uploadFilename returns <uuid>.<ext>", () => {
  expect(uploadFilename("png")).toMatch(/^[0-9a-f-]{36}\.png$/);
});

function uploadReq(file: File | null, query = ""): Request {
  const fd = new FormData();
  if (file) fd.append("file", file);
  return new Request(`http://x/api/uploads${query}`, { method: "POST", body: fd });
}

test("handleUpload saves to staging dir when no session given", async () => {
  const store = new SessionStore(":memory:");
  const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
  const res = await handleUpload(uploadReq(file), { store, repoRoot: root });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path.startsWith(stagingDir(root) + "/")).toBe(true);
  expect(body.path.endsWith(".png")).toBe(true);
  expect(existsSync(body.path)).toBe(true);
  // generated name, not the client filename
  expect(body.path.includes("shot.png")).toBe(false);
});

test("handleUpload saves into the session worktree when ?session= is valid", async () => {
  const store = new SessionStore(":memory:");
  const wt = join(root, "wt-sess");
  mkdirSync(wt);
  const s = store.create({
    name: "n",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/n",
    worktreePath: wt,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_a",
    claudeSessionId: "00000000-0000-0000-0000-000000000000",
    model: null,
  });
  const file = new File([new Uint8Array([9])], "x.webp", { type: "image/webp" });
  const res = await handleUpload(uploadReq(file, `?session=${s.id}`), { store, repoRoot: root });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path.startsWith(worktreeUploadsDir(wt) + "/")).toBe(true);
  expect(existsSync(body.path)).toBe(true);
});

test("handleUpload 404s for an unknown session", async () => {
  const store = new SessionStore(":memory:");
  const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
  const res = await handleUpload(uploadReq(file, "?session=nope"), { store, repoRoot: root });
  expect(res.status).toBe(404);
});

test("handleUpload 415s an unsupported type", async () => {
  const store = new SessionStore(":memory:");
  const file = new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" });
  const res = await handleUpload(uploadReq(file), { store, repoRoot: root });
  expect(res.status).toBe(415);
});

test("handleUpload 413s a file over the size cap", async () => {
  const store = new SessionStore(":memory:");
  const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "x.png", { type: "image/png" });
  const res = await handleUpload(uploadReq(big), { store, repoRoot: root });
  expect(res.status).toBe(413);
});

test("handleUpload 400s when the file field is missing", async () => {
  const store = new SessionStore(":memory:");
  const res = await handleUpload(uploadReq(null), { store, repoRoot: root });
  expect(res.status).toBe(400);
});
