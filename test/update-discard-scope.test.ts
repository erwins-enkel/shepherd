import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateService } from "../src/update";

// Real-git integration: prove the scoped, path-limited discard restores exactly the
// confirmed paths per category (modify / rename / add / non-UTF-8) and that pathspec
// magic in a confirmed filename can't fan out to unconfirmed files.

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function newRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "shepherd-scope-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  return repo;
}

/** Mirror update.sh's two-step scoped discard (with --literal-pathspecs). */
function scopedDiscard(repo: string, all: Buffer, wt: Buffer): void {
  const spec = mkdtempSync(join(tmpdir(), "shepherd-spec-"));
  const allFile = join(spec, "all");
  const wtFile = join(spec, "wt");
  writeFileSync(allFile, all);
  writeFileSync(wtFile, wt);
  git(
    repo,
    "--literal-pathspecs",
    "restore",
    "--source=HEAD",
    "--staged",
    `--pathspec-from-file=${allFile}`,
    "--pathspec-file-nul",
  );
  if (wt.length > 0)
    git(
      repo,
      "--literal-pathspecs",
      "restore",
      "--source=HEAD",
      "--worktree",
      `--pathspec-from-file=${wtFile}`,
      "--pathspec-file-nul",
    );
}

/** Tracked tree is clean (what the --pull guard checks). */
function trackedClean(repo: string): boolean {
  return git(repo, "status", "--porcelain", "--untracked-files=no").trim() === "";
}

test("scoped discard leaves an UNCONFIRMED path dirty (last-window safety)", async () => {
  const repo = newRepo();
  writeFileSync(join(repo, "a.txt"), "a0\n");
  writeFileSync(join(repo, "b.txt"), "b0\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  // confirm only a.txt
  writeFileSync(join(repo, "a.txt"), "a-EDIT\n");
  const confirmed = await new UpdateService({ repoDir: repo, launch: () => {} }).dirtyStatus();

  // AFTER confirmation, an unconfirmed change to b.txt appears
  writeFileSync(join(repo, "b.txt"), "b-EDIT\n");

  scopedDiscard(repo, confirmed.pathspecAll, confirmed.pathspecWorktree);

  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a0\n"); // confirmed → restored
  expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("b-EDIT\n"); // unconfirmed → untouched
  // A blanket `git reset --hard` would have wiped b.txt too.
});

test("staged rename: tracked state fully restored (both sides in pathspec)", async () => {
  const repo = newRepo();
  writeFileSync(join(repo, "a.txt"), "hi\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "mv", "a.txt", "b.txt");

  const d = await new UpdateService({ repoDir: repo, launch: () => {} }).dirtyStatus();
  scopedDiscard(repo, d.pathspecAll, d.pathspecWorktree);

  expect(trackedClean(repo)).toBe(true); // rename undone at the tracked level
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("hi\n"); // old path back
  // b.txt (the new side) is allowed to linger as untracked — non-destructive
});

test("staged add is preserved as an untracked file (never deleted)", async () => {
  const repo = newRepo();
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  writeFileSync(join(repo, "created.txt"), "my work\n");
  git(repo, "add", "created.txt");

  const d = await new UpdateService({ repoDir: repo, launch: () => {} }).dirtyStatus();
  scopedDiscard(repo, d.pathspecAll, d.pathspecWorktree);

  expect(trackedClean(repo)).toBe(true); // guard passes (untracked doesn't block)
  expect(existsSync(join(repo, "created.txt"))).toBe(true);
  expect(readFileSync(join(repo, "created.txt"), "utf8")).toBe("my work\n"); // content kept
  expect(git(repo, "status", "--porcelain")).toContain("?? created.txt"); // now untracked
});

test("non-UTF-8 path is restored via the byte-verbatim pathspec", async () => {
  const repo = newRepo();
  // a real 0xff byte in the filename → only expressible as a Buffer path (a
  // string round-trip would re-encode it as UTF-8 and defeat the test)
  const fullPath = Buffer.concat([
    Buffer.from(`${repo}/`, "utf8"),
    Buffer.from([0x66, 0x6f, 0x6f, 0xff, 0x2e, 0x74, 0x78, 0x74]),
  ]);
  writeFileSync(fullPath, "orig\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  writeFileSync(fullPath, "changed\n");

  const d = await new UpdateService({ repoDir: repo, launch: () => {} }).dirtyStatus();
  // the raw pathspec must carry the 0xff byte verbatim (a lossy string would drop it)
  expect(d.pathspecAll.includes(0xff)).toBe(true);
  scopedDiscard(repo, d.pathspecAll, d.pathspecWorktree);

  expect(trackedClean(repo)).toBe(true);
  expect(readFileSync(fullPath, "utf8")).toBe("orig\n");
});

test("pathspec magic in a confirmed filename stays literal (no fan-out)", async () => {
  const repo = newRepo();
  writeFileSync(join(repo, "*.ts"), "star0\n"); // a file literally named *.ts
  writeFileSync(join(repo, "other.ts"), "other0\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  // confirm ONLY the literal "*.ts"
  writeFileSync(join(repo, "*.ts"), "star-EDIT\n");
  const confirmed = await new UpdateService({ repoDir: repo, launch: () => {} }).dirtyStatus();

  // an unconfirmed sibling that a *.ts GLOB would match becomes dirty afterwards
  writeFileSync(join(repo, "other.ts"), "other-EDIT\n");

  scopedDiscard(repo, confirmed.pathspecAll, confirmed.pathspecWorktree);

  expect(readFileSync(join(repo, "*.ts"), "utf8")).toBe("star0\n"); // literal restored
  expect(readFileSync(join(repo, "other.ts"), "utf8")).toBe("other-EDIT\n"); // NOT matched
});
