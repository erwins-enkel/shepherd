import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitignoreAdopter } from "../src/gitignore-adopt";
import { WorktreeMgr } from "../src/worktree";
import {
  SHEPHERD_EXCLUDE_START,
  SHEPHERD_IGNORE_GLOB,
  SHEPHERD_EXCLUDE_END,
} from "../src/shepherd-exclude";

// House rule: root tests honor an ambient GIT_DIR. Never lean on cwd/ambient git
// env — pass explicit cwd + a scrubbed env to every fixture git call so a stray
// GIT_DIR can't redirect setup commands onto the real repo.
const GIT_ENV = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

/** A captured `openPr` invocation. */
type OpenPrCall = { head: string; base: string; title: string; body: string };

function fakeForge(over: Partial<any> = {}, openPrCalls?: OpenPrCall[]) {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    canPush: async () => true,
    defaultBranch: async () => "main",
    openPr: async (o: OpenPrCall) => {
      openPrCalls?.push(o);
      return {
        state: "open",
        number: 7,
        url: "https://pr/7",
        checks: "none",
        deployConfigured: false,
      };
    },
    ...over,
  } as never;
}

describe("GitignoreAdopter", () => {
  let root: string;
  let origin: string; // bare remote
  let repo: string; // the clone we adopt against (push-able to origin)
  let seed: string; // a second clone used to seed origin's main

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adopt-test-"));
    origin = join(root, "origin.git");
    repo = join(root, "repo");
    seed = join(root, "seed");

    // Bare origin with a deterministic default branch (host init.defaultBranch varies).
    execFileSync("git", ["init", "--bare", "-b", "main", origin], { env: GIT_ENV });

    // Seed clone: initial commit on main, pushed to origin.
    execFileSync("git", ["clone", origin, seed], { env: GIT_ENV });
    git(seed, "config", "user.email", "seed@example.com");
    git(seed, "config", "user.name", "Seed");
    writeFileSync(join(seed, "README.md"), "# repo\n");
    git(seed, "add", "README.md");
    git(seed, "commit", "-m", "initial");
    git(seed, "push", "origin", "main");

    // The clone under test — the repoPath we adopt against.
    execFileSync("git", ["clone", origin, repo], { env: GIT_ENV });
    git(repo, "config", "user.email", "repo@example.com");
    git(repo, "config", "user.name", "Repo");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Seed origin's main with an extra committed file (e.g. a pre-existing .gitignore). */
  function seedOnBase(rel: string, content: string) {
    writeFileSync(join(seed, rel), content);
    git(seed, "add", rel);
    git(seed, "commit", "-m", `seed ${rel}`);
    git(seed, "push", "origin", "main");
    // pull the new base into the clone under test so its local main matches origin
    git(repo, "fetch", "origin", "main");
  }

  test("canPush:false → { ok:false, reason:'no-access' }; openPr NOT called; no worktree left", async () => {
    const openPrCalls: OpenPrCall[] = [];
    const wt = new WorktreeMgr();
    const created: string[] = [];
    const a = new GitignoreAdopter({
      worktree: {
        create: (...args) => {
          const r = wt.create(...args);
          created.push(r.worktreePath);
          return r;
        },
        remove: (p) => wt.remove(p),
      },
      resolveForge: () => fakeForge({ canPush: async () => false }, openPrCalls),
    });

    const res = await a.adopt(repo);
    expect(res).toEqual({ ok: false, reason: "no-access" });
    expect(openPrCalls.length).toBe(0);
    // bailed before creating any worktree
    expect(created.length).toBe(0);
  });

  test("resolveForge returns null → { ok:false, reason:'no-forge' } (expected, not an error)", async () => {
    const wt = new WorktreeMgr();
    const a = new GitignoreAdopter({
      worktree: { create: (...args) => wt.create(...args), remove: (p) => wt.remove(p) },
      resolveForge: () => null,
    });
    const res = await a.adopt(repo);
    expect(res).toEqual({ ok: false, reason: "no-forge" });
  });

  test("happy path: fresh .gitignore → applied; PR opened once; pushed branch carries the block", async () => {
    const openPrCalls: OpenPrCall[] = [];
    const wt = new WorktreeMgr();
    const a = new GitignoreAdopter({
      worktree: { create: (...args) => wt.create(...args), remove: (p) => wt.remove(p) },
      resolveForge: () => fakeForge({}, openPrCalls),
    });

    const res = await a.adopt(repo);
    expect(res).toEqual({ ok: true, status: "applied", url: "https://pr/7" });

    // openPr called exactly once, head = the adopt branch, base = main.
    expect(openPrCalls.length).toBe(1);
    const call = openPrCalls[0]!;
    expect(call.base).toBe("main");
    expect(call.head).toMatch(/^shepherd\/adopt-gitignore-[0-9a-f]{8}$/);

    // The branch was really pushed to origin and its .gitignore carries the managed block.
    const pushed = git(origin, "show", `${call.head}:.gitignore`);
    expect(pushed).toContain(SHEPHERD_EXCLUDE_START);
    expect(pushed).toContain(SHEPHERD_IGNORE_GLOB);
    expect(pushed).toContain(SHEPHERD_EXCLUDE_END);

    // Throwaway local branch force-deleted on cleanup (the pushed remote branch backs the PR).
    const localBranches = git(repo, "branch", "--list", call.head);
    expect(localBranches).toBe("");
  });

  test("already present: base .gitignore already has the block → { ok:true, status:'already' }; no PR", async () => {
    const block = `${SHEPHERD_EXCLUDE_START}\n${SHEPHERD_IGNORE_GLOB}\n${SHEPHERD_EXCLUDE_END}\n`;
    seedOnBase(".gitignore", block);

    const openPrCalls: OpenPrCall[] = [];
    const wt = new WorktreeMgr();
    const a = new GitignoreAdopter({
      worktree: { create: (...args) => wt.create(...args), remove: (p) => wt.remove(p) },
      resolveForge: () => fakeForge({}, openPrCalls),
    });

    const res = await a.adopt(repo);
    expect(res).toEqual({ ok: true, status: "already" });
    expect(openPrCalls.length).toBe(0);
  });

  test("bare glob already in base .gitignore (no markers) → 'already'; no redundant PR", async () => {
    seedOnBase(".gitignore", `node_modules\n${SHEPHERD_IGNORE_GLOB}\n`);

    const openPrCalls: OpenPrCall[] = [];
    const wt = new WorktreeMgr();
    const a = new GitignoreAdopter({
      worktree: { create: (...args) => wt.create(...args), remove: (p) => wt.remove(p) },
      resolveForge: () => fakeForge({}, openPrCalls),
    });

    const res = await a.adopt(repo);
    expect(res).toEqual({ ok: true, status: "already" });
    expect(openPrCalls.length).toBe(0);
  });

  test("concurrent double-click → one returns 409", async () => {
    const wt = new WorktreeMgr();
    let releaseForge: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseForge = resolve));
    const a = new GitignoreAdopter({
      worktree: { create: (...args) => wt.create(...args), remove: (p) => wt.remove(p) },
      // hold the first adopt inside its first await so the second click overlaps it
      resolveForge: () => fakeForge({ defaultBranch: async () => (await gate, "main") }),
    });

    const first = a.adopt(repo);
    const second = await a.adopt(repo); // claim was synchronous → this sees in-flight
    expect(second.ok).toBe(false);
    if (!second.ok && "status" in second) expect(second.status).toBe(409);
    releaseForge();
    const firstRes = await first;
    expect(firstRes.ok).toBe(true);
  });
});
