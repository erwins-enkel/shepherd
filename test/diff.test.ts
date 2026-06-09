import { test, expect } from "bun:test";
import { parseUnifiedDiff } from "../src/diff";

const MODIFIED = `diff --git a/src/server.ts b/src/server.ts
index 1111111..2222222 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -40,3 +40,4 @@ function makeApp() {
   const url = new URL(req.url);
-  // old handler
+  if (parts[3] === "diff") {
+    return json(computeDiff());
+  }
`;

const ADDED = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;

const DELETED = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const gone = true;
`;

const RENAMED = `diff --git a/old/name.ts b/new/name.ts
similarity index 100%
rename from old/name.ts
rename to new/name.ts
`;

const BINARY = `diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
`;

test("parses a modified file with adds/dels/context and line numbers", () => {
  const files = parseUnifiedDiff(MODIFIED);
  expect(files).toHaveLength(1);
  const f = files[0]!;
  expect(f.path).toBe("src/server.ts");
  expect(f.status).toBe("modified");
  expect(f.binary).toBe(false);
  expect(f.additions).toBe(3);
  expect(f.deletions).toBe(1);
  expect(f.hunks).toHaveLength(1);
  const lines = f.hunks[0]!.lines;
  expect(lines[0]).toMatchObject({ kind: "ctx", oldNo: 40, newNo: 40 });
  const del = lines.find((l) => l.kind === "del")!;
  expect(del.content).toBe("  // old handler");
  expect(del.oldNo).toBe(41);
  expect(del.newNo).toBeUndefined();
  const firstAdd = lines.find((l) => l.kind === "add")!;
  expect(firstAdd.content).toBe('  if (parts[3] === "diff") {');
  expect(firstAdd.newNo).toBe(41);
});

test("parses an added file", () => {
  const f = parseUnifiedDiff(ADDED)[0]!;
  expect(f.path).toBe("new.ts");
  expect(f.status).toBe("added");
  expect(f.additions).toBe(2);
  expect(f.deletions).toBe(0);
});

test("parses a deleted file", () => {
  const f = parseUnifiedDiff(DELETED)[0]!;
  expect(f.path).toBe("gone.ts");
  expect(f.status).toBe("deleted");
  expect(f.deletions).toBe(1);
});

test("parses a pure rename (no content hunks)", () => {
  const f = parseUnifiedDiff(RENAMED)[0]!;
  expect(f.status).toBe("renamed");
  expect(f.oldPath).toBe("old/name.ts");
  expect(f.path).toBe("new/name.ts");
  expect(f.hunks).toHaveLength(0);
});

test("flags binary files with no hunks", () => {
  const f = parseUnifiedDiff(BINARY)[0]!;
  expect(f.path).toBe("logo.png");
  expect(f.binary).toBe(true);
  expect(f.hunks).toHaveLength(0);
});

test("parses multiple files in one diff", () => {
  const files = parseUnifiedDiff(ADDED + DELETED);
  expect(files).toHaveLength(2);
  expect(files.map((f) => f.path)).toEqual(["new.ts", "gone.ts"]);
});

test("truncates files over the per-file line cap", () => {
  const big = Array.from({ length: 2100 }, (_, i) => `+line ${i}`).join("\n");
  const text = `diff --git a/big.ts b/big.ts
--- /dev/null
+++ b/big.ts
@@ -0,0 +1,2100 @@
${big}
`;
  const f = parseUnifiedDiff(text)[0]!;
  expect(f.truncated).toBe(true);
  expect(f.hunks).toHaveLength(0);
  expect(f.additions).toBe(2100);
});

test("MAX_TOTAL_LINES: stops parsing after global cap, marks over-cap file truncated", () => {
  // Each file has 1000 lines (under per-file cap of 2000). Generate 102 files →
  // 102k total lines, exceeding MAX_TOTAL_LINES (100k). At least one file parses
  // clean and at least one is marked truncated by the global cap.
  const makeFile = (name: string, n: number) => {
    const lines = Array.from({ length: n }, (_, i) => `+line ${i}`).join("\n");
    return `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${n} @@\n${lines}\n`;
  };
  const text = Array.from({ length: 102 }, (_, i) => makeFile(`file${i}.ts`, 1000)).join("");
  const files = parseUnifiedDiff(text);
  expect(files).toHaveLength(102);
  // Files within the first 100k lines are untruncated
  const cleanFiles = files.filter((f) => !f.truncated);
  const truncatedFiles = files.filter((f) => f.truncated);
  expect(cleanFiles.length).toBeGreaterThan(0);
  expect(truncatedFiles.length).toBeGreaterThan(0);
  // The truncated files have no hunks but still carry correct status + path metadata
  for (const f of truncatedFiles) {
    expect(f.hunks).toHaveLength(0);
    expect(f.status).toBe("added");
    expect(f.path).toMatch(/^file\d+\.ts$/);
  }
});

test("MAX_TOTAL_LINES: small diff unaffected", () => {
  const files = parseUnifiedDiff(ADDED + DELETED + MODIFIED);
  expect(files.every((f) => !f.truncated)).toBe(true);
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { computeDiff } from "../src/diff";

// Explicit env that does NOT inherit ambient GIT_DIR/local git vars — running
// under a git hook with GIT_DIR set would otherwise scribble the real repo.
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" }).toString();

test("computeDiff: branch vs base shows committed changes, local fallback when no remote", async () => {
  const repo = mkdtempSync(join(tmpdir(), "shepherd-diff-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature change");

    const r = await computeDiff(repo, "main", "feature");
    expect(r.head).toBe("feature");
    expect(r.fetchFailed).toBe(true);
    expect(r.baseRef).toBe("main");
    expect(r.files).toHaveLength(1);
    expect(r.files[0]!.path).toBe("a.txt");
    expect(r.files[0]!.additions).toBe(1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("computeDiff: diffs against origin/<base> when a remote exists", async () => {
  const remote = mkdtempSync(join(tmpdir(), "shepherd-remote-"));
  const repo = mkdtempSync(join(tmpdir(), "shepherd-diff-origin-"));
  try {
    git(remote, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature change");

    const r = await computeDiff(repo, "main", "feature");
    expect(r.fetchFailed).toBe(false);
    expect(r.baseRef).toBe("origin/main");
    expect(r.files).toHaveLength(1);
    expect(r.files[0]!.additions).toBe(1);
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("computeDiff: non-isolated session (no branch) → empty result", async () => {
  const r = await computeDiff("/nonexistent", "main", null);
  expect(r.files).toEqual([]);
  expect(r.head).toBeNull();
  expect(r.fetchFailed).toBe(false);
});
