import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  listRepos,
  listReposPathForReal,
  readTodo,
  writeTodo,
  cloneRepo,
  classifyCloneError,
} from "../src/repos";
import { realpathSync } from "node:fs";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shepherd-repos-test-"));
  mkdirSync(join(root, "alpha"));
  mkdirSync(join(root, "beta"));
  writeFileSync(join(root, "README"), "not a dir");
  mkdirSync(join(root, ".hidden"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// ── listRepos ─────────────────────────────────────────────────────────────────

test("listRepos returns sorted dirs, excludes file and dotdir", () => {
  const repos = listRepos(root);
  expect(repos.map((r) => r.name)).toEqual(["alpha", "beta"]);
  expect(repos[0]!.path).toBe(join(root, "alpha"));
  expect(repos[1]!.path).toBe(join(root, "beta"));
});

test("listRepos returns [] for nonexistent root", () => {
  expect(listRepos(join(root, "nonexistent"))).toEqual([]);
});

// ── listReposPathForReal (post-merge backlog refresh key reconciliation) ───────

test("listReposPathForReal maps a realpath back to listRepos' join(repoRoot, name) key", () => {
  // A symlinked repoRoot is exactly where the merge path's realpath-resolved dir
  // diverges from the raw join(repoRoot, name) the counts cache + buildBacklogPayload
  // key by. linkRoot → root, so listRepos enumerates under linkRoot while the merge
  // path (safeRepoDir) hands us the real path.
  const linkRoot = join(tmpdir(), `shepherd-repos-link-${process.pid}-${root.split("-").pop()}`);
  symlinkSync(root, linkRoot, "dir");
  try {
    const enumerated = join(linkRoot, "alpha"); // the key listRepos / readers use
    const realDir = realpathSync(enumerated); // what safeRepoDir would yield
    // Precondition: the two forms genuinely diverge under the symlink, so this
    // test would fail if the reconciliation were a no-op.
    expect(realDir).not.toBe(enumerated);

    // The fix: realpath → the enumerated key the readers (and warmer) cache by, so
    // refresh writes the same entry buildBacklogPayload later reads.
    expect(listReposPathForReal(realDir, linkRoot)).toBe(enumerated);
  } finally {
    rmSync(linkRoot, { force: true });
  }
});

test("listReposPathForReal returns the dir unchanged when no enumerated repo matches", () => {
  const outside = join(tmpdir(), "definitely-not-under-repoRoot");
  expect(listReposPathForReal(outside, root)).toBe(outside);
});

// ── readTodo ──────────────────────────────────────────────────────────────────

test("readTodo: no TODO.md → ok:true exists:false content:''", () => {
  const r = readTodo(join(root, "alpha"), root);
  expect(r).toEqual({ ok: true, exists: false, content: "" });
});

test("readTodo: outside repoRoot → ok:false", () => {
  const r = readTodo("/etc", root);
  expect(r.ok).toBe(false);
});

// ── writeTodo + round-trip ────────────────────────────────────────────────────

test("writeTodo writes and readTodo reads back (round-trip)", () => {
  const repoPath = join(root, "alpha");
  const wrote = writeTodo(repoPath, root, "- [ ] x");
  expect(wrote).toBe(true);
  const r = readTodo(repoPath, root);
  expect(r).toEqual({ ok: true, exists: true, content: "- [ ] x" });
});

test("writeTodo: outside repoRoot → false", () => {
  expect(writeTodo("/etc", root, "x")).toBe(false);
});

test("writeTodo: content > 100_000 chars → false", () => {
  expect(writeTodo(join(root, "alpha"), root, "x".repeat(100_001))).toBe(false);
});

test("writeTodo: content exactly 100_000 chars → true", () => {
  expect(writeTodo(join(root, "alpha"), root, "x".repeat(100_000))).toBe(true);
});

// ── symlink containment (security) ─────────────────────────────────────────────

test("a symlink inside repoRoot pointing outside is rejected (realpath containment)", () => {
  const outside = mkdtempSync(join(tmpdir(), "shepherd-outside-"));
  try {
    symlinkSync(outside, join(root, "escape"), "dir");
    // lexically join(root,"escape") looks inside root, but realpath is outside → reject
    expect(readTodo(join(root, "escape"), root).ok).toBe(false);
    expect(writeTodo(join(root, "escape"), root, "pwned")).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── cloneRepo ─────────────────────────────────────────────────────────────────

/** Create a minimal bare git repo so we can clone from a file:// URL. */
function makeBareSrc(parent: string): string {
  const bare = join(parent, "bare-src.git");
  execFileSync("git", ["init", "--bare", bare], { stdio: "pipe" });
  return bare;
}

test("cloneRepo happy path: clones repo, returns entry with correct name/path, dir exists", () => {
  const cloneRoot = mkdtempSync(join(tmpdir(), "shepherd-clone-root-"));
  try {
    const bareSrc = makeBareSrc(cloneRoot);
    const url = `file://${bareSrc}`;
    const result = cloneRepo(url, "my-clone", cloneRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow type
    expect(result.entry.name).toBe("my-clone");
    expect(result.entry.path).toBe(join(cloneRoot, "my-clone"));
    expect(existsSync(result.entry.path)).toBe(true);
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true });
  }
});

test("cloneRepo: returns clonerepo_failed_exists when target dir already exists", () => {
  const cloneRoot = mkdtempSync(join(tmpdir(), "shepherd-clone-root-"));
  try {
    const bareSrc = makeBareSrc(cloneRoot);
    const url = `file://${bareSrc}`;
    // pre-create the target
    mkdirSync(join(cloneRoot, "already-there"));
    const result = cloneRepo(url, "already-there", cloneRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("clonerepo_failed_exists");
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true });
  }
});

test("cloneRepo: returns clonerepo_failed_outside for a name containing '..'", () => {
  const cloneRoot = mkdtempSync(join(tmpdir(), "shepherd-clone-root-"));
  try {
    const bareSrc = makeBareSrc(cloneRoot);
    const url = `file://${bareSrc}`;
    const result = cloneRepo(url, "../escape", cloneRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("clonerepo_failed_outside");
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true });
  }
});

// ── classifyCloneError ────────────────────────────────────────────────────────

test("classifyCloneError: killed+SIGTERM → clonerepo_failed_timeout", () => {
  expect(classifyCloneError({ killed: true, signal: "SIGTERM" })).toBe("clonerepo_failed_timeout");
});

test("classifyCloneError: stderr 'Authentication failed' → clonerepo_failed_auth", () => {
  expect(classifyCloneError({ stderr: Buffer.from("fatal: Authentication failed") })).toBe(
    "clonerepo_failed_auth",
  );
});

test("classifyCloneError: stderr 'destination path … already exists' → clonerepo_failed_exists", () => {
  expect(
    classifyCloneError({
      stderr: Buffer.from(
        "fatal: destination path 'x' already exists and is not an empty directory",
      ),
    }),
  ).toBe("clonerepo_failed_exists");
});

test("classifyCloneError: stderr 'repository not found' → clonerepo_failed_url", () => {
  expect(classifyCloneError({ stderr: Buffer.from("ERROR: Repository not found.") })).toBe(
    "clonerepo_failed_url",
  );
});

test("classifyCloneError: empty error object → clonerepo_failed_url (fallback)", () => {
  expect(classifyCloneError({})).toBe("clonerepo_failed_url");
});
