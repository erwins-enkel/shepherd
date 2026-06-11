import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  SHEPHERD_IGNORE_GLOB,
  SHEPHERD_EXCLUDE_START,
  SHEPHERD_EXCLUDE_END,
  upsertShepherdIgnoreBlock,
  excludePath,
  ensureShepherdExclude,
} from "../src/shepherd-exclude";

// ── pure upsertShepherdIgnoreBlock tests ─────────────────────────────────────────

test("empty input → block alone, changed:true, ends with \\n, no leading newline", () => {
  const { content, changed } = upsertShepherdIgnoreBlock("");
  expect(changed).toBe(true);
  expect(content).toBe(
    `${SHEPHERD_EXCLUDE_START}\n${SHEPHERD_IGNORE_GLOB}\n${SHEPHERD_EXCLUDE_END}\n`,
  );
  expect(content.startsWith("\n")).toBe(false);
  expect(content.endsWith("\n")).toBe(true);
});

test("input without trailing newline → sep is \\n\\n, block appended", () => {
  const { content, changed } = upsertShepherdIgnoreBlock("# existing comment");
  expect(changed).toBe(true);
  // sep = "\n\n": existing + "\n\n" + block
  expect(content).toBe(
    `# existing comment\n\n${SHEPHERD_EXCLUDE_START}\n${SHEPHERD_IGNORE_GLOB}\n${SHEPHERD_EXCLUDE_END}\n`,
  );
});

test("input ending in \\n → sep is \\n, block appended", () => {
  const { content, changed } = upsertShepherdIgnoreBlock("# existing comment\n");
  expect(changed).toBe(true);
  // sep = "\n": existing ends with \n, add one more \n → blank line, then block
  expect(content).toBe(
    `# existing comment\n\n${SHEPHERD_EXCLUDE_START}\n${SHEPHERD_IGNORE_GLOB}\n${SHEPHERD_EXCLUDE_END}\n`,
  );
});

test("block already present and identical → changed:false, content unchanged", () => {
  const base = upsertShepherdIgnoreBlock("").content;
  const { content, changed } = upsertShepherdIgnoreBlock(base);
  expect(changed).toBe(false);
  expect(content).toBe(base);
});

test("block present but body altered → replaced in place, changed:true", () => {
  const altered = `${SHEPHERD_EXCLUDE_START}\n.some-other-line\nextra-line\n${SHEPHERD_EXCLUDE_END}\n`;
  const { content, changed } = upsertShepherdIgnoreBlock(altered);
  expect(changed).toBe(true);
  expect(content).toContain(SHEPHERD_IGNORE_GLOB);
  expect(content).not.toContain(".some-other-line");
  expect(content).not.toContain("extra-line");
});

test("surrounding content outside markers is preserved", () => {
  const input = `# top comment\n${SHEPHERD_EXCLUDE_START}\nold-line\n${SHEPHERD_EXCLUDE_END}\n# bottom comment\n`;
  const { content } = upsertShepherdIgnoreBlock(input);
  expect(content).toContain("# top comment\n");
  expect(content).toContain("# bottom comment\n");
  expect(content).toContain(SHEPHERD_IGNORE_GLOB);
  expect(content).not.toContain("old-line");
});

test("idempotent: feeding output back → changed:false", () => {
  const first = upsertShepherdIgnoreBlock("# preamble\n").content;
  const { changed } = upsertShepherdIgnoreBlock(first);
  expect(changed).toBe(false);
});

test("bare .shepherd-* line OUTSIDE markers → managed block still appended", () => {
  const input = `${SHEPHERD_IGNORE_GLOB}\n`;
  const { content, changed } = upsertShepherdIgnoreBlock(input);
  // The bare line is outside markers, so we append a fresh managed block
  expect(changed).toBe(true);
  expect(content).toContain(SHEPHERD_EXCLUDE_START);
  expect(content).toContain(SHEPHERD_EXCLUDE_END);
});

// ── integration: shared common-dir + ensureShepherdExclude ───────────────────

// Track temp dirs for cleanup
const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/** Spawn git in `cwd`, stripping ambient GIT_DIR/GIT_INDEX_FILE from the env. */
function git(args: string[], cwd: string): string {
  const env = { ...process.env };
  delete env["GIT_DIR"];
  delete env["GIT_INDEX_FILE"];
  delete env["GIT_WORK_TREE"];
  delete env["GIT_COMMON_DIR"];
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-exclude-test-"));
  tempDirs.push(dir);
  git(["init"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  // Initial commit so worktrees can be added
  git(["commit", "--allow-empty", "-m", "init"], dir);
  return dir;
}

test("excludePath(worktreePath) === excludePath(mainRepoPath) — shared common-dir", () => {
  const mainRepo = makeGitRepo();
  const worktreeDir = mkdtempSync(join(tmpdir(), "shepherd-exclude-wt-"));
  tempDirs.push(worktreeDir);
  git(["worktree", "add", "--detach", worktreeDir], mainRepo);

  const mainExclude = excludePath(mainRepo);
  const wtExclude = excludePath(worktreeDir);
  expect(mainExclude).toBe(wtExclude);
});

test("ensureShepherdExclude writes block visible from both main and worktree", () => {
  const mainRepo = makeGitRepo();
  const worktreeDir = mkdtempSync(join(tmpdir(), "shepherd-exclude-wt2-"));
  tempDirs.push(worktreeDir);
  git(["worktree", "add", "--detach", worktreeDir], mainRepo);

  // Verify the info/ dir may not exist yet (fresh repo); ensureShepherdExclude must handle it
  ensureShepherdExclude(mainRepo);

  const excludeFile = excludePath(mainRepo);
  const content = readFileSync(excludeFile, "utf8");

  expect(content).toContain(SHEPHERD_EXCLUDE_START);
  expect(content).toContain(SHEPHERD_IGNORE_GLOB);
  expect(content).toContain(SHEPHERD_EXCLUDE_END);

  // The same file is shared — reading via the worktree path must give identical content
  const wtExcludePath = excludePath(worktreeDir);
  const wtContent = readFileSync(wtExcludePath, "utf8");
  expect(wtContent).toBe(content);
});

test("ensureShepherdExclude is idempotent when called twice", () => {
  const mainRepo = makeGitRepo();
  ensureShepherdExclude(mainRepo);
  const after1 = readFileSync(excludePath(mainRepo), "utf8");
  ensureShepherdExclude(mainRepo);
  const after2 = readFileSync(excludePath(mainRepo), "utf8");
  expect(after2).toBe(after1);
});

test("ensureShepherdExclude does not throw on a non-git path (best-effort)", () => {
  const nonGit = mkdtempSync(join(tmpdir(), "shepherd-exclude-nogit-"));
  tempDirs.push(nonGit);
  // Must not throw
  expect(() => ensureShepherdExclude(nonGit)).not.toThrow();
});

test("git status in worktree ignores .shepherd-* artifacts after ensureShepherdExclude", () => {
  const mainRepo = makeGitRepo();
  const worktreeDir = mkdtempSync(join(tmpdir(), "shepherd-exclude-gitstatus-"));
  tempDirs.push(worktreeDir);
  git(["worktree", "add", "--detach", worktreeDir], mainRepo);

  // BEFORE: .shepherd-plan.md should appear as untracked (proves the test is meaningful)
  writeFileSync(join(worktreeDir, ".shepherd-plan.md"), "# plan\n");
  const beforeStatus = git(["status", "--porcelain"], worktreeDir);
  expect(beforeStatus).toContain(".shepherd-plan.md");

  // Apply the exclude
  ensureShepherdExclude(mainRepo);

  // Create shepherd artifacts in the worktree
  mkdirSync(join(worktreeDir, ".shepherd-uploads"), { recursive: true });
  writeFileSync(join(worktreeDir, ".shepherd-uploads", "x.png"), "");

  // Control: a non-shepherd untracked file that must still show up
  writeFileSync(join(worktreeDir, "unrelated.txt"), "hello\n");

  const status = git(["status", "--porcelain"], worktreeDir);

  // Shepherd artifacts must be excluded
  expect(status).not.toContain(".shepherd-plan.md");
  expect(status).not.toContain(".shepherd-uploads");

  // Control file must remain visible (exclude is selective, not hiding everything)
  expect(status).toContain("unrelated.txt");
});
