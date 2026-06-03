# Skip critic re-review on content-identical head changes

**Date:** 2026-06-03
**Status:** Approved design, pending implementation

## Problem

The AI critic dedups on the PR **head SHA** (`src/review.ts:145`):
`getReview(id)?.headSha === git.headSha`. A rebase or force-push changes
the head SHA, so the PR poller (`src/pr-poller.ts:78`) sees a "new head",
emits `session:git`, and `consider()` spawns a full critic run — even when
the branch's changes are byte-for-byte identical.

The motivating case: a **merge-train** force-pushing a rebase of a branch
onto latest `main` before merge. The rebase incorporates new `main` but the
branch's own changes are unchanged, yet the critic re-reviews from scratch.

Detecting a rebase by **who pushed** / commit author is unreliable — the
merge-train runs under the same user account as the human. The fix sidesteps
identity entirely and asks: *did the content the critic would review change?*

## Principle

Dedup the critic on **what it reviews**, not on the head SHA. The critic
reviews exactly `git diff <base>...HEAD` (`src/review.ts:20`) — the branch's
own changes relative to its base. A content fingerprint of that diff is stable
across a pure rebase and changes only when the branch's actual changes change.

## Fingerprint: `git patch-id`

Compute `git patch-id --stable` over `git diff <base>...HEAD`, take the first
token (the patch id). Rationale:

- patch-id deliberately **ignores line numbers**, so a rebase that only shifts
  the branch's hunks (because new `main` edited code elsewhere in the same
  files) still produces the same id.
- It **does** hash the changed lines and their immediate context, so it differs
  when there are new commits, or when conflict resolution during the rebase
  altered the branch's content. Both genuinely warrant a fresh review.

Rejected alternatives:

- **Raw `sha256` of the diff text** — not line-number invariant; a rebase that
  shifts hunk positions near the branch's edits would falsely re-review,
  defeating the purpose.
- **Topology / "is-ancestor" check** (fast-forward vs rebase) — looks at commit
  graph shape, not content; can't distinguish a clean rebase from a rebase that
  resolved conflicts. Also leans on the unreliable identity signal.

## Flow (`src/review.ts` `begin()`)

1. `createDetached(repoPath, branch, headSha)` — already happens; the worktree
   resolves both head and base (proven: today's post-rebase reviews already run
   `git diff base...HEAD` in this worktree successfully).
2. Compute `patchId` in that worktree (via injected dep — see Testability).
3. `prior = getReview(id)`. If `prior.patchId` is non-empty **and** equals the
   new `patchId` → **skip**:
   - `store.bumpReviewHead(id, headSha)` — update the stored head SHA only.
   - `worktree.remove(...)`, return.
   - The prior verdict (findings, rounds, posted review URL) stays intact:
     outstanding findings still apply to identical content, and we must not
     double-post a review.
4. Else proceed exactly as today; thread `patchId` through `InFlight` →
   `buildVerdict()` → `putReview()` so it persists with the verdict.
5. **Reorder**: run steps 2–3 *before* the author-notes `gh` fetch
   (`fetchAuthorNotes`, currently `review.ts:176-183`) so the skip path makes
   zero forge calls.

### Ordering & the `starting`/`forget` tombstone

`begin()` claims `this.starting` before its first await (`consider()`,
`review.ts:147`) and re-checks `this.starting.has(id)` after the await
(`review.ts:187`) so an archived session aborts. After reordering, the only
remaining await on the proceed path is `fetchAuthorNotes`. Keep a
`starting`-tombstone re-check after that await before spawning, and ensure the
worktree created in step 1 is removed on every early-return path (skip, abort,
spawn failure).

## Safety default

If patch-id is empty (no diff) or the git call fails → **do not skip; review**.
Never skip on uncertainty.

## Skip scope (accepted tradeoff)

The critic only reviews the branch diff, but it *can* grep the full worktree
(including new `main` code). Skipping a rebase means it won't re-inspect the
branch against the newer base. This is accepted because:

- CI being green is already a precondition of any critic run (`review.ts:141`).
- The first review covered these exact branch changes.
- Cross-file semantic drift from new `main` (e.g. `main` removed a symbol the
  branch uses in an untouched file) is an edge case CI green largely guards,
  and is not reliably caught by a diff-focused review anyway.

## Activation

**Always-on. No per-repo toggle, no UI, no i18n strings.** This is a strictly
correctness-preserving optimization: it skips only when the reviewed diff is
provably identity-invariant-and-line-number-invariant, so it can never skip a
real change. It reduces critic spend rather than adding a spendy/risky loop, so
the house rule of gating auto-features behind a kill switch does not apply.

## Persistence

- `reviews` table (`src/store.ts:107-115`): add column
  `patchId TEXT NOT NULL DEFAULT ''`. Existing DBs need an
  `ALTER TABLE reviews ADD COLUMN patchId TEXT NOT NULL DEFAULT ''`, guarded to
  run only when the column is absent (match the store's existing migration
  pattern).
- `ReviewVerdict` type (`src/types.ts`): add `patchId: string`.
- `putReview` (`src/store.ts:411`): include `patchId`.
- New store method `bumpReviewHead(sessionId, headSha)`:
  `UPDATE reviews SET headSha = ?, updatedAt = ? WHERE sessionId = ?` — bumps the
  head (and `updatedAt`) without touching `decision`/`findings`/rounds/`patchId`.

## Testability

Add an injectable dep to `ReviewServiceDeps`, mirroring the existing
`readVerdict`:

```
computePatchId?: (worktreePath: string, base: string) => string | null;
```

Default implementation runs the real `git diff base...HEAD | git patch-id
--stable` in the worktree. Unit tests inject a stub.

### Test cases

1. **Rebase (identical patch-id)** → no critic spawn; `bumpReviewHead` called
   with new SHA; prior verdict (findings/decision/rounds) preserved.
2. **New commit (different patch-id)** → critic spawns; new `patchId` persisted
   on the verdict.
3. **First review (no prior, or empty `prior.patchId`)** → spawns; stores
   `patchId`.
4. **patch-id empty / git failure** → reviews (safe default, no skip).
5. **Skip path makes no forge calls** (author-notes fetch not invoked).

## Out of scope

- Per-repo toggle / UI / i18n (always-on by decision).
- Changing what the critic reviews or how findings are steered.
- Detecting rebases by author/committer metadata (rejected approach).
