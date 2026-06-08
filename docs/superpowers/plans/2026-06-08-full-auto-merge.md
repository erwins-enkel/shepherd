# Full-auto merge mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional "full-auto" mode that carries a ready PR all the way to a merge — safely under parallelism — via a Shepherd-owned serial merge train with agent-driven rebase recovery.

**Architecture:** A new per-repo `autoMergeEnabled` toggle (+ per-session override), independent of `autoDrainEnabled`, drives a new `AutoMergeService` (pure `automerge-core.ts` + side-effect `automerge.ts`, mirroring the drain). It runs a per-repo serial merge train over every full-auto session (drain-spawned or manual): merge when the PR is open + green + critic-clean + mergeable + up-to-date with `main`; rebase (steer the still-idle agent) when stale or conflicting; fail-closed otherwise. The drain stops retiring when full-auto is on (the merge service owns completion); autopilot keeps unblocking gates past the PR so rebases can finish.

**Tech Stack:** TypeScript + Bun (root server), SvelteKit + Paraglide i18n (UI), `gh` CLI via the `GitForge` abstraction, SQLite (`bun:sqlite`).

**Deviation from spec §3.4:** `behind` (up-to-date-with-main) is computed **on demand in the `AutoMergeService` harness** via a new `WorktreeMgr.behindBase()` helper, NOT added to `GitState`/the pr-poller. Rationale: the poller serves all sessions every 15s; a `git fetch` per open PR there is costly, and only the merge train consumes `behind`.

**Reference:** `docs/superpowers/specs/2026-06-08-full-auto-merge-design.md`.

**Conventions for every task:** Root checks run from repo root: `bun test ./test` (NOT plain `bun test`), `bun run lint`, `bunx tsc --noEmit`. UI checks: `cd ui && bun run test` (vitest), `bun run check`, `bun run check:i18n`. Commit messages use conventional-commits; end with the Co-Authored-By trailer. Branch is already cut; keep it linear.

---

## Task 1: `RepoConfig.autoMergeEnabled` (store schema + migration)

**Files:**
- Modify: `src/store.ts` (RepoConfig interface ~25-40; CREATE TABLE ~116-122; getRepoConfig ~187-216; setRepoConfig ~218-243; migrateRepoConfigColumns ~640-652)
- Test: `test/store.test.ts` (add cases; find the existing repo-config block)

- [ ] **Step 1: Write the failing test**

In `test/store.test.ts`, alongside existing repo-config tests:

```ts
test("repo config: autoMergeEnabled defaults false and round-trips", () => {
  const store = new SessionStore(":memory:");
  expect(store.getRepoConfig("/r").autoMergeEnabled).toBe(false);
  const cfg = store.getRepoConfig("/r");
  store.setRepoConfig("/r", { ...cfg, autoMergeEnabled: true });
  expect(store.getRepoConfig("/r").autoMergeEnabled).toBe(true);
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test ./test/store.test.ts -t "autoMergeEnabled defaults"`
Expected: FAIL (`autoMergeEnabled` is `undefined` / not on type).

- [ ] **Step 3: Implement**

In the `RepoConfig` interface add (after `autoDrainEnabled`):

```ts
  /** Full-auto: when on, the merge train lands ready PRs instead of handing off. */
  autoMergeEnabled: boolean;
```

In `CREATE TABLE repo_config` add a column (after `autoDrainEnabled`):

```sql
      autoMergeEnabled INTEGER NOT NULL DEFAULT 0,
```

In `getRepoConfig`, add `autoMergeEnabled` to the SELECT column list, to the row type, and to the returned object:

```ts
      autoMergeEnabled: r ? !!r.autoMergeEnabled : false,
```

In `setRepoConfig`, add `autoMergeEnabled` to the INSERT column list, the `VALUES` placeholders, the `ON CONFLICT … DO UPDATE SET` list (`autoMergeEnabled = excluded.autoMergeEnabled`), and the bound params (`cfg.autoMergeEnabled ? 1 : 0`).

In `migrateRepoConfigColumns`, add:

```ts
    add("autoMergeEnabled", `autoMergeEnabled INTEGER NOT NULL DEFAULT 0`);
```

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test ./test/store.test.ts -t "autoMergeEnabled"` → PASS. Then `bunx tsc --noEmit` (the new required field will surface every `RepoConfig` literal that must be updated — fix those in later tasks; if any non-test source breaks now, add the field there too).

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat(store): add RepoConfig.autoMergeEnabled (default off)"
```

---

## Task 2: `Session.autoMergeEnabled` override + `autoMergeRebaseCount`

**Files:**
- Modify: `src/types.ts` (Session ~4-37)
- Modify: `src/store.ts` (column list ~76-91 + row hydration; insert defaults ~306/337; migrateSessionColumns ~621-636; add a setter)
- Test: `test/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("session: autoMergeEnabled override + rebase count round-trip", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(makeCreateInput()); // reuse the test helper used by other session tests
  expect(s.autoMergeEnabled).toBeNull();
  expect(s.autoMergeRebaseCount).toBe(0);
  store.setAutoMergeState(s.id, { enabled: true });
  expect(store.get(s.id)!.autoMergeEnabled).toBe(true);
  store.setAutoMergeState(s.id, { rebaseCount: 3 });
  expect(store.get(s.id)!.autoMergeRebaseCount).toBe(3);
});
```

(If `makeCreateInput` doesn't exist, copy the `create(...)` argument object an existing session test in this file already uses.)

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test ./test/store.test.ts -t "autoMergeEnabled override"` → FAIL.

- [ ] **Step 3: Implement**

In `src/types.ts` `Session`, after `autopilotQuestion`:

```ts
  /** Full-auto merge opt-in: true/false override, or null to inherit the repo default. */
  autoMergeEnabled: boolean | null;
  /** Consecutive auto-rebase attempts the merge train has spent on this session
   *  (runaway guard; reset on operator reply). */
  autoMergeRebaseCount: number;
```

In `src/store.ts`:
- Add `"autoMergeEnabled"` to the persisted column-name list (~76) and select/hydrate it (map `0/1/null` → `boolean | null`: `row.autoMergeEnabled === null ? null : !!row.autoMergeEnabled`).
- Add `autoMergeRebaseCount` to the column list and hydrate (`row.autoMergeRebaseCount ?? 0`).
- In the row-build for `create` (~306) and any other Session literal (~337), set `autoMergeEnabled: null` and `autoMergeRebaseCount: 0`.
- In `migrateSessionColumns` (~630 area):

```ts
    add("autoMergeEnabled", `autoMergeEnabled INTEGER`);
    add("autoMergeRebaseCount", `autoMergeRebaseCount INTEGER NOT NULL DEFAULT 0`);
```

- Add a setter mirroring `setAutopilotState`:

```ts
  /** Update full-auto merge fields. `enabled`: override (boolean|null). `rebaseCount`: absolute. */
  setAutoMergeState(
    id: string,
    patch: { enabled?: boolean | null; rebaseCount?: number },
  ): void {
    const cur = this.get(id);
    if (!cur) return;
    const enabled = patch.enabled === undefined ? cur.autoMergeEnabled : patch.enabled;
    const rebaseCount =
      patch.rebaseCount === undefined ? cur.autoMergeRebaseCount : patch.rebaseCount;
    this.db.run(
      `UPDATE sessions SET autoMergeEnabled=?, autoMergeRebaseCount=?, updatedAt=? WHERE id=?`,
      [enabled === null ? null : enabled ? 1 : 0, rebaseCount, Date.now(), id],
    );
  }
```

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test ./test/store.test.ts -t "autoMergeEnabled override"` → PASS. `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/store.ts test/store.test.ts
git commit -m "feat(store): add Session.autoMergeEnabled override + rebase counter"
```

---

## Task 3: `config.autoMergeRebaseCap`

**Files:**
- Modify: `src/config.ts` (~85-88)
- Test: none (trivial constant; covered indirectly by Task 7).

- [ ] **Step 1: Implement**

After `autopilotModel`:

```ts
  // Max consecutive auto-rebase attempts the merge train spends on a PR before pausing for the operator.
  autoMergeRebaseCap: Number(process.env.SHEPHERD_AUTOMERGE_REBASE_CAP ?? 5),
```

- [ ] **Step 2: Verify**

Run: `bunx tsc --noEmit` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): SHEPHERD_AUTOMERGE_REBASE_CAP (default 5)"
```

---

## Task 4: `WorktreeMgr.behindBase()` — strict up-to-date signal

**Files:**
- Modify: `src/worktree.ts` (add method near `commitsAhead` ~85-103)
- Test: `test/worktree.test.ts` (create if absent; otherwise append)

- [ ] **Step 1: Write the failing test**

Use a real temp git repo (mirror any existing worktree test; if none, this self-contained one works):

```ts
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeMgr } from "../src/worktree";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

test("behindBase: false when up-to-date, true when base advanced", () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a"), "1");
  git(dir, "add", "."); git(dir, "commit", "-qm", "base");
  git(dir, "checkout", "-q", "-b", "feat");
  writeFileSync(join(dir, "b"), "1");
  git(dir, "add", "."); git(dir, "commit", "-qm", "feat");
  const wt = new WorktreeMgr();
  // feat contains main's tip → up-to-date
  expect(wt.behindBase(dir, "main")).toBe(false);
  // advance main beyond feat
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "c"), "1");
  git(dir, "add", "."); git(dir, "commit", "-qm", "main2");
  git(dir, "checkout", "-q", "feat");
  expect(wt.behindBase(dir, "main")).toBe(true);
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test ./test/worktree.test.ts -t "behindBase"` → FAIL (no method).

- [ ] **Step 3: Implement**

In `WorktreeMgr`, add:

```ts
  /** Whether the branch checked out at `worktreePath` is BEHIND `baseBranch` — i.e.
   *  base has commits not yet in HEAD, so a strict merge train must rebase first.
   *  Best-effort fetches `origin/<base>` and prefers it; falls back to the local
   *  base ref when offline. Returns:
   *    false → base is an ancestor of HEAD (up-to-date, safe to merge)
   *    true  → base has commits HEAD lacks (stale, rebase needed)
   *    null  → unknowable (bad worktree / git error) → caller treats as "do not merge"
   */
  behindBase(worktreePath: string, baseBranch: string): boolean | null {
    if (!/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(baseBranch)) return null;
    try {
      execFileSync("git", ["fetch", "origin", "--", baseBranch], {
        cwd: worktreePath,
        stdio: "pipe",
      });
    } catch {
      /* offline / no origin — compare against whatever base ref is local */
    }
    // Prefer the just-fetched remote ref; fall back to a local base branch.
    const candidates = [`origin/${baseBranch}`, baseBranch];
    for (const ref of candidates) {
      try {
        execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
          cwd: worktreePath,
          stdio: "pipe",
        });
      } catch {
        continue; // ref doesn't exist locally; try the next
      }
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", ref, "HEAD"], {
          cwd: worktreePath,
          stdio: "pipe",
        });
        return false; // ref is an ancestor of HEAD → up-to-date
      } catch {
        return true; // ref has commits HEAD lacks → behind
      }
    }
    return null; // no usable base ref → unknown
  }
```

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test ./test/worktree.test.ts -t "behindBase"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worktree.ts test/worktree.test.ts
git commit -m "feat(worktree): behindBase() up-to-date-with-main check"
```

---

## Task 5: Pure decision core `automerge-core.ts`

**Files:**
- Create: `src/automerge-core.ts`
- Test: `test/automerge-core.test.ts`

The core decides per-repo, given a snapshot, the single next action. It is pure (no I/O).

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { computeMerge, type MergeRepoState, type MergeSessionView } from "../src/automerge-core";

function sess(o: Partial<MergeSessionView> = {}): MergeSessionView {
  return {
    id: "s1", desig: "TASK-01", issueNumber: null,
    state: "open", checks: "success", mergeable: true, number: 7,
    headSha: "h1", behind: false,
    reviewDecision: null, reviewHeadSha: null,
    rebaseCount: 0,
    ...o,
  };
}
function state(sessions: MergeSessionView[], o: Partial<MergeRepoState> = {}): MergeRepoState {
  return { enabled: true, criticEnabled: false, rebaseCap: 5, sessions, ...o };
}

test("disabled → hold", () => {
  expect(computeMerge(state([sess()], { enabled: false })).kind).toBe("hold");
});

test("open+green+mergeable+current → merge (critic off)", () => {
  const d = computeMerge(state([sess()]));
  expect(d).toEqual({ kind: "merge", sessionId: "s1", prNumber: 7 });
});

test("behind → rebase", () => {
  expect(computeMerge(state([sess({ behind: true })]))).toEqual({ kind: "rebase", sessionId: "s1" });
});

test("conflicting (mergeable false) → rebase", () => {
  expect(computeMerge(state([sess({ mergeable: false })]))).toEqual({ kind: "rebase", sessionId: "s1" });
});

test("behind unknown (null) → hold, never merge", () => {
  expect(computeMerge(state([sess({ behind: null })])).kind).toBe("hold");
});

test("not green → hold", () => {
  expect(computeMerge(state([sess({ checks: "pending" })])).kind).toBe("hold");
});

test("rebase cap exceeded → hold with reason", () => {
  const d = computeMerge(state([sess({ behind: true, rebaseCount: 5 })]));
  expect(d).toEqual({ kind: "hold", reason: { code: "rebase_cap", detail: "TASK-01" } });
});

test("critic on: no clean verdict for head → hold", () => {
  expect(computeMerge(state([sess()], { criticEnabled: true })).kind).toBe("hold"); // reviewDecision null
  expect(
    computeMerge(state([sess({ reviewDecision: "commented", reviewHeadSha: "h1" })], { criticEnabled: true })),
  ).toEqual({ kind: "merge", sessionId: "s1", prNumber: 7 });
});

test("critic blocking → hold", () => {
  expect(
    computeMerge(state([sess({ reviewDecision: "changes_requested", reviewHeadSha: "h1" })], { criticEnabled: true })).kind,
  ).toBe("hold");
});

test("next-in-line: merge first eligible, others ignored this tick", () => {
  const d = computeMerge(state([sess({ id: "a", behind: true }), sess({ id: "b" })]));
  // 'a' needs rebase but 'b' is ready → next-in-line returns the first ACTIONABLE; we prefer merges.
  expect(d).toEqual({ kind: "merge", sessionId: "b", prNumber: 7 });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test ./test/automerge-core.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/automerge-core.ts`**

```ts
import type { ChecksState, PrStatus } from "./forge/types";
import type { ReviewDecision } from "./types";

/** Why the merge train is holding — surfaced on automerge:status. */
export interface MergeHoldReason {
  code: "disabled" | "rebase_cap" | "idle";
  /** A desig (rebase_cap) for the operator banner. */
  detail?: string;
}

export type MergeDecision =
  | { kind: "merge"; sessionId: string; prNumber: number }
  | { kind: "rebase"; sessionId: string }
  | { kind: "hold"; reason: MergeHoldReason };

/** The slice of one full-auto session the merge core reasons over. */
export interface MergeSessionView {
  id: string;
  desig: string;
  issueNumber: number | null;
  state: PrStatus["state"];
  checks: ChecksState;
  /** null = host still computing; treat as not-yet-mergeable. */
  mergeable: boolean | null;
  number: number | null;
  headSha: string | null;
  /** false = up-to-date; true = behind main (rebase); null = unknown (never merge). */
  behind: boolean | null;
  reviewDecision: ReviewDecision | null;
  reviewHeadSha: string | null;
  /** Consecutive auto-rebase attempts already spent on this session. */
  rebaseCount: number;
}

export interface MergeRepoState {
  enabled: boolean;
  /** When on, a clean critic verdict for the CURRENT head gates the merge. */
  criticEnabled: boolean;
  rebaseCap: number;
  /** Non-archived full-auto sessions for this repo. */
  sessions: MergeSessionView[];
}

/** True when this PR is clean enough to land RIGHT NOW: open, green, host-mergeable,
 *  up-to-date with main, and (critic on) a clean verdict for the current head. */
function readyToMerge(s: MergeSessionView, criticEnabled: boolean): boolean {
  if (s.state !== "open" || s.checks !== "success" || s.mergeable !== true || !s.number) return false;
  if (s.behind !== false) return false; // true=stale, null=unknown → not now
  if (s.reviewDecision === "changes_requested" || s.reviewDecision === "error") return false;
  if (criticEnabled) {
    if (s.reviewDecision === null) return false;
    if (s.reviewHeadSha !== s.headSha) return false;
  }
  return true;
}

/** True when the PR is otherwise mergeable-intent but stale or conflicting: open, green,
 *  critic not blocking, yet behind main OR host-unmergeable (textual conflict). A rebase
 *  (re-run CI + critic) is the path back to readiness. `behind: null` (unknown) is NOT a
 *  rebase trigger — we wait for a definite signal rather than thrash. */
function needsRebase(s: MergeSessionView, criticEnabled: boolean): boolean {
  if (s.state !== "open" || s.checks !== "success" || !s.number) return false;
  if (s.reviewDecision === "changes_requested" || s.reviewDecision === "error") return false;
  if (criticEnabled && s.reviewDecision !== null && s.reviewHeadSha !== s.headSha) {
    // a re-review is already pending for a newer head → let the critic settle first
    return false;
  }
  return s.behind === true || s.mergeable === false;
}

/**
 * Pure decision core for the merge train. One action per call; the harness applies
 * it, re-reads, and calls again. Merges take priority over rebases (land what's ready
 * before disturbing siblings), and within each, NEXT-IN-LINE wins (first actionable),
 * not oldest-first — see the spec's throughput decision.
 */
export function computeMerge(state: MergeRepoState): MergeDecision {
  if (!state.enabled) return { kind: "hold", reason: { code: "disabled" } };

  const ready = state.sessions.find((s) => readyToMerge(s, state.criticEnabled));
  if (ready) return { kind: "merge", sessionId: ready.id, prNumber: ready.number! };

  const stale = state.sessions.find((s) => needsRebase(s, state.criticEnabled));
  if (stale) {
    if (stale.rebaseCount >= state.rebaseCap) {
      return { kind: "hold", reason: { code: "rebase_cap", detail: stale.desig } };
    }
    return { kind: "rebase", sessionId: stale.id };
  }

  return { kind: "hold", reason: { code: "idle" } };
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test ./test/automerge-core.test.ts` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/automerge-core.ts test/automerge-core.test.ts
git commit -m "feat(automerge): pure merge-train decision core"
```

---

## Task 6: Shared `settleMergedSession` teardown helper

Extract the drain's `reapMerged` body into a reusable helper so both the out-of-band-merge
path AND the merge train settle a merged session identically (close issue / claim / archive /
drop pr-cache / emit archived) — and so it also handles **manual** (non-auto, no-issue) sessions.

**Files:**
- Create: `src/merge-teardown.ts`
- Modify: `src/drain.ts` (`reapMerged` ~327-350 calls the helper)
- Test: `test/merge-teardown.test.ts`; existing `test/drain.test.ts` must still pass.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, mock } from "bun:test";
import { settleMergedSession, type MergeTeardownDeps } from "../src/merge-teardown";

function deps(over: Partial<MergeTeardownDeps> = {}): MergeTeardownDeps {
  return {
    resolveForge: () => ({ closeIssue: mock(async () => {}) }) as any,
    archive: mock(() => 1),
    dropPrCache: mock(() => {}),
    emitArchived: mock(() => {}),
    retainClaim: mock(() => {}),
    ...over,
  };
}

test("auto session with issue: closes issue, archives, does NOT retain claim", async () => {
  const d = deps();
  await settleMergedSession({ id: "s1", auto: true, issueNumber: 9, repoPath: "/r" } as any, d);
  expect((d.archive as any).mock.calls.length).toBe(1);
  expect((d.retainClaim as any).mock.calls.length).toBe(0);
});

test("closeIssue throws → retain claim (issue still open)", async () => {
  const d = deps({ resolveForge: () => ({ closeIssue: async () => { throw new Error("x"); } }) as any });
  await settleMergedSession({ id: "s1", auto: true, issueNumber: 9, repoPath: "/r" } as any, d);
  expect((d.retainClaim as any).mock.calls).toEqual([["s1"]]);
  expect((d.archive as any).mock.calls.length).toBe(1);
});

test("manual session (no issue): archives, no close, no retain", async () => {
  const close = mock(async () => {});
  const d = deps({ resolveForge: () => ({ closeIssue: close }) as any });
  await settleMergedSession({ id: "s1", auto: false, issueNumber: null, repoPath: "/r" } as any, d);
  expect(close.mock.calls.length).toBe(0);
  expect((d.archive as any).mock.calls.length).toBe(1);
  expect((d.retainClaim as any).mock.calls.length).toBe(0);
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test ./test/merge-teardown.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/merge-teardown.ts`**

```ts
import type { GitForge } from "./forge/types";
import type { Session } from "./types";

export interface MergeTeardownDeps {
  resolveForge: (repoPath: string) => GitForge | null;
  /** service.archive */
  archive: (id: string) => number;
  /** prPoller.drop */
  dropPrCache: (id: string) => void;
  /** events.emit("session:archived", {id}) */
  emitArchived: (id: string) => void;
  /** Mark the session so onArchived KEEPS its claim label (issue still open). */
  retainClaim: (id: string) => void;
}

/**
 * Settle a session whose PR has merged (out-of-band OR by the merge train): close its
 * backlog issue, archive the session, drop the pr-cache, and emit archived. Best-effort:
 * the merge is already done, so a close failure must not block teardown — instead we
 * RETAIN the claim (issue still open → its label is what stops a re-spawn). Manual
 * sessions (no issue) skip the close/claim entirely.
 */
export async function settleMergedSession(s: Session, deps: MergeTeardownDeps): Promise<void> {
  let closed = false;
  if (s.auto && s.issueNumber != null) {
    const forge = deps.resolveForge(s.repoPath);
    if (forge?.closeIssue) {
      try {
        await forge.closeIssue(s.issueNumber);
        closed = true;
      } catch (err) {
        console.warn(`[merge] closeIssue #${s.issueNumber} failed for ${s.id}:`, err);
      }
    }
    if (!closed) deps.retainClaim(s.id);
  }
  deps.archive(s.id);
  deps.dropPrCache(s.id);
  deps.emitArchived(s.id);
}
```

- [ ] **Step 4: Refactor `drain.ts` `reapMerged` to delegate**

Replace the body of `reapMerged` (keep the method; it owns the `retainClaimOnArchive` Set) with a call:

```ts
  private async reapMerged(s: Session, id: string): Promise<void> {
    await settleMergedSession(s, {
      resolveForge: this.deps.resolveForge,
      archive: this.deps.service.archive,
      dropPrCache: this.deps.dropPrCache,
      emitArchived: this.deps.emitArchived,
      retainClaim: (sid) => this.retainClaimOnArchive.add(sid),
    });
  }
```

Add the import at the top: `import { settleMergedSession } from "./merge-teardown";`. Note: `this.deps.service.archive` must be passed bound — if it isn't already a bound method, wrap it: `archive: (sid) => this.deps.service.archive(sid)`.

- [ ] **Step 5: Run it, expect PASS**

Run: `bun test ./test/merge-teardown.test.ts ./test/drain.test.ts ./test/drain-core.test.ts` → all PASS. `bunx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add src/merge-teardown.ts src/drain.ts test/merge-teardown.test.ts
git commit -m "refactor(drain): extract settleMergedSession; handle manual sessions"
```

---

## Task 7: `AutoMergeService` harness `automerge.ts`

**Files:**
- Create: `src/automerge.ts`
- Test: `test/automerge.test.ts`

The harness assembles `MergeRepoState`, calls `computeMerge`, and applies the decision —
serial per-repo via a `pumping` lock (this is the train). It computes `behind` per candidate
via `worktree.behindBase`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, mock } from "bun:test";
import { AutoMergeService, type AutoMergeDeps } from "../src/automerge";
import { settleMergedSession } from "../src/merge-teardown"; // ensure import path resolves

// Minimal session/store doubles. Use a session that is full-auto, open, green, mergeable, current.
function baseSession(over: any = {}) {
  return {
    id: "s1", desig: "TASK-01", repoPath: "/r", baseBranch: "main",
    worktreePath: "/wt", branch: "shepherd/x", status: "idle", auto: true,
    issueNumber: 9, autopilotEnabled: true, autoMergeEnabled: true,
    autoMergeRebaseCount: 0, ...over,
  };
}

function deps(over: Partial<AutoMergeDeps> = {}): AutoMergeDeps {
  const session = baseSession();
  return {
    store: {
      get: () => session as any,
      list: () => [session as any],
      getRepoConfig: () => ({ autoMergeEnabled: true, criticEnabled: false, autopilotEnabled: true } as any),
      getReview: () => null,
      setAutoMergeState: mock(() => {}),
    } as any,
    service: { archive: mock(() => 1), reply: mock(() => true), resume: mock(() => true) } as any,
    resolveForge: () => ({ kind: "github", mergeMethod: "squash", merge: mock(async () => {}), closeIssue: mock(async () => {}) }) as any,
    worktree: { behindBase: () => false } as any,
    prCache: { snapshot: () => ({ s1: { state: "open", checks: "success", mergeable: true, number: 7, headSha: "h1" } }) } as any,
    paneAlive: () => true,
    repos: () => ["/r"],
    emitStatus: mock(() => {}),
    emitArchived: mock(() => {}),
    dropPrCache: mock(() => {}),
    retainClaim: mock(() => {}),
    rebaseCap: 5,
    ...over,
  };
}

test("ready PR → forge.merge called with squash + delete-branch, then archived", async () => {
  const merge = mock(async () => {});
  const archive = mock(() => 1);
  const d = deps({
    resolveForge: () => ({ kind: "github", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
    service: { archive, reply: mock(() => true), resume: mock(() => true) } as any,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(merge.mock.calls[0]).toEqual([7, { method: "squash", deleteBranch: true }]);
  expect(archive.mock.calls.length).toBe(1);
});

test("behind → steers a rebase + bumps the counter, does NOT merge", async () => {
  const reply = mock(() => true);
  const setState = mock(() => {});
  const merge = mock(async () => {});
  const d = deps({
    worktree: { behindBase: () => true } as any,
    service: { archive: mock(() => 1), reply, resume: mock(() => true) } as any,
    resolveForge: () => ({ kind: "github", mergeMethod: "squash", merge, closeIssue: mock(async () => {}) }) as any,
  });
  d.store.setAutoMergeState = setState as any;
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(reply.mock.calls.length).toBe(1);            // rebase steer sent
  expect(setState.mock.calls[0]).toEqual(["s1", { rebaseCount: 1 }]);
  expect(merge.mock.calls.length).toBe(0);
});

test("forge.merge throws (non-conflict) → fail-closed: not archived, status holds", async () => {
  const archive = mock(() => 1);
  const emitStatus = mock(() => {});
  const d = deps({
    resolveForge: () => ({ kind: "github", mergeMethod: "squash", merge: async () => { throw new Error("403"); }, closeIssue: mock(async () => {}) }) as any,
    service: { archive, reply: mock(() => true), resume: mock(() => true) } as any,
    emitStatus,
  });
  const svc = new AutoMergeService(d);
  await svc.pump("/r");
  expect(archive.mock.calls.length).toBe(0);          // NOT torn down
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test ./test/automerge.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/automerge.ts`**

```ts
import type { SessionStore } from "./store";
import type { GitForge, GitState } from "./forge/types";
import type { Session } from "./types";
import type { WorktreeMgr } from "./worktree";
import { computeMerge, type MergeDecision, type MergeRepoState, type MergeSessionView } from "./automerge-core";
import { settleMergedSession } from "./merge-teardown";

/** Live per-repo merge-train status pushed to clients. */
export interface AutoMergeStatus {
  repoPath: string;
  enabled: boolean;
  /** "merging" | "rebasing" | "merge_error" | "rebase_cap" while acting/paused; null when idle. */
  state: string | null;
  /** A desig for the operator banner, when relevant. */
  detail: string | null;
}

/** Steer text — agent-facing, English, NOT i18n (typed into the PTY like OPEN_PR_STEER). */
export const REBASE_STEER = [
  "You're in full-auto and your PR can't merge as-is — it's behind the base branch (or has",
  "conflicts). Fetch origin, rebase your branch onto origin/<base>, resolve any conflicts, and",
  "force-push with --force-with-lease. Do NOT merge the base branch into yours (it breaks the",
  "linear-history gate). If something genuinely blocks this, say specifically what you need.",
].join("\n");

export interface AutoMergeDeps {
  store: Pick<SessionStore, "get" | "list" | "getRepoConfig" | "getReview" | "setAutoMergeState">;
  service: { archive(id: string): number; reply(id: string, text: string): boolean; resume(id: string): unknown };
  resolveForge: (repoPath: string) => GitForge | null;
  worktree: Pick<WorktreeMgr, "behindBase">;
  prCache: { snapshot(): Record<string, GitState> };
  /** Whether the session's herdr pane is live (so a steer lands). */
  paneAlive: (id: string) => boolean;
  repos: () => string[];
  emitStatus: (s: AutoMergeStatus) => void;
  emitArchived: (id: string) => void;
  dropPrCache: (id: string) => void;
  /** Mark a session so the drain's onArchived keeps its claim (close failed). */
  retainClaim: (id: string) => void;
  rebaseCap: number;
}

export class AutoMergeService {
  private pumping = new Set<string>();
  constructor(private deps: AutoMergeDeps) {}

  /** Effective full-auto: a session is a candidate when both autopilot AND auto-merge resolve true. */
  private fullAuto(s: Session): boolean {
    const cfg = this.deps.store.getRepoConfig(s.repoPath);
    const autopilot = s.autopilotEnabled ?? cfg.autopilotEnabled;
    const merge = s.autoMergeEnabled ?? cfg.autoMergeEnabled;
    return autopilot && merge;
  }

  private buildState(repoPath: string): MergeRepoState {
    const cfg = this.deps.store.getRepoConfig(repoPath);
    const snapshot = this.deps.prCache.snapshot();
    const sessions: MergeSessionView[] = this.deps.store
      .list()
      .filter((s) => s.repoPath === repoPath && s.status !== "archived" && this.fullAuto(s))
      .map((s) => {
        const git = snapshot[s.id] ?? null;
        const review = this.deps.store.getReview(s.id);
        // Only compute the (cost-bearing) behind check for an open PR; else it's irrelevant.
        const behind =
          git?.state === "open" && s.worktreePath && s.branch
            ? this.deps.worktree.behindBase(s.worktreePath, s.baseBranch)
            : null;
        return {
          id: s.id, desig: s.desig, issueNumber: s.issueNumber,
          state: git?.state ?? "none", checks: git?.checks ?? "none",
          mergeable: git?.mergeable ?? null, number: git?.number ?? null,
          headSha: git?.headSha ?? null, behind,
          reviewDecision: review?.decision ?? null, reviewHeadSha: review?.headSha ?? null,
          rebaseCount: s.autoMergeRebaseCount,
        };
      });
    return { enabled: cfg.autoMergeEnabled, criticEnabled: cfg.criticEnabled, rebaseCap: this.deps.rebaseCap, sessions };
  }

  private status(repoPath: string, enabled: boolean, state: string | null, detail: string | null): AutoMergeStatus {
    return { repoPath, enabled, state, detail };
  }

  /** Pump a repo's merge train: build → decide → apply, until it holds. Serial per repo. */
  async pump(repoPath: string): Promise<void> {
    if (this.pumping.has(repoPath)) return;
    this.pumping.add(repoPath);
    try {
      const attempted = new Set<string>();
      for (let i = 0; i < 100; i++) {
        let decision: MergeDecision;
        try {
          decision = computeMerge(this.buildState(repoPath));
        } catch (err) {
          console.warn(`[automerge] build/compute failed for ${repoPath}:`, err);
          break;
        }
        if (decision.kind === "merge") {
          if (attempted.has(decision.sessionId)) break;
          attempted.add(decision.sessionId);
          const ok = await this.doMerge(repoPath, decision.sessionId, decision.prNumber);
          if (!ok) break; // fail-closed: stop the train; next event/tick retries
          continue;
        }
        if (decision.kind === "rebase") {
          if (attempted.has(decision.sessionId)) break;
          attempted.add(decision.sessionId);
          this.doRebase(repoPath, decision.sessionId);
          break; // one rebase in flight; wait for the new head before re-evaluating
        }
        // hold
        const reason = decision.reason.code === "idle" ? null : decision.reason.code;
        this.deps.emitStatus(this.status(repoPath, true, reason, decision.reason.detail ?? null));
        break;
      }
    } finally {
      this.pumping.delete(repoPath);
    }
  }

  /** Land a ready PR. Returns true on success (session settled), false on a fail-closed error. */
  private async doMerge(repoPath: string, sessionId: string, prNumber: number): Promise<boolean> {
    const forge = this.deps.resolveForge(repoPath);
    const s = this.deps.store.get(sessionId);
    if (!forge || !s) return false;
    this.deps.emitStatus(this.status(repoPath, true, "merging", s.desig));
    try {
      await forge.merge(prNumber, { method: forge.mergeMethod, deleteBranch: true });
    } catch (err) {
      // Fail closed: keep the PR open + claim, do NOT archive. Pause + surface.
      console.warn(`[automerge] merge pr#${prNumber} failed for ${sessionId}:`, err);
      this.deps.emitStatus(this.status(repoPath, true, "merge_error", s.desig));
      return false;
    }
    await settleMergedSession(s, {
      resolveForge: this.deps.resolveForge,
      archive: (id) => this.deps.service.archive(id),
      dropPrCache: this.deps.dropPrCache,
      emitArchived: this.deps.emitArchived,
      retainClaim: this.deps.retainClaim,
    });
    return true;
  }

  /** Steer the (idle) agent to rebase onto main; bump the attempt counter. */
  private doRebase(repoPath: string, sessionId: string): void {
    const s = this.deps.store.get(sessionId);
    if (!s) return;
    this.deps.emitStatus(this.status(repoPath, true, "rebasing", s.desig));
    if (!this.deps.paneAlive(sessionId)) {
      if (!this.deps.service.resume(sessionId)) return; // nothing to steer
    }
    if (this.deps.service.reply(sessionId, REBASE_STEER)) {
      this.deps.store.setAutoMergeState(sessionId, { rebaseCount: s.autoMergeRebaseCount + 1 });
    }
  }

  // ── event handlers ──────────────────────────────────────────────────────────
  async onGit(id: string): Promise<void> { await this.pumpForSession(id); }
  async onReview(id: string): Promise<void> { await this.pumpForSession(id); }
  async onStatus(id: string): Promise<void> { await this.pumpForSession(id); }

  private async pumpForSession(id: string): Promise<void> {
    const s = this.deps.store.get(id);
    if (!s) return;
    if (!this.deps.store.getRepoConfig(s.repoPath).autoMergeEnabled) return;
    await this.pump(s.repoPath);
  }

  /** Periodic sweep (~30s): catch stale branches after sibling merges + resumed sessions. */
  async tick(): Promise<void> {
    for (const repoPath of this.deps.repos()) {
      if (this.deps.store.getRepoConfig(repoPath).autoMergeEnabled) await this.pump(repoPath);
    }
  }

  /** Client bootstrap: a status per auto-merge-enabled repo, no side effects. */
  snapshot(): AutoMergeStatus[] {
    const out: AutoMergeStatus[] = [];
    for (const repoPath of this.deps.repos()) {
      const cfg = this.deps.store.getRepoConfig(repoPath);
      if (!cfg.autoMergeEnabled) continue;
      const d = computeMerge(this.buildState(repoPath));
      const reason = d.kind === "hold" ? (d.reason.code === "idle" ? null : d.reason.code) : d.kind;
      const detail = d.kind === "hold" ? d.reason.detail ?? null : null;
      out.push(this.status(repoPath, true, reason, detail));
    }
    return out;
  }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test ./test/automerge.test.ts` → PASS. `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/automerge.ts test/automerge.test.ts
git commit -m "feat(automerge): merge-train harness (merge/rebase/fail-closed)"
```

---

## Task 8: Drain stops retiring when full-auto is on

**Files:**
- Modify: `src/drain-core.ts` (`DrainRepoState` ~56-70; `computeNext` retire branch ~102-106)
- Modify: `src/drain.ts` (`buildState` ~122-131 sets the new flag)
- Test: `test/drain-core.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/drain-core.test.ts`, add (reuse the file's existing state-builder helper; if it's inline, copy its shape):

```ts
test("autoMergeEnabled suppresses retire (merge train owns completion)", () => {
  const ready = { id: "s1", desig: "T1", issueNumber: 1, status: "idle",
    git: { state: "open", checks: "success", mergeable: true, number: 5, headSha: "h" },
    reviewDecision: null, reviewHeadSha: null } as any;
  const base = {
    enabled: true, criticEnabled: false, maxAuto: 2, usageCeilingPct: 80, usagePct: 0,
    autoSessions: [ready], mappedIssueNumbers: new Set([1]), candidates: [],
  } as any;
  // Without full-auto: retire.
  expect(computeNext({ ...base, autoMergeEnabled: false }).kind).toBe("retire");
  // With full-auto: NOT retire (falls through to hold; merge train handles it).
  expect(computeNext({ ...base, autoMergeEnabled: true }).kind).toBe("hold");
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test ./test/drain-core.test.ts -t "suppresses retire"` → FAIL (flag ignored / type error).

- [ ] **Step 3: Implement**

In `DrainRepoState` add:

```ts
  /** When on, the merge train (not the drain) completes ready sessions — so the drain
   *  must NOT retire/archive them (that would foreclose rebase recovery). */
  autoMergeEnabled: boolean;
```

In `computeNext`, guard the retire branch:

```ts
  // 1. Retire gate — skipped under full-auto (the merge train lands ready PRs instead).
  if (!state.autoMergeEnabled) {
    const toRetire = state.autoSessions.find((s) => readyToRetire(s, state.criticEnabled));
    if (toRetire) {
      return { kind: "retire", sessionId: toRetire.id, prNumber: toRetire.git!.number! };
    }
  }
```

In `src/drain.ts` `buildState`, add `autoMergeEnabled: cfg.autoMergeEnabled` to the returned object.

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test ./test/drain-core.test.ts` → all PASS (existing retire tests must still pass — they pass `autoMergeEnabled: false` via the helper; if the helper doesn't set it, default it to `false` there). `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/drain-core.ts src/drain.ts test/drain-core.test.ts
git commit -m "feat(drain): suppress retire under full-auto (merge train owns completion)"
```

---

## Task 9: Autopilot keeps unblocking gates past the PR in full-auto

**Files:**
- Modify: `src/autopilot.ts` (`AutopilotDeps` ~26-50; `eligible` ~74-86; `dispatch`/`finished` guard)
- Test: `test/autopilot.test.ts`

Goal: a full-auto session must NOT stand autopilot down at PR-open — it should keep
classifying so a rebase can be unblocked. But it must still never re-steer "open a PR" once
one exists.

- [ ] **Step 1: Write the failing test**

In `test/autopilot.test.ts` (reuse its dep-builder; add a `fullAuto` dep returning false by default in the helper):

```ts
test("full-auto: stays eligible after PR exists (keeps unblocking gates)", async () => {
  // hasPr → true, fullAuto → true: a 'gate' verdict should still steer PROCEED, not stand down.
  const steer = mock(() => true);
  const ap = makeAutopilot({ hasPr: () => true, fullAuto: () => true, steer,
    classify: async () => ({ kind: "gate", summary: "" }) });
  await ap.onBlock("s1", { shape: "yes-no", tail: [] } as any);
  expect(steer.mock.calls.length).toBe(1);
});

test("non-full-auto: still stands down once a PR exists", async () => {
  const steer = mock(() => true);
  const ap = makeAutopilot({ hasPr: () => true, fullAuto: () => false, steer,
    classify: async () => ({ kind: "gate", summary: "" }) });
  await ap.onBlock("s1", { shape: "yes-no", tail: [] } as any);
  expect(steer.mock.calls.length).toBe(0);
});

test("full-auto: a 'finished' verdict with a PR does NOT re-steer open-a-PR", async () => {
  const steer = mock(() => true);
  const ap = makeAutopilot({ hasPr: () => true, fullAuto: () => true, steer,
    classify: async () => ({ kind: "finished", summary: "" }) });
  await ap.onDone("s1");
  expect(steer.mock.calls.length).toBe(0); // OPEN_PR_STEER suppressed: a PR already exists
});
```

(Add a `fullAuto?: (id: string) => boolean` to whatever `makeAutopilot` helper the test file uses; default `() => false`.)

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test ./test/autopilot.test.ts -t "full-auto"` → FAIL.

- [ ] **Step 3: Implement**

In `AutopilotDeps` add:

```ts
  /** Whether this session is in full-auto (autopilot ∧ auto-merge). When true, autopilot does
   *  NOT stand down at PR-open — it keeps unblocking procedural gates so a rebase can finish. */
  fullAuto: (id: string) => boolean;
```

In `eligible`, replace the blanket PR stand-down:

```ts
    // A PR exists → autopilot normally stands down (critic territory). EXCEPTION: a full-auto
    // session keeps going past the PR so the merge train's rebase steers get unblocked. The
    // open-a-PR steer is still suppressed for any PR (see dispatch), so we never double-open.
    if (this.deps.hasPr(id) && !this.deps.fullAuto(id)) return null;
```

In `dispatch`, guard the `finished` → `OPEN_PR_STEER` path so it never fires when a PR exists:

```ts
      case "finished":
        if (this.deps.hasPr(s.id)) return; // PR already open → nothing to do (full-auto rebase is steered by the merge train)
        this.driveSteer(s, OPEN_PR_STEER);
        return;
```

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test ./test/autopilot.test.ts` → all PASS (existing tests must still pass; they need the new `fullAuto` dep — defaulting it to `() => false` in the helper keeps them green). `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/autopilot.ts test/autopilot.test.ts
git commit -m "feat(autopilot): keep unblocking gates past the PR in full-auto"
```

---

## Task 10: Wire `AutoMergeService` + autopilot `fullAuto` in `index.ts`

**Files:**
- Modify: `src/index.ts` (autopilot deps ~224-269; after the drain block ~290-322; HTTP deps ~455)
- Test: none new (integration covered by unit tests); verify boot via `bunx tsc --noEmit` + a smoke run.

- [ ] **Step 1: Add `fullAuto` to the autopilot deps**

In the `new AutopilotService({…})` block, add a dep (place near `hasPr`):

```ts
  fullAuto: (id) => {
    const s = store.get(id);
    if (!s) return false;
    const cfg = store.getRepoConfig(s.repoPath);
    const ap = s.autopilotEnabled ?? cfg.autopilotEnabled;
    const am = s.autoMergeEnabled ?? cfg.autoMergeEnabled;
    return ap && am;
  },
```

- [ ] **Step 2: Construct the `AutoMergeService` after the drain wiring**

After the drain's event-subscribe block (~317) and before/after the 30s drain tick, add:

```ts
import { AutoMergeService } from "./automerge"; // add to the import block at top with the others

const autoMerge = new AutoMergeService({
  store,
  service, // archive, reply, resume
  resolveForge,
  worktree, // has behindBase
  prCache: prPoller,
  paneAlive: (id) => {
    const s = store.get(id);
    return !!s && matchAgent(s, herdr.list()) !== null;
  },
  repos: () => listRepos(config.repoRoot).map((r) => r.path),
  emitStatus: (status) => events.emit("automerge:status", status),
  emitArchived: (id) => events.emit("session:archived", { id }),
  dropPrCache: (id) => prPoller.drop(id),
  // The drain owns the claim-retain Set; expose a hook so a merge whose closeIssue failed
  // keeps the claim. Reuse the drain's retain path via a public method (see Step 3).
  retainClaim: (id) => drain.retainClaim(id),
  rebaseCap: config.autoMergeRebaseCap,
});

// Drive the merge train off the same poller/critic events.
events.subscribe((event, data) => {
  if (event === "session:git") {
    const { id } = data as { id: string };
    void autoMerge.onGit(id).catch((err) => console.warn("[automerge] onGit:", err));
  } else if (event === "session:review") {
    const { id } = data as { id: string };
    void autoMerge.onReview(id).catch((err) => console.warn("[automerge] onReview:", err));
  } else if (event === "session:status") {
    const { id } = data as { id: string };
    void autoMerge.onStatus(id).catch((err) => console.warn("[automerge] onStatus:", err));
  }
});
setInterval(() => {
  if (maintenance.active) return;
  void autoMerge.tick().catch((err) => console.warn("[automerge] tick:", err));
}, 30_000);
```

Confirm `worktree` is the `WorktreeMgr` instance already in scope (it is — `reviewService`/`branchPruner` use it). Confirm `matchAgent`/`herdr.list` are imported (autopilot block uses them).

- [ ] **Step 3: Expose `drain.retainClaim`**

In `src/drain.ts`, add a tiny public method so the merge train can share the claim-retain Set:

```ts
  /** Used by the merge train: a merge whose closeIssue failed keeps the claim (issue still open). */
  retainClaim(id: string): void {
    this.retainClaimOnArchive.add(id);
  }
```

- [ ] **Step 4: Expose the snapshot to the HTTP layer (bootstrap)**

Where the HTTP deps object lists `drain: { snapshot, queue }` (~455), add:

```ts
    autoMerge: { snapshot: () => autoMerge.snapshot() },
```

(Server consumption is Task 11/UI; this just makes the bootstrap available.)

- [ ] **Step 5: Verify boot**

Run: `bunx tsc --noEmit` → clean. Then `bun test ./test` → all green. Optional smoke: `bun run lint`.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/drain.ts
git commit -m "feat: wire AutoMergeService + autopilot fullAuto resolver"
```

---

## Task 11: Server API — repo-config + per-session override + status bootstrap

**Files:**
- Modify: `src/server.ts` (repo-config PUT ~219-330; new per-session route near `handleSessionAutopilot` ~825-848; bootstrap payload where `drain.snapshot` is served)
- Test: `test/server.test.ts` (mirror existing repo-config / autopilot endpoint tests)

- [ ] **Step 1: Write the failing test**

```ts
test("PUT /api/repo-config accepts autoMergeEnabled", async () => {
  const res = await app(req("PUT", "/api/repo-config", { dir: "/r", autoMergeEnabled: true }));
  expect(res.status).toBe(200);
  expect(store.getRepoConfig("/r").autoMergeEnabled).toBe(true);
});

test("PUT /api/sessions/:id/automerge sets the override", async () => {
  const id = seedSession();
  const res = await app(req("PUT", `/api/sessions/${id}/automerge`, { enabled: true }));
  expect(res.status).toBe(200);
  expect(store.get(id)!.autoMergeEnabled).toBe(true);
  const res2 = await app(req("PUT", `/api/sessions/${id}/automerge`, { enabled: null }));
  expect(store.get(id)!.autoMergeEnabled).toBeNull();
});
```

(Match the test file's actual request helper names.)

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test ./test/server.test.ts -t "autoMerge"` → FAIL.

- [ ] **Step 3: Implement repo-config**

In the boolean-field allowlist (~219-224) add `"autoMergeEnabled"`. In the patch body type (~232/254) add `autoMergeEnabled?: unknown`/`?: boolean`. Update the "boolean fields …" and "body must set at least one of …" error strings to include `autoMergeEnabled`. In the patch builder (~308) add `autoMergeEnabled: body.autoMergeEnabled as boolean | undefined`. In the `setRepoConfig` merge (~326-330) add `autoMergeEnabled: patch.autoMergeEnabled ?? cur.autoMergeEnabled`.

- [ ] **Step 4: Implement the per-session route**

Mirror `handleSessionAutopilot` exactly, swapping `autopilot`→`automerge` and the setter:

```ts
// PUT /api/sessions/:id/automerge — set the per-session full-auto-merge override.
// Body: { enabled: boolean | null }  (null = inherit the repo default)
async function handleSessionAutoMerge({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "PUT" && parts[2] && parts[3] === "automerge")) return null;
  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown };
  const e = body.enabled;
  if (!(e === true || e === false || e === null)) {
    return json({ error: "enabled must be true, false, or null" }, 400);
  }
  const s = deps.store.get(parts[2]);
  if (!s) return json({ error: "no session" }, 404);
  deps.store.setAutoMergeState(parts[2], { enabled: e });
  return json(deps.store.get(parts[2]));
}
```

Register it in the sessions dispatcher next to `handleSessionAutopilot` (find where that handler is added to the route chain and add `handleSessionAutoMerge` beside it).

- [ ] **Step 5: Add the merge-train status to bootstrap**

Where the bootstrap response includes `drain` snapshots, add an `autoMerge: await deps.autoMerge.snapshot()` (or sync) field, and add `autoMerge` to the server's `Deps`/`Ctx` type. Wire the actual provider in `index.ts` (Task 10 Step 4 exposed it).

- [ ] **Step 6: Run it, expect PASS**

Run: `bun test ./test/server.test.ts -t "autoMerge"` → PASS. `bunx tsc --noEmit` + `bun test ./test`.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat(server): autoMergeEnabled repo-config + per-session override + status"
```

---

## Task 12: UI types + store + api plumbing

**Files:**
- Modify: `ui/src/lib/types.ts` (RepoConfig + Session mirrors)
- Modify: `ui/src/lib/api.ts` (repo-config PUT helper + new `setSessionAutoMerge`)
- Modify: `ui/src/lib/store.svelte.ts` (RepoConfig defaults / state; automerge:status handling)
- Test: `ui/src/lib/store.svelte.test.ts`

- [ ] **Step 1: Write the failing test**

In `ui/src/lib/store.svelte.test.ts`, add a case asserting an `automerge:status` WS event updates store state (mirror the `drain:status` test in that file). And assert `RepoConfig` carries `autoMergeEnabled`.

- [ ] **Step 2: Run it, expect FAIL**

Run: `cd ui && bun run test -t "automerge"` → FAIL.

- [ ] **Step 3: Implement**

- In `ui/src/lib/types.ts`: add `autoMergeEnabled: boolean` to `RepoConfig`; add `autoMergeEnabled: boolean | null` and `autoMergeRebaseCount: number` to the `Session` type; add an `AutoMergeStatus` type `{ repoPath: string; enabled: boolean; state: string | null; detail: string | null }`.
- In `ui/src/lib/api.ts`: add `setSessionAutoMerge(id, enabled: boolean | null)` calling `PUT /api/sessions/:id/automerge`; ensure the repo-config update helper passes `autoMergeEnabled`.
- In `ui/src/lib/store.svelte.ts`: handle the `automerge:status` event (store a `Record<repoPath, AutoMergeStatus>`), include it in bootstrap hydration; default `autoMergeEnabled: false` wherever RepoConfig is defaulted.

- [ ] **Step 4: Run it, expect PASS**

Run: `cd ui && bun run test -t "automerge"` → PASS. `cd ui && bun run check`.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/types.ts ui/src/lib/api.ts ui/src/lib/store.svelte.ts ui/src/lib/store.svelte.test.ts
git commit -m "feat(ui): autoMerge types, api, and status store plumbing"
```

---

## Task 13: UI toggles (repo setting + per-session) with i18n

**Files:**
- Modify: the repo-settings component that renders `autoDrainEnabled`/`criticEnabled` toggles (locate via `grep -rl "autoDrainEnabled\|criticEnabled" ui/src` and the `Viewport.svelte` usage). If repo toggles are surfaced only via API today, add the control to the same settings surface as the drain toggle.
- Modify: the per-session control that renders the autopilot override (find via `grep -rl "setSessionAutopilot\|autopilotEnabled" ui/src/lib/components`).
- Modify: `ui/messages/en.json` + `ui/messages/de.json`
- Test: component test if the sibling toggles have one; else manual + `check`.

- [ ] **Step 1: Add i18n keys (BOTH locales)**

`ui/messages/en.json`:
```json
"repo_automerge_label": "Full-auto merge",
"repo_automerge_hint": "Land ready PRs automatically (rebases & re-verifies first).",
"session_automerge_label": "Full-auto merge",
"session_automerge_inherit": "Inherit repo default"
```
`ui/messages/de.json` (same keys):
```json
"repo_automerge_label": "Voll-Auto-Merge",
"repo_automerge_hint": "Fertige PRs automatisch mergen (vorher rebasen & erneut prüfen).",
"session_automerge_label": "Voll-Auto-Merge",
"session_automerge_inherit": "Repo-Standard übernehmen"
```

- [ ] **Step 2: Add the controls**

- Repo settings: a toggle bound to `RepoConfig.autoMergeEnabled`, calling the repo-config update API, labeled `m.repo_automerge_label()` with hint `m.repo_automerge_hint()`. Place it directly after the `autoDrainEnabled` toggle.
- Per-session: a tri-state (on / off / inherit) mirroring the autopilot override, calling `api.setSessionAutoMerge(id, value)`, labeled `m.session_automerge_label()`.

Import messages: `import { m } from "$lib/paraglide/messages"`.

- [ ] **Step 3: Verify**

Run: `cd ui && bun run check && bun run check:i18n && bun run test`. All green.

- [ ] **Step 4: Commit**

```bash
git add ui/src/ ui/messages/en.json ui/messages/de.json
git commit -m "feat(ui): full-auto merge toggles (repo + per-session)"
```

---

## Task 14: UI banner for merging / rebasing / merge_error / rebase_cap

**Files:**
- Modify: the component that renders the drain banner/status (find via `grep -rl "drain:status\|DrainStatus\|paused" ui/src/lib/components`).
- Modify: `ui/messages/en.json` + `de.json`
- Test: component test mirroring the drain-banner test if present.

- [ ] **Step 1: Add i18n keys (BOTH locales)**

en:
```json
"automerge_state_merging": "Merging…",
"automerge_state_rebasing": "Rebasing onto main…",
"automerge_state_merge_error": "Merge failed — needs attention",
"automerge_state_rebase_cap": "Rebase limit reached — needs attention"
```
de:
```json
"automerge_state_merging": "Wird gemergt…",
"automerge_state_rebasing": "Rebase auf main…",
"automerge_state_merge_error": "Merge fehlgeschlagen — Eingriff nötig",
"automerge_state_rebase_cap": "Rebase-Limit erreicht — Eingriff nötig"
```

- [ ] **Step 2: Render**

In the status/banner component, read the repo's `AutoMergeStatus` from the store; map `state` → message via a small switch (`merging`/`rebasing`/`merge_error`/`rebase_cap`), showing `detail` (the desig) where set. Treat `merge_error` and `rebase_cap` as the attention/paused tone (reuse the existing paused styling).

- [ ] **Step 3: Verify**

Run: `cd ui && bun run check && bun run check:i18n && bun run test`.

- [ ] **Step 4: Commit**

```bash
git add ui/src/ ui/messages/en.json ui/messages/de.json
git commit -m "feat(ui): merge-train status banner states"
```

---

## Task 15: Feature-announcements catalog entry (REQUIRED gate)

**Files:**
- Modify: `ui/src/lib/feature-announcements.ts`
- Modify: `ui/messages/en.json` + `de.json`

- [ ] **Step 1: Add i18n keys (BOTH locales)**

en:
```json
"feat_automerge_title": "Full-auto merge",
"feat_automerge_body": "Turn on full-auto to let Shepherd land ready PRs for you — it rebases onto main and re-verifies before every merge, so parallel tasks stay safe."
```
de:
```json
"feat_automerge_title": "Voll-Auto-Merge",
"feat_automerge_body": "Aktiviere Voll-Auto, damit Shepherd fertige PRs für dich mergt — vor jedem Merge wird auf main rebased und erneut geprüft, damit parallele Aufgaben sicher bleiben."
```

- [ ] **Step 2: Append the catalog entry**

In `featureAnnouncements`, append:

```ts
  {
    id: "auto-merge",
    sinceVersion: "1.17.0",
    titleKey: "feat_automerge_title",
    bodyKey: "feat_automerge_body",
    targetId: "auto-merge",
  },
```

(Use the next release version — confirm against the latest `chore(main): release` tag; current is 1.16.0, so `1.17.0` unless a newer release has landed.) If you added `use:coachTarget={"auto-merge"}` on the repo toggle in Task 13, keep `targetId`; otherwise drop `targetId`.

- [ ] **Step 3: Verify**

Run: `cd ui && bun run check:i18n` → PASS. `bash scripts/check-feature-catalog.sh` (or rely on the pre-push hook) → PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/feature-announcements.ts ui/messages/en.json ui/messages/de.json
git commit -m "feat(ui): announce full-auto merge in What's-New"
```

---

## Task 16: Push notifications for merge_error (and quiet merged)

**Files:**
- Modify: `src/push.ts` (add intents; localize at send time)
- Modify: `src/index.ts` (notify on `automerge:status` → `merge_error`; optionally on a merged settle)
- Modify: `ui/messages/en.json` + `de.json` if push strings route through the UI catalog; otherwise the server-side localized strings in `push.ts` (follow the existing pattern there — server payloads are i18n'd too).
- Test: `test/push.test.ts` mirroring existing intent tests.

- [ ] **Step 1: Write the failing test**

Mirror an existing `push.test.ts` intent case: a `merge_error` intent for category `ci` (or `agent`) produces a localized title/body in EN and DE.

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test ./test/push.test.ts -t "merge"` → FAIL.

- [ ] **Step 3: Implement**

Add a push intent (follow the existing `kind` union + localizer in `push.ts`): e.g. `kind: "merge_error"` carrying `sessionId`, `name`, `desig`. Localize EN/DE per the file's pattern. In `index.ts`, subscribe to `automerge:status`; when `state === "merge_error"` (or `rebase_cap`), call `push.notify({ kind: "merge_error", … })` with a per-repo/session dedupe tag (namespaced per tone, per the house rule: stable key like `merge_error:<repoPath>`).

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test ./test/push.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/push.ts src/index.ts test/push.test.ts ui/messages/en.json ui/messages/de.json
git commit -m "feat(push): notify on merge-train failure"
```

---

## Task 17: Full verification + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Reinstall deps (worktree) + run every gate**

```bash
bun install
bun run lint
bunx tsc --noEmit
bun test ./test
cd ui && bun install && bun run check && bun run check:i18n && bun run test && cd ..
```
Expected: all green. (Per the reinstall-after-rebase memory, if `check`/tsc fails in files you didn't touch, it's a stale `node_modules` — reinstall.)

- [ ] **Step 2: Branch hygiene + feature catalog**

```bash
bash scripts/check-branch-hygiene.sh
bash scripts/check-feature-catalog.sh
```
Expected: PASS (linear; catalog entry present).

- [ ] **Step 3: Manual smoke (optional but recommended)**

Use the `run` skill or `bun run dev`-equivalent to boot Shepherd; on a test repo with `autoMergeEnabled` on, open a trivial PR via a full-auto session and confirm: CI-green + mergeable → it merges; force a behind state (merge something else first) → it steers a rebase; observe the banner states.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin shepherd/research-toggle-optional-full
gh pr create --base main --title "feat: full-auto merge mode" --body "$(cat <<'EOF'
## Summary
Optional per-repo + per-session **full-auto merge** mode: a Shepherd-owned serial merge train lands ready PRs (rebase + re-verify before every merge), with agent-driven rebase recovery for stale/conflicting siblings under parallelism.

- New `AutoMergeService` (pure core + harness), independent of `autoDrainEnabled`.
- Strict up-to-date gate via `WorktreeMgr.behindBase`; squash default; next-in-line train; rebase cap 5 then pause.
- Drain stops retiring under full-auto; shared `settleMergedSession` teardown (handles manual sessions); fail-closed on merge errors.
- Autopilot keeps unblocking gates past the PR in full-auto.
- Toggles + banner + What's-New entry, EN+DE.

Spec: `docs/superpowers/specs/2026-06-08-full-auto-merge-design.md`
Plan: `docs/superpowers/plans/2026-06-08-full-auto-merge.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** toggle (T1,T2,T11–13) · merge engine (T5,T7) · strict behind (T4,T7) · rebase recovery (T7,T9) · drain decoupling (T8) · shared teardown/claims (T6) · fail-closed (T7) · status/i18n (T13,T14) · feature catalog (T15) · push (T16). All spec sections map to a task.
- **Type consistency:** `MergeSessionView`/`MergeRepoState`/`MergeDecision`/`computeMerge` (T5) are consumed verbatim in T7. `settleMergedSession`/`MergeTeardownDeps` (T6) consumed in T7 & drain. `setAutoMergeState` (T2) used in T7 & T11. `behindBase` (T4) used in T7/T10. `fullAuto` dep (T9) wired in T10.
- **Open questions resolved:** separate `automerge:status` event (not extending `drain:status`); per-session `/automerge` route mirroring `/autopilot`; `autoMergeRebaseCount` reset on operator reply — implement the reset in `autopilot.onStatus` (paused→running) OR add it to the per-session override handler; simplest: reset in the `setAutoMergeState({enabled})` path and when the session loop transitions paused→running. Executor: add `store.setAutoMergeState(id, { rebaseCount: 0 })` to `autopilot.onStatus`'s paused→running branch (it already resets the autopilot step count there).
```
