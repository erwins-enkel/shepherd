import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extForMime,
  imageExtForMime,
  sessionAttachExtForMime,
  MAX_UPLOAD_BYTES,
  MAX_REQUEST_BODY_BYTES,
  stagingDir,
  worktreeUploadsDir,
  copyStagedIntoWorktree,
  sweepStaging,
  uploadExtension,
  uploadExtensionFromName,
  uploadFilename,
  handleUpload,
} from "../src/uploads";
import { SessionStore } from "../src/store";

test("extForMime maps supported staged upload types", () => {
  expect(extForMime("image/png")).toBe("png");
  expect(extForMime("image/jpeg")).toBe("jpg");
  expect(extForMime("image/gif")).toBe("gif");
  expect(extForMime("image/webp")).toBe("webp");
  expect(extForMime("application/pdf")).toBe("pdf");
  expect(extForMime("text/markdown")).toBe("md");
  expect(extForMime("text/plain")).toBe("txt");
  expect(extForMime("video/mp4")).toBe("mp4");
  expect(extForMime("video/quicktime")).toBe("mov");
  expect(extForMime("video/webm")).toBe("webm");
  expect(extForMime("video/x-m4v")).toBe("m4v");
  expect(extForMime("")).toBeNull();
});

test("imageExtForMime remains image-only for live terminal uploads", () => {
  expect(imageExtForMime("image/png")).toBe("png");
  expect(imageExtForMime("image/jpeg")).toBe("jpg");
  expect(imageExtForMime("application/pdf")).toBeNull();
  expect(imageExtForMime("text/plain")).toBeNull();
  expect(imageExtForMime("video/mp4")).toBeNull();
});

test("sessionAttachExtForMime accepts images and videos, nothing else", () => {
  expect(sessionAttachExtForMime("image/png")).toBe("png");
  expect(sessionAttachExtForMime("video/mp4")).toBe("mp4");
  expect(sessionAttachExtForMime("video/quicktime")).toBe("mov");
  expect(sessionAttachExtForMime("application/pdf")).toBeNull();
  expect(sessionAttachExtForMime("text/plain")).toBeNull();
});

test("MAX_UPLOAD_BYTES is 250 MB", () => {
  expect(MAX_UPLOAD_BYTES).toBe(250 * 1024 * 1024);
});

test("transport cap stays above the app limit so the app-level 413 is reachable", () => {
  expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(MAX_UPLOAD_BYTES);
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

test("copyStagedIntoWorktree copies files in, keeping the staged source recoverable", () => {
  const staging = stagingDir(root);
  mkdirSync(staging, { recursive: true });
  const a = join(staging, "a.png");
  const b = join(staging, "b.jpg");
  writeFileSync(a, "AAA");
  writeFileSync(b, "BBB");
  const wt = join(root, "wt");
  mkdirSync(wt);

  const copied = copyStagedIntoWorktree([a, b], wt);

  expect(copied).toEqual([
    { src: a, copiedPath: join(worktreeUploadsDir(wt), "a.png") },
    { src: b, copiedPath: join(worktreeUploadsDir(wt), "b.jpg") },
  ]);
  expect(existsSync(a)).toBe(true); // copied, not moved — survives a failed/retried spawn
  expect(existsSync(b)).toBe(true);
  expect(readFileSync(copied[0]!.copiedPath!, "utf8")).toBe("AAA");
  expect(readFileSync(copied[1]!.copiedPath!, "utf8")).toBe("BBB");
});

test("copyStagedIntoWorktree skips a missing source and copies the rest", () => {
  const staging = stagingDir(root);
  mkdirSync(staging, { recursive: true });
  const present = join(staging, "present.png");
  const gone = join(staging, "gone.png"); // never created — simulates a swept upload
  writeFileSync(present, "OK");
  const wt = join(root, "wt");
  mkdirSync(wt);

  const copied = copyStagedIntoWorktree([gone, present], wt);

  // The missing source is marked (not thrown on); the present one is copied through.
  expect(copied).toEqual([
    { src: gone, copiedPath: null },
    { src: present, copiedPath: join(worktreeUploadsDir(wt), "present.png") },
  ]);
  expect(existsSync(join(worktreeUploadsDir(wt), "gone.png"))).toBe(false);
  expect(readFileSync(copied[1]!.copiedPath!, "utf8")).toBe("OK");
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

test("uploadExtension derives bounded safe extensions for staged attachments", () => {
  expect(uploadExtension(new File(["x"], "report.pdf", { type: "application/pdf" }))).toBe("pdf");
  // MIME fallback for a nameless video — unit-level only: Bun's multipart round-trip
  // re-infers the part type from the filename extension, so this can't be exercised
  // through handleUpload with an extension-less name.
  expect(uploadExtension(new File(["x"], "clip", { type: "video/mp4" }))).toBe("mp4");
  expect(uploadExtension(new File(["x"], "notes.md", { type: "" }))).toBe("md");
  expect(uploadExtension(new File(["x"], "todo", { type: "text/plain" }))).toBe("txt");
  expect(uploadExtension(new File(["x"], "noext", { type: "" }))).toBe("bin");
  expect(uploadExtension(new File(["x"], "bad.sh!", { type: "text/plain" }))).toBe("bin");
  expect(uploadExtension(new File(["x"], "huge." + "a".repeat(40), { type: "" }))).toBe("bin");
});

test("uploadExtensionFromName falls back safely for relaunch carry names", () => {
  expect(uploadExtensionFromName("orig.md")).toBe("md");
  expect(uploadExtensionFromName("orig")).toBe("bin");
  expect(uploadExtensionFromName("orig." + "x".repeat(40))).toBe("bin");
  expect(uploadExtensionFromName("orig.bad!")).toBe("bin");
});

test("uploadFilename returns <uuid>.<ext>", () => {
  expect(uploadFilename("png")).toMatch(/^[0-9a-f-]{36}\.png$/);
  expect(uploadFilename("")).toMatch(/^[0-9a-f-]{36}\.bin$/);
  expect(uploadFilename("a".repeat(40))).toMatch(/^[0-9a-f-]{36}\.bin$/);
});

test("uploadExtensionFromName preserves only a bounded safe extension", () => {
  expect(uploadExtensionFromName("../evil.md")).toBe("md");
  expect(uploadExtensionFromName("brief.final.PDF")).toBe("pdf");
  expect(uploadExtensionFromName("weird.na/me.m*d")).toBe("bin");
  expect(uploadExtensionFromName("README")).toBe("bin");
  expect(uploadExtensionFromName("...")).toBe("bin");
  expect(uploadExtensionFromName("")).toBe("bin");
});

function uploadReq(file: File | null, query = ""): Request {
  const fd = new FormData();
  if (file) fd.append("file", file);
  return new Request(`http://x/api/uploads${query}`, { method: "POST", body: fd });
}

test("handleUpload saves a staged image attachment when no session given", async () => {
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

test("handleUpload saves staged non-image attachments when no session given", async () => {
  const store = new SessionStore(":memory:");
  const cases = [
    new File([new Uint8Array([1])], "doc.pdf", { type: "application/pdf" }),
    new File([new Uint8Array([2])], "notes.md", { type: "" }),
    new File([new Uint8Array([3])], "readme.txt", { type: "text/plain" }),
    new File([new Uint8Array([4])], "noext", { type: "" }),
    new File([new Uint8Array([5])], "unsafe." + "x".repeat(40), { type: "" }),
    new File([new Uint8Array([6])], "ScreenRecording.mov", { type: "video/quicktime" }),
  ];
  const endings = [".pdf", ".md", ".txt", ".bin", ".bin", ".mov"];
  for (let i = 0; i < cases.length; i++) {
    const res = await handleUpload(uploadReq(cases[i]!), { store, repoRoot: root });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path.startsWith(stagingDir(root) + "/")).toBe(true);
    expect(body.path.endsWith(endings[i]!)).toBe(true);
    expect(existsSync(body.path)).toBe(true);
  }
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

test("handleUpload accepts video uploads on the ?session= path", async () => {
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
  const cases: Array<[string, string, string]> = [
    ["rec.mp4", "video/mp4", ".mp4"],
    ["rec.mov", "video/quicktime", ".mov"],
  ];
  for (const [name, type, ending] of cases) {
    const file = new File([new Uint8Array([9])], name, { type });
    const res = await handleUpload(uploadReq(file, `?session=${s.id}`), { store, repoRoot: root });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path.startsWith(worktreeUploadsDir(wt) + "/")).toBe(true);
    expect(body.path.endsWith(ending)).toBe(true);
    expect(existsSync(body.path)).toBe(true);
  }
});

test("handleUpload keeps ?session= uploads image/video-only", async () => {
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
  const file = new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" });
  const res = await handleUpload(uploadReq(file, `?session=${s.id}`), { store, repoRoot: root });
  expect(res.status).toBe(415);
});

test("handleUpload 404s for an unknown session", async () => {
  const store = new SessionStore(":memory:");
  const file = new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" });
  const res = await handleUpload(uploadReq(file, "?session=nope"), { store, repoRoot: root });
  expect(res.status).toBe(404);
});

test("handleUpload falls back to bin for an unsupported staged type", async () => {
  const store = new SessionStore(":memory:");
  const file = new File([new Uint8Array([1])], "x", { type: "application/octet-stream" });
  const res = await handleUpload(uploadReq(file), { store, repoRoot: root });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path.startsWith(stagingDir(root) + "/")).toBe(true);
  expect(body.path.endsWith(".bin")).toBe(true);
  expect(existsSync(body.path)).toBe(true);
});

test("handleUpload accepts an empty MIME file and falls back for extensionless names", async () => {
  const store = new SessionStore(":memory:");
  const file = new File([new Uint8Array([1])], "README", { type: "" });
  const res = await handleUpload(uploadReq(file), { store, repoRoot: root });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path.endsWith(".bin")).toBe(true);
  expect(existsSync(body.path)).toBe(true);
});

// The 413 boundary runs against an injected tiny limit (maxUploadBytes seam) so no test
// allocates limit-sized fixtures; the real-server transport test in server.test.ts is the
// single deliberately-large upload in the suite. Fixture contents are ASCII: Bun's
// multipart round-trip corrupts parts whose bytes are all NUL (name lost, size 0).
test("handleUpload 413s a file over the size cap, accepts one exactly at it", async () => {
  const store = new SessionStore(":memory:");
  const atLimit = new File(["A".repeat(8)], "ok.png", { type: "image/png" });
  const okRes = await handleUpload(uploadReq(atLimit), {
    store,
    repoRoot: root,
    maxUploadBytes: 8,
  });
  expect(okRes.status).toBe(200);

  const over = new File(["A".repeat(9)], "big.png", { type: "image/png" });
  const res = await handleUpload(uploadReq(over), { store, repoRoot: root, maxUploadBytes: 8 });
  expect(res.status).toBe(413);
  expect((await res.json()).error).toBe("file too large");
});

test("handleUpload 413s an over-limit upload on the ?session= path too", async () => {
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
  const over = new File(["A".repeat(9)], "rec.mp4", { type: "video/mp4" });
  const res = await handleUpload(uploadReq(over, `?session=${s.id}`), {
    store,
    repoRoot: root,
    maxUploadBytes: 8,
  });
  expect(res.status).toBe(413);
});

test("handleUpload 400s when the file field is missing", async () => {
  const store = new SessionStore(":memory:");
  const res = await handleUpload(uploadReq(null), { store, repoRoot: root });
  expect(res.status).toBe(400);
});
