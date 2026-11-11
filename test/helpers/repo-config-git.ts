import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

/** Plain clones (no worktrees or installed deps) and a local bare origin. */
export function configRepo(root = tmpdir(), branch = "main") {
  const dir = mkdtempSync(join(root, "shepherd-config-test-"));
  const origin = join(dir, "origin.git");
  const a = join(dir, "a");
  const b = join(dir, "b");
  mkdirSync(origin);
  git(origin, "init", "--bare", `--initial-branch=${branch}`);
  git(dir, "clone", origin, a);
  git(a, "config", "user.name", "Config Test");
  git(a, "config", "user.email", "config@example.test");
  writeFileSync(join(a, "README"), "base\n");
  git(a, "add", "README");
  git(a, "commit", "-m", "base");
  git(a, "push", "origin", branch);
  git(dir, "clone", origin, b);
  git(b, "config", "user.name", "Config Test");
  git(b, "config", "user.email", "config@example.test");
  // The first clone was made before origin had a default commit.
  git(a, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`);
  return {
    dir,
    origin,
    a,
    b,
    branch,
    commit(content: string) {
      mkdirSync(join(a, ".shepherd"), { recursive: true });
      writeFileSync(join(a, ".shepherd/config.json"), content);
      git(a, "add", ".shepherd/config.json");
      git(a, "commit", "-m", "config");
      git(a, "push", "origin", branch);
      return git(a, "rev-parse", "HEAD");
    },
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
