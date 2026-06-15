---
name: merge-train
description: Review all open PRs for plausibility, validity and product-fit, propose a merge order, then merge on approval. Use when asked to "work through the open PRs", "review and merge the PR queue", "run the merge train", or triage what should land next.
---

# Merge Train

Review every open PR, judge whether each is correct AND wanted, propose a safe
merge order, and — only after explicit approval — merge them in that order,
re-checking the queue after each merge because main moves under you.

This repo is worked by **multiple concurrent agents**, so the open-PR set
overlaps and drifts constantly. Treat shared-main drift as the default hazard,
not the exception.

## Stages

Work the stages in order. Create a TodoWrite item per stage.

### 1. Gather

Enumerate open, non-draft PRs (skip drafts):

```bash
gh pr list --state open --json number,title,headRefName,author,isDraft,mergeable,baseRefName --limit 100
```

Drop any `isDraft: true`. For every remaining PR collect, via `gh`:

```bash
gh pr view <n> --json number,title,headRefName,mergeable,mergeStateStatus,files,reviewDecision,statusCheckRollup,labels,body
gh pr checks <n>            # CI status detail
gh pr view <n> --comments   # existing critic-on-PR / human reviews
```

Capture per PR: changed-file list, `mergeable`/`mergeStateStatus`, CI rollup,
existing review verdicts (especially any **critic** request-changes), and how far
behind main it is:

```bash
git fetch --quiet origin main
git rev-list --count origin/main..origin/<headRefName>   # ahead
git rev-list --count origin/<headRefName>..origin/main   # behind (rebase freshness)
```

Build a **file-overlap matrix**: which PRs touch the same files. Overlap drives
both conflict risk and merge ordering.

**release-please PRs** (`chore(main): release …`, branch
`release-please--…`) are mechanical version bumps — flag them and always
sequence them **last**.

### 2. Product-vision brief

Before reviewing, assemble a short brief (~10 lines) from `CLAUDE.md`, `README`,
and project memory describing what Shepherd is and where it's heading. Every
reviewer judges product-fit against this same yardstick, so "do we even want
this?" is answered consistently rather than per-reviewer taste.

### 3. Fan-out review (parallel, read-only)

Spawn **one subagent per PR in a single parallel batch** (multiple `Agent` tool
calls in one message). Reviewers are **read-only**: allow Bash (`gh`/`git`),
Read, Grep, Glob — **no Edit/Write/merge**. Give each reviewer:

- the PR number + `gh pr diff <n>` instructions
- the product-vision brief from stage 2
- the gate rules (below)
- the changed-file lists of the **other** open PRs (for overlap awareness)

Each reviewer's final message **is** a verdict block in exactly this shape (no
prose around it):

```
PR: #<n> — <title>
correctness: <pass|concerns|fail> — <one line: does it do what the title claims; bugs/regressions>
product_fit: <keep|question|drop> — <one line: do we want this; fits the vision?>
gates:
  i18n: <pass|fail|n/a> — <EN+DE catalog parity for any new user-facing string>
  hygiene: <pass|fail> — <no merge commits relative to main>
ci: <green|red|pending> — <failing checks if any>
rebase: <fresh|behind N>
overlaps: <#m, #k | none> — <files/areas that collide>
verdict: <merge|needs-work|reject>
rationale: <one line>
```

### 4. Synthesize the merge order

Main agent collects all verdicts and produces the proposal:

- **Exclude** from the train any PR that is `reject`, `needs-work`, gate-failing,
  CI-red, or `product_fit: drop`. List these in a separate **hold/reject**
  bucket with the reason.
- For the rest, order by:
  1. independent, low-risk, small-diff PRs first;
  2. when two PRs overlap, sequence them so the smaller / riskier one rebases
     onto the other (note the forced rebase);
  3. anything depending on another PR's change goes after it;
  4. **release-please last**.
- Note for each ordered PR whether it will need a rebase before merging.

Present as a numbered merge order + the hold/reject bucket, each line with a
one-line rationale.

### 5. Approve (hard gate)

Present the proposal and stop. Use `AskUserQuestion` to confirm the order,
amend it, or abort. **Nothing is merged before this gate.** If the user amends,
re-synthesize and re-present.

### 6. Merge on approval

> **NEVER move the home base's checked-out branch.** The primary working
> directory (where the Shepherd server runs and the New Task form reads its
> default base branch) is the **home base**. Shepherd cuts every new task branch
> from the home base's checked-out `HEAD`, so a `git checkout` / `git switch` /
> `git checkout -B` there silently re-bases any task spawned **mid-train** onto a
> throwaway branch (`mt-…`) instead of `main`/`dev`. That task then loses its
> autopilot/critic/plan-gate wiring because its base ref vanishes when the train
> finishes and the branch is deleted — and the New Task form is opaque, so the
> operator won't notice. Do **all** rebasing in an **isolated scratch worktree**;
> the home base stays on its original branch for the entire train.

**Set up once, before the loop** — capture the home-base branch and add a
scratch worktree (never reused by Shepherd sessions):

```bash
HOME_BASE=$(git rev-parse --abbrev-ref HEAD)            # e.g. "main" — must not change
git fetch --quiet origin main
WT="$(git rev-parse --show-toplevel)/../.merge-train-wt"
git worktree add --detach "$WT" origin/main            # scratch tree, HEAD detached
```

For each approved PR, in order — operate **only inside `$WT`**, never `cd` or
`checkout` in the home base:

1. Ensure it's rebased on the latest `main`. If behind, rebase its branch onto
   `origin/main` **inside the scratch worktree** and force-push; never
   `git merge main` into it (hygiene gate):
   ```bash
   git -C "$WT" fetch --quiet origin main <headRefName>
   git -C "$WT" checkout -B mt-<n> origin/<headRefName>
   git -C "$WT" rebase origin/main                       # resolve conflicts here
   git -C "$WT" push --force-with-lease origin mt-<n>:<headRefName>
   ```
2. Confirm gates are green: CI passing, branch hygiene clean, i18n parity.
3. Merge: `gh pr merge <n> --squash --delete-branch` (server-side — run from
   anywhere; it does not touch the home base's HEAD).
4. **Re-check the remaining queue**: `git fetch origin main`, recompute
   behind-counts and overlaps for the not-yet-merged PRs. Main just moved — a PR
   that was fresh may now conflict.
5. On **any** failure (CI flips red, conflict, rebase fails), **stop the train**:
   drop that PR, report it, and continue only with PRs unaffected by it. Never
   force a merge past a red gate.

**Tear down after the loop** — remove the scratch worktree and assert the home
base never moved:

```bash
git worktree remove --force "$WT"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$HOME_BASE" ] || echo "WARNING: home base moved off $HOME_BASE"
```

Report a final summary: what merged, what was held, and any follow-ups.

## Gate rules (reference)

- **Branch hygiene** — `scripts/check-branch-hygiene.sh`: branch must be linear
  off main, zero merge commits relative to `origin/main`.
- **i18n parity** — `cd ui && bun run check:i18n`: any new user-facing string
  needs matching keys in **both** `ui/messages/en.json` and `de.json`.
- **Tests/lint** — root: `bun install && bun run lint && bun test`; UI:
  `cd ui && bun install && bun run check && bun run test` (vitest, not `bun test`).
  Run only when a verdict is uncertain and the diff warrants local verification;
  otherwise trust CI rollup.

## Principles

- Read-only until approved; the user owns the merge decision.
- "Correct" and "wanted" are separate questions — a flawless diff for a feature
  we don't want is still a `drop`.
- Re-evaluate after every merge; concurrent agents make a stale plan dangerous.
- A red gate removes a PR from the train; it never gets bypassed.
- Never move the home base's checked-out branch — rebase in an isolated scratch
  worktree so tasks spawned mid-train still cut from the correct base.
