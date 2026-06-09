import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDefaultBranch, fastForwardDefaultBranch } from "../src/pull";

// House rule: root tests honor an ambient GIT_DIR. Never lean on cwd/ambient git
// env — pass explicit cwd + a scrubbed env to every fixture git call so a stray
// GIT_DIR can't redirect setup commands onto the real repo.
const GIT_ENV = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

function head(dir: string): string {
  return git(dir, "rev-parse", "HEAD");
}

describe("pull", () => {
  let root: string;
  let origin: string; // bare remote
  let clone: string; // the canonical clone we fast-forward
  let seed: string; // a second clone used to push new commits to origin

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pull-test-"));
    origin = join(root, "origin.git");
    clone = join(root, "clone");
    seed = join(root, "seed");

    // Bare origin with a deterministic default branch (host init.defaultBranch varies).
    execFileSync("git", ["init", "--bare", "-b", "main", origin], { env: GIT_ENV });

    // Seed clone: initial commit on main, pushed to origin.
    execFileSync("git", ["clone", origin, seed], { env: GIT_ENV });
    git(seed, "config", "user.email", "seed@example.com");
    git(seed, "config", "user.name", "Seed");
    writeFileSync(join(seed, "a.txt"), "1\n");
    git(seed, "add", "a.txt");
    git(seed, "commit", "-m", "initial");
    git(seed, "push", "origin", "main");

    // The clone under test.
    execFileSync("git", ["clone", origin, clone], { env: GIT_ENV });
    git(clone, "config", "user.email", "clone@example.com");
    git(clone, "config", "user.name", "Clone");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function advanceOrigin(content: string) {
    writeFileSync(join(seed, "a.txt"), content);
    git(seed, "add", "a.txt");
    git(seed, "commit", "-m", `change ${content.trim()}`);
    git(seed, "push", "origin", "main");
  }

  describe("fastForwardDefaultBranch", () => {
    test("behind → updated:true, HEAD advances to origin", async () => {
      advanceOrigin("2\n");
      const before = head(clone);
      const result = await fastForwardDefaultBranch(clone, "main");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.updated).toBe(true);
        expect(result.branch).toBe("main");
        expect(result.sha).not.toBe(before);
        // HEAD now matches origin/main
        const originMain = git(clone, "rev-parse", "origin/main");
        expect(result.sha).toBe(originMain);
        expect(head(clone)).toBe(originMain);
      }
    });

    test("already current → updated:false, sha unchanged", async () => {
      advanceOrigin("2\n");
      await fastForwardDefaultBranch(clone, "main");
      const after = head(clone);
      const result = await fastForwardDefaultBranch(clone, "main");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.updated).toBe(false);
        expect(result.sha).toBe(after);
      }
    });

    test("dirty tree → reason:dirty, HEAD unchanged", async () => {
      const before = head(clone);
      writeFileSync(join(clone, "a.txt"), "dirty\n");
      const result = await fastForwardDefaultBranch(clone, "main");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("dirty");
        expect(result.branch).toBe("main");
      }
      expect(head(clone)).toBe(before);
    });

    test("wrong branch → reason:wrong_branch", async () => {
      git(clone, "checkout", "-b", "feature");
      const result = await fastForwardDefaultBranch(clone, "main");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("wrong_branch");
        expect(result.branch).toBe("main");
      }
    });

    test("diverged → merge --ff-only fails → reason:diverged", async () => {
      // Local commit on clone's main not on origin.
      writeFileSync(join(clone, "a.txt"), "local\n");
      git(clone, "add", "a.txt");
      git(clone, "commit", "-m", "local divergent");
      // Advance origin independently.
      advanceOrigin("remote\n");
      const result = await fastForwardDefaultBranch(clone, "main");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("diverged");
        expect(result.branch).toBe("main");
      }
    });

    test("never throws on a bad dir → reason:error", async () => {
      const result = await fastForwardDefaultBranch(join(root, "does-not-exist"), "main");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("error");
    });
  });

  describe("resolveDefaultBranch", () => {
    test("valid hint wins", async () => {
      const branch = await resolveDefaultBranch(clone, { hint: "main" });
      expect(branch).toBe("main");
    });

    test("invalid hint falls through to local origin/HEAD", async () => {
      const branch = await resolveDefaultBranch(clone, { hint: "nope-not-a-branch" });
      expect(branch).toBe("main");
    });

    test("origin/HEAD unset + no hint → forgeDefault resolves", async () => {
      git(clone, "remote", "set-head", "origin", "-d");
      const branch = await resolveDefaultBranch(clone, {
        forgeDefault: async () => "main",
      });
      expect(branch).toBe("main");
    });

    test("all sources empty → null", async () => {
      git(clone, "remote", "set-head", "origin", "-d");
      const branch = await resolveDefaultBranch(clone, {
        forgeDefault: async () => null,
      });
      expect(branch).toBeNull();
    });

    test("origin/HEAD set + no hint → strips origin/ prefix", async () => {
      const branch = await resolveDefaultBranch(clone, {});
      expect(branch).toBe("main");
    });
  });
});
