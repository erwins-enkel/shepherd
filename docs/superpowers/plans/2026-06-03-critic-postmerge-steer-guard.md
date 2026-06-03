# Critic Post-Merge Steer Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop an in-flight critic from steering findings into a task agent after that agent's PR has already merged/closed.

**Architecture:** Re-fetch authoritative live PR state at the last gate before the auto-address steer (`runAutoAddress` in `src/review.ts`) and skip the steer when the PR is not `"open"`. Surgical: `postReview`, `putReview`, and the learnings signal are untouched. Fail-closed when state can't be confirmed.

**Tech Stack:** Bun + TypeScript (root server package). Tests: `bun test`. Lint: `bun run lint`. Strict tsc: `bunx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-06-03-critic-postmerge-steer-guard-design.md`

---

## File Structure

- **Modify** `src/review.ts`
  - `InFlight` interface: add `branch: string`.
  - `begin()`: populate `branch` when constructing the `InFlight` record.
  - `runAutoAddress()`: become `async`, add the live PR-state recheck before steering.
  - `finalize()`: `await` the now-async `runAutoAddress()`.
- **Modify** `test/review.test.ts`
  - `fakeForge()` / `makeDeps()`: make `prStatus` injectable (default stays `OPEN_GREEN`).
  - Add 3 new tests (merged → no steer; throw → fail-closed; closed → no steer).

No UI, i18n, schema, or migration changes.

---

## Task 1: Failing test — a merged PR at finalize must not steer

Make the test forge's PR state injectable, then add the failing test proving the bug.

**Files:**
- Test: `test/review.test.ts` (modify `fakeForge`, `makeDeps`, add one test)

- [ ] **Step 1: Make `fakeForge` accept an injectable `prStatus`**

In `test/review.test.ts`, change the `fakeForge` signature and its `prStatus` field. Current:

```ts
function fakeForge(
  rec: { event?: string; body?: string },
  comments: PrComment[],
  commentCalls: number[],
): GitForge {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    prStatus: async () => OPEN_GREEN as PrStatus,
    openPr: async () => OPEN_GREEN as PrStatus,
```

Replace with (add 4th param, use it for `prStatus`):

```ts
function fakeForge(
  rec: { event?: string; body?: string },
  comments: PrComment[],
  commentCalls: number[],
  prStatus: () => Promise<PrStatus> = async () => OPEN_GREEN as PrStatus,
): GitForge {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    prStatus,
    openPr: async () => OPEN_GREEN as PrStatus,
```

- [ ] **Step 2: Thread `prStatus` through `makeDeps`**

In `makeDeps`, extend the `opts` type and pass it into `fakeForge`. Current `opts` param:

```ts
  opts: {
    autoAddressEnabled?: boolean;
    autoAddressReturns?: boolean;
    comments?: PrComment[];
  } = {},
```

Replace with:

```ts
  opts: {
    autoAddressEnabled?: boolean;
    autoAddressReturns?: boolean;
    comments?: PrComment[];
    prStatus?: () => Promise<PrStatus>;
  } = {},
```

Then change the `resolveForge` line inside `makeDeps`. Current:

```ts
    resolveForge: () => fakeForge(rec, opts.comments ?? [], commentCalls),
```

Replace with:

```ts
    resolveForge: () => fakeForge(rec, opts.comments ?? [], commentCalls, opts.prStatus),
```

- [ ] **Step 3: Write the failing test**

Add this test next to the other auto-address tests (after the "round cap reached" test):

```ts
test("PR merged before finalize: holds the round, posts the review, does NOT steer", async () => {
  const {
    deps: d,
    reviews,
    steers,
    rec,
  } = makeDeps(
    {
      readVerdict: () => ({
        decision: "request-changes",
        summary: "x",
        body: "b",
        findings: ["fix x"],
      }),
    },
    // critic spawned while open, but the PR merged before the verdict finalized
    { autoAddressEnabled: true, prStatus: async () => ({ ...OPEN_GREEN, state: "merged" }) },
  );
  const svc = new ReviewService(d as any);
  svc.consider(session(), OPEN_GREEN); // spawn while open (no prStatus call yet)
  await svc.tick(); // finalize: live recheck sees "merged"
  expect(steers).toHaveLength(0); // no churn steered onto a merged branch
  expect(reviews["s1"]?.addressRound).toBe(0); // round held (priorRound 0), not advanced
  expect(rec.event).toBe("REQUEST_CHANGES"); // surgical: review still posted
  expect(reviews["s1"]?.decision).toBe("changes_requested"); // verdict still persisted
});
```

- [ ] **Step 4: Run the test to verify it FAILS**

Run: `bun test ./test/review.test.ts -t "PR merged before finalize"`
Expected: FAIL — `steers` has length 1 (current code steers regardless of PR state).

- [ ] **Step 5: Commit the failing test**

```bash
git add test/review.test.ts
git commit -m "test(critic): failing test — merged PR must not steer the agent"
```

---

## Task 2: Implement the live PR-state guard

**Files:**
- Modify: `src/review.ts` (`InFlight` interface, `begin()`, `runAutoAddress()`, `finalize()`)

- [ ] **Step 1: Add `branch` to the `InFlight` interface**

In `src/review.ts`, find the `InFlight` interface. Current:

```ts
interface InFlight {
  sessionId: string;
  headSha: string;
  prNumber: number;
  repoPath: string;
  worktreePath: string;
  terminalId: string;
```

Insert `branch` after `prNumber`:

```ts
interface InFlight {
  sessionId: string;
  headSha: string;
  prNumber: number;
  branch: string; // head branch, for the at-finalize live PR-state recheck (prStatus keys on it)
  repoPath: string;
  worktreePath: string;
  terminalId: string;
```

- [ ] **Step 2: Populate `branch` in `begin()`**

In `begin()`, find the `this.inflight.set(session.id, { ... })` call. Current:

```ts
    this.inflight.set(session.id, {
      sessionId: session.id,
      headSha: git.headSha!,
      prNumber: git.number!,
      repoPath: session.repoPath,
```

Insert `branch` after `prNumber`:

```ts
    this.inflight.set(session.id, {
      sessionId: session.id,
      headSha: git.headSha!,
      prNumber: git.number!,
      branch: session.branch!,
      repoPath: session.repoPath,
```

- [ ] **Step 3: Make `runAutoAddress` async and add the recheck**

In `src/review.ts`, change the `runAutoAddress` signature and insert the live recheck after the cap guard. Current signature line:

```ts
  private runAutoAddress(f: InFlight, verdict: ReviewVerdict): number {
```

Replace with:

```ts
  private async runAutoAddress(f: InFlight, verdict: ReviewVerdict): Promise<number> {
```

Then find the cap guard and the steer block. Current:

```ts
    if (f.priorRound >= this.cap) return f.priorRound; // gave up → hold (stalled badge persists)
    // autoAddress (SessionService.reply) liveness-checks the pane and returns false for a
    // dead one, so a steer that can't land normally reports false. A throw is now only a
    // narrow race — the pane dies between the liveness check and herdr.send — and still
    // counts as not-delivered: the round must not advance on a steer that never landed,
    // and the throw must not strand finalize().
    let delivered = false;
```

Insert the recheck between the cap guard and the `let delivered = false;` line:

```ts
    if (f.priorRound >= this.cap) return f.priorRound; // gave up → hold (stalled badge persists)
    // Critic spawn and PR merge both fire on CI-green, so they race by construction: the
    // critic can finish AFTER the PR merged. Re-confirm the PR is still open at this last
    // gate before steering — otherwise we'd tell the agent to "commit & push so CI and the
    // critic re-run" on a branch whose PR is already merged/closed. Live fetch, not the
    // cached snapshot: the 120s poll can lag the merge, and staleness reintroduces the race.
    // Fail-closed — if we can't confirm "open" (forge throws / unresolved), don't steer: a
    // missed steer is recoverable (next push re-triggers; a human can send), churn on a dead
    // branch is not. Lazy (only here, past the findings/enabled/cap guards) so clean
    // verdicts and disabled-loop repos make no extra forge call.
    let open = false;
    try {
      const forge = this.deps.resolveForge(f.repoPath);
      open = (await forge?.prStatus(f.branch))?.state === "open";
    } catch (err) {
      console.warn(`[review] PR-state recheck failed for ${f.sessionId}:`, err);
    }
    if (!open) return f.priorRound; // PR no longer open (or unconfirmable) → hold, don't steer
    // autoAddress (SessionService.reply) liveness-checks the pane and returns false for a
    // dead one, so a steer that can't land normally reports false. A throw is now only a
    // narrow race — the pane dies between the liveness check and herdr.send — and still
    // counts as not-delivered: the round must not advance on a steer that never landed,
    // and the throw must not strand finalize().
    let delivered = false;
```

- [ ] **Step 4: Await `runAutoAddress` in `finalize`**

In `finalize()`, find the call. Current:

```ts
        verdict.addressRound = this.runAutoAddress(f, verdict); // errorRound stays 0 on a real verdict
```

Replace with:

```ts
        verdict.addressRound = await this.runAutoAddress(f, verdict); // errorRound stays 0 on a real verdict
```

- [ ] **Step 5: Run the failing test — it now PASSES**

Run: `bun test ./test/review.test.ts -t "PR merged before finalize"`
Expected: PASS.

- [ ] **Step 6: Run the full review suite — no regressions**

Run: `bun test ./test/review.test.ts`
Expected: PASS (all existing steer tests get the default `OPEN_GREEN` `prStatus`, so `open === true` and they steer exactly as before).

- [ ] **Step 7: Commit the fix**

```bash
git add src/review.ts
git commit -m "fix(critic): re-check live PR state before steering; skip on merged/closed PR"
```

---

## Task 3: Cover fail-closed (throw) and the closed-PR class

**Files:**
- Test: `test/review.test.ts` (add two tests)

- [ ] **Step 1: Write the fail-closed (throw) test**

Add next to the merged-PR test:

```ts
test("PR-state recheck throws: fail-closed — no steer, round held", async () => {
  const {
    deps: d,
    reviews,
    steers,
  } = makeDeps(
    { readVerdict: () => ({ decision: "comment", summary: "nit", body: "b", findings: ["x"] }) },
    {
      autoAddressEnabled: true,
      prStatus: async () => {
        throw new Error("gh unavailable");
      },
    },
  );
  const svc = new ReviewService(d as any);
  svc.consider(session(), OPEN_GREEN);
  await svc.tick(); // must NOT reject
  expect(steers).toHaveLength(0); // can't confirm open → don't steer
  expect(reviews["s1"]?.addressRound).toBe(0); // round held
});
```

- [ ] **Step 2: Write the closed-PR (whole-class) test**

```ts
test("PR closed (not merged) before finalize: also skips the steer", async () => {
  const { deps: d, steers } = makeDeps(
    { readVerdict: () => ({ decision: "comment", summary: "nit", body: "b", findings: ["x"] }) },
    { autoAddressEnabled: true, prStatus: async () => ({ ...OPEN_GREEN, state: "closed" }) },
  );
  const svc = new ReviewService(d as any);
  svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(steers).toHaveLength(0); // guard is state !== "open", not just merged
});
```

- [ ] **Step 3: Run the two new tests**

Run: `bun test ./test/review.test.ts -t "fail-closed"` then `bun test ./test/review.test.ts -t "PR closed"`
Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add test/review.test.ts
git commit -m "test(critic): cover fail-closed recheck + closed-PR steer skip"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `bun run lint`
Expected: clean (no errors).

- [ ] **Step 2: Strict tsc**

Run: `bunx tsc --noEmit`
Expected: no type errors (confirms `runAutoAddress`'s `Promise<number>` is correctly awaited in `finalize`).

- [ ] **Step 3: Full root server test suite**

Run: `bun test ./test`
Expected: all pass.

- [ ] **Step 4: Confirm working tree is committed**

Run: `git status --short`
Expected: empty (all changes committed across Tasks 1–3).

---

## Notes for the implementer

- **Why finalize-time, not an abort-on-merge event handler:** the 15s finalize tick can fire the steer before the 120s PR poller even detects the merge. Only a recheck at the steer gate is authoritative. Early abort-on-merge is a deliberate non-goal (see spec).
- **Why surgical:** `postReview` posting a review on a merged PR is harmless noise; the chaos is the agent steer telling it to push to a dead branch. Only the steer is gated.
- **Laziness matters:** the recheck sits *after* the findings-empty / loop-disabled / at-cap guards, so it never adds a forge call on the common no-steer paths.
- **Concurrency:** the new `await` is inside the `f.finalizing = true` window; `tick()` already `continue`s past `finalizing` entries, so no double-finalize race is introduced.
