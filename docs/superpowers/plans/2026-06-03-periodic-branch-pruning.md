# Periodic Local Branch Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a background janitor that periodically deletes local `shepherd/*` branches whose PR has been merged, so squash-merged branches stop accumulating after the merge train lands them while a session still holds the worktree.

**Architecture:** A new `BranchPruner` service (same shape as `PrPoller`: `tick()`/`start()`/`stop()`, dependency-injected) sweeps each Shepherd-used repo hourly. For every local `shepherd/*` branch that is **not** checked out in a worktree and **not** owned by an active session, it asks the forge (`prStatus(branch)`) whether the PR merged — authoritative for squash-merges, which the `git merge-base --is-ancestor` prune in `WorktreeMgr.pruneMergedBranch` can never detect. Merged orphans are deleted with `git branch -D`; everything else is kept. Gated by a `branchPruneEnabled` setting (default ON; off only when explicitly `"0"`).

**Tech Stack:** Bun + TypeScript, `node:child_process` `execFileSync` for git (matching `worktree.ts`/`branches.ts`), `gh`-backed `GitForge` abstraction, SQLite `settings` table, `bun test` with real temp git repos (matching `test/worktree.test.ts`).

**Scope (locked during brainstorming):** Orphan branches only — never auto-archives a live merged session, never GCs worktree directories, never prunes remote-tracking refs. `WorktreeMgr.pruneMergedBranch` is left untouched: it still instantly cleans true-ancestor merges, and the janitor is the sole owner of squash-merge detection (avoids threading async forge calls into the synchronous `archive()` teardown path).

---

### Task 1: `BranchPruner` core sweep

**Files:**
- Create: `src/branch-pruner.ts`
- Test: `test/branch-pruner.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/branch-pruner.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SessionStore } from "../src/store";
import { BranchPruner } from "../src/branch-pruner";
import type { GitForge, PrStatus } from "../src/forge/types";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: repo, env: ENV, stdio: "pipe" }).toString();

function mkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "shepherd-bp-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

function localBranches(repo: string): string[] {
  return git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ST = (state: PrStatus["state"]): PrStatus => ({ state, checks: "none", deployConfigured: false });

function forge(byBranch: Record<string, PrStatus["state"]>): GitForge {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    prStatus: async (b: string) => ST(byBranch[b] ?? "none"),
    openPr: async () => ST("none"),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
  } as unknown as GitForge;
}

const sessionOn = (repo: string, branch: string) => ({
  name: branch.replace("shepherd/", ""),
  prompt: "x",
  repoPath: repo,
  baseBranch: "main",
  branch,
  worktreePath: join(repo, "..", "wt"),
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_a",
});

test("deletes a merged orphan branch, keeps open and none", async () => {
  const repo = mkRepo();
  git(repo, "branch", "shepherd/merged");
  git(repo, "branch", "shepherd/open");
  git(repo, "branch", "shepherd/never-pr");
  const store = new SessionStore(":memory:");
  store.archive(store.create(sessionOn(repo, "shepherd/merged")).id); // archived → repo is enumerated
  const pruner = new BranchPruner(store, () =>
    forge({ "shepherd/merged": "merged", "shepherd/open": "open" }),
  );

  await pruner.tick();

  const left = localBranches(repo);
  expect(left).not.toContain("shepherd/merged");
  expect(left).toContain("shepherd/open");
  expect(left).toContain("shepherd/never-pr");
  rmSync(repo, { recursive: true, force: true });
});

test("never deletes a checked-out branch, even when merged", async () => {
  const repo = mkRepo();
  const wt = join(repo, "..", `${Date.now()}-live`);
  git(repo, "worktree", "add", "-q", wt, "-b", "shepherd/live");
  const store = new SessionStore(":memory:");
  store.archive(store.create(sessionOn(repo, "shepherd/x")).id);
  const pruner = new BranchPruner(store, () => forge({ "shepherd/live": "merged" }));

  await pruner.tick();

  expect(localBranches(repo)).toContain("shepherd/live");
  git(repo, "worktree", "remove", "--force", wt);
  rmSync(repo, { recursive: true, force: true });
});

test("never deletes an active session's branch", async () => {
  const repo = mkRepo();
  git(repo, "branch", "shepherd/active");
  const store = new SessionStore(":memory:");
  store.create(sessionOn(repo, "shepherd/active")); // active (not archived)
  const pruner = new BranchPruner(store, () => forge({ "shepherd/active": "merged" }));

  await pruner.tick();

  expect(localBranches(repo)).toContain("shepherd/active");
  rmSync(repo, { recursive: true, force: true });
});

test("no-op when branchPruneEnabled is \"0\"", async () => {
  const repo = mkRepo();
  git(repo, "branch", "shepherd/merged");
  const store = new SessionStore(":memory:");
  store.archive(store.create(sessionOn(repo, "shepherd/merged")).id);
  store.setSetting("branchPruneEnabled", "0");
  const pruner = new BranchPruner(store, () => forge({ "shepherd/merged": "merged" }));

  await pruner.tick();

  expect(localBranches(repo)).toContain("shepherd/merged");
  rmSync(repo, { recursive: true, force: true });
});

test("keeps the branch when the forge errors or is absent", async () => {
  const repo = mkRepo();
  git(repo, "branch", "shepherd/err");
  git(repo, "branch", "shepherd/noforge");
  const store = new SessionStore(":memory:");
  store.archive(store.create(sessionOn(repo, "shepherd/err")).id);
  const throwing = { ...forge({}), prStatus: async () => { throw new Error("gh down"); } } as GitForge;
  const pruner = new BranchPruner(store, (dir) => (dir === repo ? throwing : null));

  await pruner.tick();

  expect(localBranches(repo)).toContain("shepherd/err");

  const noForge = new BranchPruner(store, () => null);
  await noForge.tick();
  expect(localBranches(repo)).toContain("shepherd/noforge");
  rmSync(repo, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/patrick/Work/tank && bun test ./test/branch-pruner.test.ts`
Expected: FAIL — `Cannot find module "../src/branch-pruner"`.

- [ ] **Step 3: Implement `BranchPruner`**

```ts
// src/branch-pruner.ts
import { execFileSync } from "node:child_process";
import type { SessionStore } from "./store";
import type { GitForge } from "./forge/types";

// Same refname grammar as worktree.ts: rejects a leading "-" so a branch name
// can never smuggle a flag into the `git branch -D` argv.
const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;

/**
 * Hourly janitor that deletes local `shepherd/*` branches whose PR has merged.
 *
 * The merge train squash-merges (`gh pr merge --squash --delete-branch`), which
 * deletes the remote branch but leaves the local branch's tip a non-ancestor of
 * main — so `WorktreeMgr.pruneMergedBranch`'s `--is-ancestor` check never fires
 * and the branch lingers forever (worse: at merge time the session still holds
 * the worktree, so nothing could delete it then anyway). This sweep is the
 * deferred cleanup: it asks the forge whether each branch's PR merged, which is
 * authoritative regardless of merge method.
 *
 * Orphan branches only — a branch checked out in any worktree, or owned by an
 * active session, is never touched; nor is a branch whose PR isn't `merged`
 * (open/closed/none, or a forge/`gh` error, all mean "keep").
 */
export class BranchPruner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private store: Pick<SessionStore, "list" | "getSetting">,
    private resolveForge: (repoPath: string) => GitForge | null,
    private intervalMs = 60 * 60 * 1000,
  ) {}

  /** Default ON: only an explicit "0" disables the sweep. */
  private enabled(): boolean {
    return this.store.getSetting("branchPruneEnabled") !== "0";
  }

  /** Local `shepherd/*` branch short-names in `repo`, or [] on any git error. */
  private shepherdBranches(repo: string): string[] {
    try {
      return execFileSync(
        "git",
        ["for-each-ref", "--format=%(refname:short)", "refs/heads/shepherd/"],
        { cwd: repo, stdio: "pipe" },
      )
        .toString()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Branch short-names checked out in any worktree of `repo` (can't be -D'd). */
  private checkedOut(repo: string): Set<string> {
    const out = new Set<string>();
    try {
      const txt = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repo,
        stdio: "pipe",
      }).toString();
      const prefix = "branch refs/heads/";
      for (const line of txt.split("\n")) {
        if (line.startsWith(prefix)) out.add(line.slice(prefix.length).trim());
      }
    } catch {
      /* best-effort: empty set; git's own -D refusal is the backstop */
    }
    return out;
  }

  private deleteBranch(repo: string, branch: string): void {
    if (!BRANCH_RE.test(branch)) return;
    try {
      execFileSync("git", ["branch", "-D", branch], { cwd: repo, stdio: "pipe" });
    } catch {
      /* checked out elsewhere / already gone — best-effort */
    }
  }

  async tick(): Promise<void> {
    if (this.running || !this.enabled()) return;
    this.running = true;
    try {
      // Repos Shepherd has used (including archived sessions), de-duped — we only
      // ever look at `shepherd/*` branches, which Shepherd itself created.
      const repos = [...new Set(this.store.list().map((s) => s.repoPath))];
      // Branches of live sessions are off-limits regardless of merge state.
      const activeBranches = new Set(
        this.store
          .list({ activeOnly: true })
          .map((s) => s.branch)
          .filter((b): b is string => !!b),
      );
      for (const repo of repos) {
        const forge = this.resolveForge(repo);
        if (!forge) continue; // can't confirm merged → leave the repo alone
        const checkedOut = this.checkedOut(repo);
        let pruned = false;
        for (const branch of this.shepherdBranches(repo)) {
          if (checkedOut.has(branch) || activeBranches.has(branch)) continue;
          let merged = false;
          try {
            merged = (await forge.prStatus(branch)).state === "merged";
          } catch {
            continue; // gh error → unknown → keep
          }
          if (!merged) continue;
          this.deleteBranch(repo, branch);
          pruned = true;
        }
        if (pruned) {
          try {
            execFileSync("git", ["worktree", "prune"], { cwd: repo, stdio: "pipe" });
          } catch {
            /* best-effort */
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/patrick/Work/tank && bun test ./test/branch-pruner.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Lint + typecheck**

Run: `cd /home/patrick/Work/tank && bun run lint && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /home/patrick/Work/tank
git add src/branch-pruner.ts test/branch-pruner.test.ts
git commit -m "feat(prune): BranchPruner deletes merged shepherd/* orphan branches"
```

---

### Task 2: Wire the janitor into the server boot

**Files:**
- Modify: `src/index.ts` (add import near the other service imports; add boot block after the `prPoller` wiring, ~line 146)

- [ ] **Step 1: Add the import**

Add alongside the existing service imports at the top of `src/index.ts` (e.g. just after the `PrPoller` import on line 12):

```ts
import { BranchPruner } from "./branch-pruner";
```

- [ ] **Step 2: Add the boot block**

Insert immediately after the `prPoller.start();` / `events.subscribe(...)` block (after line ~155, before `const reviewService = ...`):

```ts
// Hourly: delete local shepherd/* branches whose PR has merged. The merge train
// squash-merges, so the at-archive ancestry prune (worktree.ts) never catches
// them and they pile up — and at merge time the session still holds the worktree
// so they can't be cleaned then anyway. Orphan branches only: never a checked-out
// or active-session branch. Disable with setting branchPruneEnabled="0".
const branchPruner = new BranchPruner(store, resolveForge);
setTimeout(() => void branchPruner.tick(), 30_000); // first sweep shortly after boot
branchPruner.start();
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd /home/patrick/Work/tank && bunx tsc --noEmit && bun run lint`
Expected: no errors.

- [ ] **Step 4: Full server test suite (no regressions)**

Run: `cd /home/patrick/Work/tank && bun test ./test`
Expected: PASS (existing suite + the new branch-pruner tests).

- [ ] **Step 5: Commit**

```bash
cd /home/patrick/Work/tank
git add src/index.ts
git commit -m "feat(prune): run BranchPruner hourly on server boot"
```

---

### Task 3: Verify end-to-end against a real merged branch

**Files:** none (manual verification)

- [ ] **Step 1: Reproduce the accumulation, then prune it**

In a scratch git repo, simulate the squash-merge residue and confirm the sweep removes it while sparing live work:

```bash
cd /home/patrick/Work/tank
bun test ./test/branch-pruner.test.ts   # automated proof of all branch cases
```

The five tests already cover every branch of the logic (merged orphan deleted; open/none/never-PR'd kept; checked-out skipped; active-session skipped; disabled no-op; forge-error/absent kept). No separate manual repro is required — record the green run as the verification artifact.

- [ ] **Step 2: Confirm the toggle is documented in the commit/PR body**

Note in the PR description that the sweep is ON by default and disabled via `store.setSetting("branchPruneEnabled", "0")` (SQLite `settings` table). No UI surface in this change.

---

## Self-Review

**Spec coverage:**
- Periodic sweep → Task 1 (`tick`/`start`/`stop`) + Task 2 (hourly boot wiring). ✓
- Squash-aware merged detection → `forge.prStatus(branch).state === "merged"` (Task 1, Step 3). ✓
- Orphan branches only / never touch live worktrees or active sessions → `checkedOut` + `activeBranches` guards (Task 1). ✓
- Setting toggle, default ON → `enabled()` returns `getSetting(...) !== "0"` (Task 1). ✓
- Safety: only `shepherd/*`, only `merged`, keep on unknown/error → `shepherdBranches` prefix + state check + try/catch `continue` (Task 1). ✓
- No UI strings → server-only; i18n gate N/A (noted in design). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output. ✓

**Type consistency:** `BranchPruner(store, resolveForge, intervalMs?)` constructor identical across Tasks 1 and 2; `resolveForge: (repoPath: string) => GitForge | null` matches `src/index.ts`'s existing `resolveForge` (returns `ReturnType<typeof detectForge>` = `GitForge | null`); `prStatus(branch).state` and the `PrStatus`/`GitForge` shapes match `src/forge/types.ts` and the `test/pr-poller.test.ts` fake. Setting key `branchPruneEnabled` spelled identically in `enabled()`, the disabled-test, and the boot comment. ✓
