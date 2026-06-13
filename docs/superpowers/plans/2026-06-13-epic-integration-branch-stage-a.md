# Epic Integration Branches — Stage A (epic flows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an epic *flow* — child PRs target a Shepherd-owned integration branch, get squash-merged into it on retire, and unblock their dependents — by gating on "child PR merged into the integration branch" instead of GitHub issue-closed.

**Architecture:** A running epic owns a deterministic integration branch `epic/<parent#>-<slug>` cut off the latest default branch. Epic-child spawns base their worktree on that branch (not default); regular tasks are unchanged. The drain's retire path, for an epic child, squash-merges the child PR into the integration branch and records the child number in a persisted `epic_integrated` set. The epic gate (`epic-core.ts`) treats a child as done when it is in that set OR its issue is closed, so dependents unblock without GitHub auto-close. (Stage B — final `integration→default` PR, `landing` lifecycle, and UI — is a separate plan.)

**Tech Stack:** TypeScript, Bun, `bun test` (root server tests in `./test`), SQLite (`bun:sqlite`), `gh` CLI forge layer.

**Scope note:** This is Stage A of the approved spec `docs/superpowers/specs/2026-06-13-epic-integration-branch-design.md`. After Stage A the epic advances and accumulates children on the integration branch but does not yet land on default — that is Stage B.

---

## File Structure

- `src/epic-branch.ts` *(new)* — pure helper: `epicIntegrationBranch(parentNumber, parentTitle) → "epic/<#>-<slug>"`. One responsibility: deterministic branch naming. No I/O.
- `src/epic-core.ts` *(modify)* — `EpicChild.integrationMerged` field; `deriveChildState` + `selectEpicCandidates` gate on done-in-epic (`integrationMerged || issueClosed`).
- `src/epic-model.ts` *(modify)* — thread `integrated: Set<number>` through `AssembleInput`; set `child.integrationMerged`.
- `src/store.ts` *(modify)* — `epic_integrated` table + `recordEpicIntegrated` / `listEpicIntegrated`.
- `src/forge/types.ts` *(modify)* — add optional `ensureBranch?(branch, fromRef)` to `GitForge`.
- `src/forge/github.ts` *(modify)* — implement `ensureBranch` (`gh api` ref create, idempotent).
- `src/drain.ts` *(modify)* — ensure integration branch on a running epic; thread integration branch + `integrated` set into `buildEpic`/spawn/retire; base epic-child spawns on the integration branch; squash-merge + record on epic-child retire.

---

## Task 1: Deterministic integration-branch name helper

**Files:**
- Create: `src/epic-branch.ts`
- Test: `test/epic-branch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/epic-branch.test.ts
import { test, expect } from "bun:test";
import { epicIntegrationBranch } from "../src/epic-branch";

test("builds epic/<#>-<slug> from parent number + title", () => {
  expect(epicIntegrationBranch(327, "EFI / Value-Map cluster — sequencing")).toBe(
    "epic/327-efi-value-map-cluster-sequencing",
  );
});

test("lowercases, collapses non-alnum to single dashes, trims edge dashes", () => {
  expect(epicIntegrationBranch(5, "  Foo__Bar!! ")).toBe("epic/5-foo-bar");
});

test("bounds the slug length (<= 40 slug chars) and never trails a dash", () => {
  const b = epicIntegrationBranch(9, "x".repeat(100));
  expect(b.startsWith("epic/9-")).toBe(true);
  expect(b.length).toBeLessThanOrEqual("epic/9-".length + 40);
  expect(b.endsWith("-")).toBe(false);
});

test("empty/symbol-only title degrades to bare epic/<#>", () => {
  expect(epicIntegrationBranch(12, "!!!")).toBe("epic/12");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/epic-branch.test.ts`
Expected: FAIL — `Cannot find module '../src/epic-branch'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/epic-branch.ts

/** Deterministic integration-branch name for an epic: `epic/<parent#>-<slug>`.
 *  Pure — recomputed everywhere (spawn base, retire merge target, buildEpic) so
 *  no per-epic branch name needs persisting. A title that slugs to empty degrades
 *  to the bare `epic/<parent#>`. The slug is bounded so the ref stays a sane length. */
export function epicIntegrationBranch(parentNumber: number, parentTitle: string): string {
  const slug = parentTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug ? `epic/${parentNumber}-${slug}` : `epic/${parentNumber}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/epic-branch.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/epic-branch.ts test/epic-branch.test.ts
git commit -m "feat(epic): deterministic epic/<#>-<slug> integration branch name"
```

---

## Task 2: `integrationMerged` field + done-in-epic gate in epic-core

**Files:**
- Modify: `src/epic-core.ts`
- Test: `test/epic-core.test.ts` (add cases; create if absent)

- [ ] **Step 1: Write the failing test**

Add to `test/epic-core.test.ts`:

```ts
import { test, expect } from "bun:test";
import { deriveChildState, selectEpicCandidates, type EpicChild } from "../src/epic-core";

function child(p: Partial<EpicChild>): EpicChild {
  return {
    number: 0,
    title: "",
    url: "",
    order: 0,
    body: "",
    blockedBy: [],
    state: "blocked",
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    integrationMerged: false,
    claimed: false,
    ...p,
  };
}

test("integration-merged child reads 'merged' even with the issue still open", () => {
  const c = child({ number: 320, issueClosed: false, integrationMerged: true });
  expect(deriveChildState(c, new Set())).toBe("merged");
});

test("a dependent unblocks once its blocker is integration-merged (issue still open)", () => {
  const blocker = child({ number: 320, integrationMerged: true });
  const dep = child({ number: 322, blockedBy: [320] });
  const cands = selectEpicCandidates([blocker, dep]);
  expect(cands.map((c) => c.number)).toEqual([322]);
});

test("a dependent stays blocked while its blocker is neither integrated nor closed", () => {
  const blocker = child({ number: 320 });
  const dep = child({ number: 322, blockedBy: [320] });
  expect(deriveChildState(dep, new Set())).toBe("blocked");
  expect(selectEpicCandidates([blocker, dep]).map((c) => c.number)).toEqual([320]);
});

test("legacy issue-closed path still satisfies a dependency", () => {
  const blocker = child({ number: 320, issueClosed: true });
  const dep = child({ number: 322, blockedBy: [320] });
  expect(selectEpicCandidates([blocker, dep]).map((c) => c.number)).toEqual([322]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/epic-core.test.ts`
Expected: FAIL — `integrationMerged` missing on `EpicChild` type, and the done set ignores it.

- [ ] **Step 3: Write minimal implementation**

In `src/epic-core.ts`, add the field to `EpicChild` (after `issueClosed: boolean;`):

```ts
  issueClosed: boolean;
  /** The child's PR was squash-merged into the epic integration branch (recorded
   *  by the drain at merge time; the issue stays open until the final epic→default
   *  PR lands). Satisfies dependencies the same as issueClosed. */
  integrationMerged: boolean;
  claimed: boolean;
```

Replace `deriveChildState` (rename `closed` → `done` to reflect the broadened set):

```ts
/** Child lifecycle state from its issue/session/PR facts. `done` = the set of member
 *  #s that are done-in-epic (integration-merged OR issue-closed). A claimed, session-less,
 *  open, not-yet-integrated child reads as in-review (spawned and retired/in-flight, PR
 *  awaiting merge). Spawn-eligibility gating still lives in `selectEpicCandidates`. */
export function deriveChildState(c: EpicChild, done: Set<number>): EpicChildState {
  if (c.integrationMerged || c.issueClosed) return "merged";
  if (c.sessionId && c.prNumber != null) return "in-review";
  if (c.sessionId) return "running";
  if (c.claimed) return "in-review";
  return c.blockedBy.every((b) => done.has(b)) ? "ready" : "blocked";
}
```

Replace `selectEpicCandidates` to build the done set from done-in-epic children:

```ts
/** Dependency-gated spawn candidates (open, unclaimed, unspawned, not-integrated, all
 *  blockers done-in-epic), in epic order, shaped as drain's `Issue[]`. Pure: derives the
 *  done set (integration-merged OR issue-closed) from `children`. */
export function selectEpicCandidates(children: EpicChild[]): Issue[] {
  const done = new Set(
    children.filter((c) => c.integrationMerged || c.issueClosed).map((c) => c.number),
  );
  return children
    .filter(
      (c) =>
        !c.integrationMerged &&
        !c.issueClosed &&
        !c.claimed &&
        c.sessionId == null &&
        c.blockedBy.every((b) => done.has(b)),
    )
    .sort((a, b) => a.order - b.order || a.number - b.number)
    .map((c) => ({
      number: c.number,
      title: c.title,
      body: c.body,
      url: c.url,
      labels: [],
      createdAt: 0,
    }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/epic-core.test.ts`
Expected: PASS. (If `test/epic-model.test.ts` exists it now fails to typecheck — fixed in Task 3.)

- [ ] **Step 5: Commit**

```bash
git add src/epic-core.ts test/epic-core.test.ts
git commit -m "feat(epic): gate dependents on done-in-epic (integration-merged or closed)"
```

---

## Task 3: Thread the `integrated` set through epic-model

**Files:**
- Modify: `src/epic-model.ts`
- Test: `test/epic-model.test.ts` (add cases; create if absent)

- [ ] **Step 1: Write the failing test**

Add to `test/epic-model.test.ts`:

```ts
import { test, expect } from "bun:test";
import { assembleEpic, type AssembleInput } from "../src/epic-model";

function input(over: Partial<AssembleInput>): AssembleInput {
  return {
    repoPath: "/r",
    run: { repoPath: "/r", parentIssueNumber: 327, mode: "auto", status: "running" },
    parent: { number: 327, title: "Epic", body: "" },
    subIssues: [
      { number: 320, title: "root", url: "u320", body: "", closed: false, labels: [] },
      { number: 322, title: "dep", url: "u322", body: "", closed: false, labels: [] },
    ],
    blockedBy: new Map([[322, [320]]]),
    openIssues: [],
    openIssuesTruncated: false,
    sessions: [],
    integrated: new Set<number>(),
    ...over,
  };
}

test("a child in the integrated set is integrationMerged and reads 'merged'", () => {
  const epic = assembleEpic(input({ integrated: new Set([320]) }));
  const c320 = epic.children.find((c) => c.number === 320)!;
  expect(c320.integrationMerged).toBe(true);
  expect(c320.state).toBe("merged");
});

test("integration-merging the blocker unblocks the dependent (issues still open)", () => {
  const epic = assembleEpic(input({ integrated: new Set([320]) }));
  expect(epic.children.find((c) => c.number === 322)!.state).toBe("ready");
});

test("empty integrated set leaves the dependent blocked", () => {
  const epic = assembleEpic(input({ integrated: new Set() }));
  expect(epic.children.find((c) => c.number === 322)!.state).toBe("blocked");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/epic-model.test.ts`
Expected: FAIL — `integrated` not on `AssembleInput`; `child.integrationMerged` always false.

- [ ] **Step 3: Write minimal implementation**

In `src/epic-model.ts`, add to `AssembleInput` (after `sessions`):

```ts
  sessions: AssembleSession[];
  /** Child #s whose PR was squash-merged into the epic integration branch (persisted
   *  by the drain). Satisfies dependencies even though the issue is still open. */
  integrated: Set<number>;
```

In `assembleEpic`, broaden the done set and pass it down. Replace:

```ts
  const closed = new Set(order.filter((n) => resolved.get(n)?.closed === true));
```

with:

```ts
  const done = new Set(
    order.filter((n) => resolved.get(n)?.closed === true || input.integrated.has(n)),
  );
```

In the `children` map, set the field on the built child and use `done`:

```ts
      issueClosed: r.closed,
      integrationMerged: input.integrated.has(number),
      claimed: r.claimed,
    };
    child.state = deriveChildState(child, done);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/epic-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/epic-model.ts test/epic-model.test.ts
git commit -m "feat(epic): thread integration-merged child set into epic assembly"
```

---

## Task 4: Persist the integration-merge record in the store

**Files:**
- Modify: `src/store.ts` (table in the constructor near `epic_run` ~line 259; methods near `getEpicRun` ~line 437)
- Test: `test/store-epic-integrated.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/store-epic-integrated.test.ts
import { test, expect } from "bun:test";
import { Store } from "../src/store";

test("records and lists integration-merged children per epic parent", () => {
  const s = new Store(":memory:");
  expect([...s.listEpicIntegrated("/r", 327)]).toEqual([]);
  s.recordEpicIntegrated("/r", 327, 320);
  s.recordEpicIntegrated("/r", 327, 320); // idempotent
  s.recordEpicIntegrated("/r", 327, 322);
  expect([...s.listEpicIntegrated("/r", 327)].sort((a, b) => a - b)).toEqual([320, 322]);
  // scoped by repo + parent
  expect([...s.listEpicIntegrated("/r", 999)]).toEqual([]);
  expect([...s.listEpicIntegrated("/other", 327)]).toEqual([]);
});
```

(Confirm the `Store` constructor accepts a path/`":memory:"` — match the pattern used by existing `test/store*.test.ts`; adjust the `new Store(...)` call to whatever those tests use if different.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/store-epic-integrated.test.ts`
Expected: FAIL — `recordEpicIntegrated`/`listEpicIntegrated` are not functions.

- [ ] **Step 3: Write minimal implementation**

In the `Store` constructor, after the `epic_run` table create (~line 261), add:

```ts
    this.db.run(`CREATE TABLE IF NOT EXISTS epic_integrated (
      repoPath TEXT NOT NULL, parentIssueNumber INTEGER NOT NULL, childNumber INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (repoPath, parentIssueNumber, childNumber))`);
```

After `setEpicRun` (~line 451), add:

```ts
  /** Record that a child PR was squash-merged into the epic integration branch.
   *  Idempotent (PK upsert) — the drain may re-observe a merge across pumps. */
  recordEpicIntegrated(repoPath: string, parentIssueNumber: number, childNumber: number): void {
    this.db.run(
      `INSERT INTO epic_integrated (repoPath, parentIssueNumber, childNumber, createdAt)
       VALUES (?,?,?,?) ON CONFLICT DO NOTHING`,
      [repoPath, parentIssueNumber, childNumber, Date.now()],
    );
  }

  /** Child #s squash-merged into the integration branch for one epic. */
  listEpicIntegrated(repoPath: string, parentIssueNumber: number): Set<number> {
    const rows = this.db
      .query(
        `SELECT childNumber FROM epic_integrated WHERE repoPath = ? AND parentIssueNumber = ?`,
      )
      .all(repoPath, parentIssueNumber) as { childNumber: number }[];
    return new Set(rows.map((r) => r.childNumber));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/store-epic-integrated.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store-epic-integrated.test.ts
git commit -m "feat(epic): persist epic_integrated child-merge record"
```

---

## Task 5: `ensureBranch` on the forge

**Files:**
- Modify: `src/forge/types.ts` (the `GitForge` interface)
- Modify: `src/forge/github.ts` (implement near `defaultBranch` ~line 464)
- Test: `test/github-ensure-branch.test.ts` (mock the `gh` runner the way existing github forge tests do — confirm the constructor/runner shape in `test/github*.test.ts` and match it)

- [ ] **Step 1: Write the failing test**

```ts
// test/github-ensure-branch.test.ts
import { test, expect } from "bun:test";
import { GitHubForge } from "../src/forge/github";

// Match the runner-injection pattern used by the other github forge tests.
function forgeWith(calls: string[][], opts?: { existsRefs?: string[]; headSha?: string }) {
  const run = async (args: string[]) => {
    calls.push(args);
    if (args.includes("rev-parse") || args.join(" ").includes("git/refs/heads/")) {
      const wanted = args.find((a) => a.includes("heads/"));
      const exists = (opts?.existsRefs ?? []).some((r) => wanted?.includes(r));
      if (!exists) throw new Error("Not Found"); // ref absent
      return JSON.stringify({ object: { sha: "base-sha" } });
    }
    return opts?.headSha ?? "base-sha";
  };
  // Construct GitHubForge with the injected runner — mirror the existing tests' helper.
  return new GitHubForge({ slug: "o/r", mergeMethod: "squash", run } as any);
}

test("ensureBranch creates the ref off fromRef when absent (idempotent no-op when present)", async () => {
  const calls: string[][] = [];
  const f = forgeWith(calls, { existsRefs: [] });
  await f.ensureBranch!("epic/327-x", "main");
  expect(calls.some((c) => c.join(" ").includes("git/refs") && c.includes("POST"))).toBe(true);

  const calls2: string[][] = [];
  const f2 = forgeWith(calls2, { existsRefs: ["epic/327-x"] });
  await f2.ensureBranch!("epic/327-x", "main");
  expect(calls2.some((c) => c.includes("POST"))).toBe(false); // already exists → no create
});
```

> NOTE: the exact `gh` invocation shape must match how `github.ts` already calls `this.run` (e.g. `["api", ...]` vs git). Before implementing, read `defaultBranch`/`openPr` in `src/forge/github.ts` and the github test helper, and mirror their argument convention. Adjust the assertions to the real call shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/github-ensure-branch.test.ts`
Expected: FAIL — `ensureBranch` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/forge/types.ts`, add to `GitForge` (near `defaultBranch`):

```ts
  /** Ensure a branch exists on the host, creating it at `fromRef`'s tip when absent
   *  (idempotent; a present branch is left untouched — its tip is NOT reset). Used to
   *  cut an epic integration branch off the default branch. Optional: hosts without a
   *  refs API omit it and the caller skips epic-branch orchestration. */
  ensureBranch?(branch: string, fromRef: string): Promise<void>;
```

In `src/forge/github.ts`, implement using the same `this.run`/`gh api` convention as `defaultBranch`. Reference shape (adapt to the real runner):

```ts
  async ensureBranch(branch: string, fromRef: string): Promise<void> {
    // already present? then leave it — never reset an in-flight integration branch.
    try {
      await this.run(["api", `repos/${this.slug}/git/ref/heads/${branch}`]);
      return;
    } catch {
      // not found → fall through to create
    }
    const baseRef = await this.run(["api", `repos/${this.slug}/git/ref/heads/${fromRef}`]);
    const sha = JSON.parse(baseRef).object.sha as string;
    await this.run([
      "api",
      "--method",
      "POST",
      `repos/${this.slug}/git/refs`,
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${sha}`,
    ]);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/github-ensure-branch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/forge/types.ts src/forge/github.ts test/github-ensure-branch.test.ts
git commit -m "feat(forge): ensureBranch — create a branch off a ref idempotently"
```

---

## Task 6: Drain — ensure the integration branch + thread it into spawn base

**Files:**
- Modify: `src/drain.ts` — `buildEpic` (pass `integrated` set), `buildState` (compute + carry the integration branch for the active epic), `doSpawn` (epic child → base on integration branch). Add an `integrationBranch?: string` to the spawn decision.
- Modify: `src/drain-core.ts` — extend the `spawn` decision and `DrainRepoState` so the integration branch flows from state to `doSpawn`.
- Test: `test/drain-epic-spawn-base.test.ts` (mirror the harness/mocks in existing `test/drain*.test.ts`).

- [ ] **Step 1: Write the failing test**

Mirror the existing drain test harness (mocked `forge`, `service`, `store`, `worktree`). The new assertions:

```ts
// test/drain-epic-spawn-base.test.ts — shape mirrors existing drain tests
import { test, expect } from "bun:test";
// import { makeDrainHarness } from "./helpers/drain-harness"; // use whatever existing tests use

test("an epic-child spawn bases the worktree on the integration branch, not default", async () => {
  // Arrange: a running epic (parent #327) with one ready child #320; forge.defaultBranch="main".
  // forge.ensureBranch + service.create are spies.
  const h = makeEpicDrainHarness({
    parent: 327,
    parentTitle: "EFI cluster",
    children: [{ number: 320, blockedBy: [] }],
  });
  await h.drain.pump(h.repoPath);
  // integration branch ensured off default
  expect(h.forge.ensureBranch).toHaveBeenCalledWith("epic/327-efi-cluster", "main");
  // child spawned with baseBranch = integration branch
  const createArg = h.service.create.mock.calls[0][0];
  expect(createArg.baseBranch).toBe("epic/327-efi-cluster");
  expect(createArg.issueRef.number).toBe(320);
});

test("a regular (non-epic) spawn still bases on the default branch", async () => {
  const h = makeLabelDrainHarness({ issues: [{ number: 7, labels: ["shepherd"] }] });
  await h.drain.pump(h.repoPath);
  expect(h.service.create.mock.calls[0][0].baseBranch).toBe("main");
  expect(h.forge.ensureBranch).not.toHaveBeenCalled();
});
```

> Build the harness from the existing drain test utilities — do not invent a new mock framework. If `makeEpicDrainHarness` doesn't exist, assemble the mocks inline the way the nearest existing epic drain test does.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/drain-epic-spawn-base.test.ts`
Expected: FAIL — spawns still base on `defaultBranch`; `ensureBranch` never called.

- [ ] **Step 3: Write minimal implementation**

In `src/drain-core.ts`, extend the spawn decision and repo state so the integration branch reaches `doSpawn`:

```ts
export type DrainDecision =
  | { kind: "spawn"; issue: Issue; integrationBranch?: string }
  | { kind: "retire"; sessionId: string; prNumber: number }
  | { kind: "hold"; reason: HoldReason };
```

Add to `DrainRepoState` (near `epicApprovedNext`):

```ts
  /** Epic mode: the active epic's integration branch — epic-child spawns base on it.
   *  null/undefined for label-drain (spawns base on the default branch). */
  epicIntegrationBranch?: string | null;
```

In `computeNext`, attach the branch to the spawn it returns:

```ts
  return { kind: "spawn", issue: next, integrationBranch: state.epicIntegrationBranch ?? undefined };
```

In `src/drain.ts`:

1. `buildEpic` — load and pass the integrated set. After computing `sessions` and before `assembleEpic`, add:

```ts
    const integrated = this.deps.store.listEpicIntegrated(repoPath, run.parentIssueNumber);
```

and pass `integrated` in the `assembleEpic({ ... })` call.

2. `buildState` — when the epic is active and built, compute and ensure the integration branch, and put it on the state. In the `if (builtEpic) { ... }` block (around line 252):

```ts
      if (builtEpic) {
        epicParent = epicRun!.parentIssueNumber;
        epicIntegrationBranch = epicIntegrationBranch ?? // computed below
          epicBranchFor(builtEpic);
        if (epicRun!.status === "running") {
          await this.ensureEpicBranch(repoPath, epicIntegrationBranch);
          candidates = selectEpicCandidates(builtEpic.children);
        }
        epicAttended = epicRun!.mode === "attended";
      }
```

Declare `let epicIntegrationBranch: string | null = null;` alongside `epicParent`, add a private helper, and include `epicIntegrationBranch` in the returned `state`:

```ts
import { epicIntegrationBranch as epicBranchName } from "./epic-branch";

// helper near buildEpic
private epicBranchFor(epic: Epic): string {
  return epicBranchName(epic.parentIssueNumber, epic.parentTitle);
}

/** Idempotently cut the integration branch off the latest default branch. Best-effort:
 *  a failure warns and the spawn falls back to the default branch (Stage A still works
 *  per-PR; the epic just doesn't accumulate on a branch this tick). */
private async ensureEpicBranch(repoPath: string, branch: string): Promise<void> {
  const forge = this.deps.resolveForge(repoPath);
  if (!forge?.ensureBranch) return;
  try {
    await forge.ensureBranch(branch, await forge.defaultBranch());
  } catch (err) {
    console.warn(`[drain] ensureEpicBranch ${branch} failed for ${repoPath}:`, err);
  }
}
```

(Use `this.epicBranchFor(builtEpic)` directly rather than the placeholder `epicBranchFor`.)

3. `doSpawn` — choose the base branch from the decision. Replace `const base = await forge.defaultBranch();` (line 528) with:

```ts
      // Epic children base on the epic integration branch so each builds on its
      // predecessors' merged work; regular tasks base on the default branch.
      const base = decision.integrationBranch ?? (await forge.defaultBranch());
```

(`doSpawn`'s `decision` is the `spawn` variant, which now carries `integrationBranch`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/drain-epic-spawn-base.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Run the full drain suite to catch regressions**

Run: `bun test ./test/drain-core.test.ts ./test/drain.test.ts` (and any other `drain*` tests).
Expected: PASS — existing label-drain spawns unaffected (`integrationBranch` undefined → default branch).

- [ ] **Step 6: Commit**

```bash
git add src/drain.ts src/drain-core.ts test/drain-epic-spawn-base.test.ts
git commit -m "feat(epic): ensure integration branch + base epic-child spawns on it"
```

---

## Task 7: Drain — squash-merge an epic child into the integration branch on retire + record it

**Files:**
- Modify: `src/drain.ts` — `doRetire` branches for epic children: squash-merge the child PR into the integration branch and record it, instead of leaving the PR open.
- Test: `test/drain-epic-retire-merge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/drain-epic-retire-merge.test.ts — shape mirrors existing drain retire tests
import { test, expect } from "bun:test";

test("retiring an epic child squash-merges its PR into the integration branch and records it", async () => {
  // running epic #327; child #320 has a green/mergeable PR #330 (session is an epic auto child).
  const h = makeEpicRetireHarness({ parent: 327, child: 320, pr: 330 });
  await h.drain.pump(h.repoPath);
  expect(h.forge.merge).toHaveBeenCalledWith(330, { method: "squash", deleteBranch: false });
  expect(h.store.listEpicIntegrated(h.repoPath, 327).has(320)).toBe(true);
  expect(h.service.archive).toHaveBeenCalledWith(h.sessionId);
});

test("a merge failure does not record integration nor abort the pump", async () => {
  const h = makeEpicRetireHarness({ parent: 327, child: 320, pr: 330, mergeThrows: true });
  await h.drain.pump(h.repoPath);
  expect(h.store.listEpicIntegrated(h.repoPath, 327).has(320)).toBe(false);
  // session stays live for a retry — not archived on merge failure
  expect(h.service.archive).not.toHaveBeenCalled();
});

test("a non-epic retire still leaves the PR open (unchanged)", async () => {
  const h = makeLabelRetireHarness({ pr: 42 });
  await h.drain.pump(h.repoPath);
  expect(h.forge.merge).not.toHaveBeenCalled();
  expect(h.forge.ensureIssueLink).toHaveBeenCalled(); // legacy path intact
  expect(h.service.archive).toHaveBeenCalled();
});
```

> Reuse the existing retire-test harness. `makeEpicRetireHarness` should mark the session as an epic auto child (its `issueNumber` is an active epic's child) so `doRetire` takes the epic branch.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/drain-epic-retire-merge.test.ts`
Expected: FAIL — `doRetire` never calls `forge.merge`; nothing is recorded.

- [ ] **Step 3: Write minimal implementation**

In `src/drain.ts` `doRetire`, before the existing `ensureIssueLink` block, detect an epic child of the active epic and, if so, merge + record + archive, then return. Add a small resolver and branch:

```ts
  private async doRetire(
    repoPath: string,
    decision: Extract<DrainDecision, { kind: "retire" }>,
  ): Promise<void> {
    const forge = this.deps.resolveForge(repoPath);
    if (!forge) return;
    const s = this.deps.store.get(decision.sessionId);

    // Epic child: squash-merge the PR INTO the integration branch (not default) and record
    // it, so dependents unblock without GitHub auto-close. The child issue stays open until
    // the final epic→default PR lands (Stage B). Only when this session's issue is a child of
    // the repo's active epic.
    const epicRun = this.deps.store.getEpicRun(repoPath);
    const epicActive =
      !!epicRun && (epicRun.status === "running" || epicRun.status === "paused");
    if (epicActive && s?.issueNumber != null) {
      const epic = await this.buildEpic(repoPath, epicRun!);
      const isChild = epic?.children.some((c) => c.number === s.issueNumber);
      if (isChild) {
        try {
          await forge.merge(decision.prNumber, { method: "squash", deleteBranch: false });
        } catch (err) {
          console.warn(
            `[drain] epic child merge pr#${decision.prNumber} (issue #${s.issueNumber}) into ${epicRun!.parentIssueNumber} integration failed:`,
            err,
          );
          return; // leave the session live; next tick retries. Do NOT record or archive.
        }
        this.deps.store.recordEpicIntegrated(repoPath, epicRun!.parentIssueNumber, s.issueNumber);
        try {
          this.deps.service.archive(decision.sessionId);
        } catch (err) {
          console.warn(`[drain] archive (epic child) failed for ${decision.sessionId}:`, err);
          return;
        }
        // Keep the claim: the issue stays open until the epic lands; releasing would let it
        // re-spawn. Mirrors the legacy retire path.
        this.retainClaimOnArchive.add(decision.sessionId);
        this.deps.dropPrCache(decision.sessionId);
        this.deps.emitArchived(decision.sessionId);
        return;
      }
    }

    // ── non-epic retire (unchanged) ──
    // Best-effort issue link: a failure must NOT block teardown.
    if (s?.issueNumber != null) {
      try {
        await forge.ensureIssueLink?.(decision.prNumber, s.issueNumber);
      } catch (err) {
        console.warn(
          `[drain] ensureIssueLink pr#${decision.prNumber} issue#${s.issueNumber} failed for ${decision.sessionId}:`,
          err,
        );
      }
    }
    try {
      this.deps.service.archive(decision.sessionId);
    } catch (err) {
      console.warn(`[drain] archive failed for ${decision.sessionId}:`, err);
      return;
    }
    this.retainClaimOnArchive.add(decision.sessionId);
    this.deps.dropPrCache(decision.sessionId);
    this.deps.emitArchived(decision.sessionId);
  }
```

(Keep the existing trailing comment block's intent; this preserves the legacy path verbatim below the epic branch.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/drain-epic-retire-merge.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Run drain + epic suites for regressions**

Run: `bun test ./test/drain.test.ts ./test/drain-core.test.ts ./test/epic-core.test.ts ./test/epic-model.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/drain.ts test/drain-epic-retire-merge.test.ts
git commit -m "feat(epic): squash-merge epic child into integration branch on retire"
```

---

## Task 8: Full verification + lint

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the root package**

Run: `bunx tsc --noEmit`
Expected: no errors. (The new `integrationMerged` field is required on `EpicChild`; fix any other `EpicChild`/`AssembleInput` literal in the codebase — e.g. server epic routes or fixtures — that the compiler flags as missing it.)

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: clean (run with `--fix` semantics per the repo's lint script if it auto-fixes; otherwise resolve manually — never suppress).

- [ ] **Step 3: Full server test suite**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 4: Fallow delta audit (the repo's pre-push complexity/dead-code gate)**

Run: `bunx fallow audit --base origin/main --fail-on-issues`
Expected: no new dead code; cognitive complexity within bounds. If `doRetire` trips the cognitive-complexity gate, extract the epic-child branch into a private `mergeEpicChild(repoPath, decision, s, epicRun)` helper and call it from `doRetire` (keeps behavior identical, lowers the function's complexity).

- [ ] **Step 5: Commit any verification fixes**

```bash
git add -A
git commit -m "chore(epic): typecheck/lint/fallow fixes for Stage A"
```

---

## Out of scope (Stage B — separate plan)

- The final aggregated `integration → default` PR (`Closes #<each child>` + parent) and the `landing` epic status / lifecycle.
- Epic-panel UI surfacing (integration branch, merged-into-epic vs issue-closed, landing banner) + i18n + feature-catalog entry.
- behindBase rebase-recovery of a sibling child PR before its merge (Stage A relies on the existing `mergeable === true` retire gate; a genuinely behind-but-mergeable PR merges fine via `gh pr merge`).
- Integration-branch deletion/cleanup after landing.
- Forge-query reconciliation of `integrationMerged` for a human-merged child PR.

## Self-review notes

- **Spec coverage:** done-signal (T2/T3), persisted record (T4), integration branch ensure (T5/T6), epic-child base branch (T6), child squash-merge into integration branch (T7) — all Stage A spec sections covered. Stage B sections explicitly deferred above.
- **Type consistency:** `integrationMerged` added to `EpicChild` (T2) and set in `assembleEpic` (T3); `integrated: Set<number>` on `AssembleInput` (T3) and supplied by `buildEpic` (T6) and store `listEpicIntegrated` (T4); `integrationBranch?` on the `spawn` decision (T6) consumed in `doSpawn` (T6). `forge.merge(pr, { method, deleteBranch })` matches `MergeInput` in `forge/types.ts`.
- **Harness caveat:** Tasks 5–7 must mirror the *existing* forge/drain test harnesses rather than the illustrative `makeXHarness` placeholders — the executing agent should read the nearest existing `test/github*.test.ts` / `test/drain*.test.ts` and match their mock-injection shape before writing the test body.
