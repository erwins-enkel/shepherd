/** Real-git fixtures for the safe-git tests: a bare origin, an operator clone configured like a
 *  husky repo (RELATIVE core.hooksPath), and marker scripts that record whether git ran them. */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
};

/** Raw (unhardened) git for building fixtures — never for the code under test. */
export function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, stdio: "pipe", encoding: "utf8" }).trim();
}

export interface Fixture {
  root: string;
  origin: string;
  repo: string;
  /** Append-only log every planted marker script writes to. */
  marker: string;
}

/** Bare origin with `main` (one commit) + an operator clone with core.hooksPath=.husky/_. */
export function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "shepherd-safegit-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const marker = join(root, "marker.log");
  g(root, "init", "-q", "--bare", "-b", "main", origin);
  g(root, "clone", "-q", origin, repo);
  g(repo, "config", "core.hooksPath", ".husky/_");
  writeFileSync(join(repo, "README.md"), "hi\n");
  g(repo, "add", "README.md");
  g(repo, "commit", "-q", "-m", "init");
  g(repo, "push", "-q", "origin", "main");
  return { root, origin, repo, marker };
}

/** An executable script that appends `tag` to the marker log. */
export function plantScript(path: string, marker: string, tag: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho "${tag}" >> '${marker}'\n`);
  chmodSync(path, 0o755);
}

export function markerLines(marker: string): string[] {
  return existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean) : [];
}

/** Advance origin/main from a scratch clone so the next fetch updates a ref. */
export function advanceOrigin(f: Fixture, file = "advance.txt"): void {
  const scratch = mkdtempSync(join(f.root, "adv-"));
  g(scratch, "clone", "-q", f.origin, "c");
  const c = join(scratch, "c");
  writeFileSync(join(c, file), `${Date.now()}\n`);
  g(c, "add", file);
  g(c, "commit", "-q", "-m", `advance ${file}`);
  g(c, "push", "-q", "origin", "main");
}
