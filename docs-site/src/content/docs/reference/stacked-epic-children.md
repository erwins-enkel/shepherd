---
title: Stacked epic children
description: What changes when an epic stacks its children's pull requests on each other — bottom-up merge order, how a lost middle layer is repaired, and the repository settings that quietly break stacking.
---

Normally an epic child waits for its dependency to **merge** before it is spawned, so a chain of
three dependent children is three sequential round-trips. With **stacked epic children** on, a child
whose only outstanding blocker has an *open* pull request is spawned immediately, based on that
pull request's head branch, and the resulting PRs are linked into a GitHub **stack** rooted at the
epic's integration branch.

It is opt-in per repository: **Automation → Stacked epic children**. GitHub only — the stacked-PR
API does not exist on Gitea or in local-only mode, and an epic on those forges runs exactly as
before.

:::caution
GitHub's stacked pull requests are a **public preview**. Every page of its documentation says the
API is subject to change, and some of the behaviour below is undocumented — found empirically.
:::

## What changes, and what doesn't

**Spawn order changes.** Children start as soon as their predecessor has an open PR, not when it
merges. That is the entire point.

**Merge order does not become free.** Within a chain, layers land **bottom-up**: Shepherd merges
only the bottom-most layer that has not landed yet, then the next one, and so on. Merging a layer of
a GitHub stack lands *every layer beneath it*, so this restriction is what keeps an autonomous merge
from silently landing work that was never gated. A higher layer simply waits; it needs nothing from
you.

**Nothing about the epic's shape changes.** Children still squash-merge into the epic's integration
branch, the epic still lands as one final pull request, and progress is still tracked per child. A
chain that Shepherd cannot stack falls back to waiting for merges, which is the pre-stacking
behaviour, not an error.

## Repository settings that break stacking

### A ruleset that requires a status check on *all* branches

This is the one that will catch you out. Keeping a stack current means force-pushing each layer
after the one below it changes. If a repository ruleset requires a status check and targets **all
branches**, that force-push is rejected outright:

```
GH013: Repository rule violations found for refs/heads/<layer-branch>
```

Branch **creation** can be exempted from a ruleset (`do_not_enforce_on_create`), and that is often
mistaken for a fix. It is not: a restack is an **update**, not a creation, and updates cannot be
exempted. In such a repository the only way to restack is GitHub's own server-side "update branch"
button — and the commits it creates are **unsigned**, which is usually the very thing the ruleset
exists to prevent.

If you need required checks, scope the ruleset to the branches that actually need protecting (your
default branch, release branches) rather than to `**`.

### CI that runs the whole workflow per layer

A `pull_request` workflow runs for **every layer** of a stack, because triggers evaluate against the
stack's base. Worse, an automatic restack after a partial merge re-fires CI for the entire
remainder. Wall-clock and runner minutes scale with stack depth, and a five-deep stack can spend
more time in CI than the sequential version it replaced.

GitHub's own mitigation is to gate expensive jobs on the top of the stack:

```yaml
if: github.event.pull_request.stack.position == github.event.pull_request.stack.size
```

Run linting and unit tests per layer; save the slow end-to-end suite for the top.

## When a middle layer is lost

A stack is linear. If a middle layer's pull request is closed, or its child is abandoned and
re-spawned onto a fresh PR, every layer above it is based on a branch that will never land — and
**GitHub has no API to reorder a stack or drop a single layer from it** (`gh stack modify` is
interactive-only, so an unattended agent cannot use it). The only repair primitive is to dissolve
the stack and rebuild it.

So Shepherd fails loudly rather than quietly:

1. It **unstacks** the whole stack. Every layer keeps its branch and its pull request — nothing is
   deleted.
2. It raises a **blocking epic warning** naming the lost child and every child left stranded.
3. It **stops stacking for that epic** — no new stacks, and new children go back to waiting for
   merges — until the stranded children are resolved.

**"Stranded" is not only the layers above the hole.** Dissolving the stack takes the whole thing
with it, and *any* child that was spawned on a sibling's branch — above or below the lost layer —
is left targeting a branch that will never land. Only the bottom layer, which was spawned on the
epic's integration branch, retires normally afterwards. The warning names every affected child, so
work through the list rather than assuming the layers below the hole were spared.

To clear it, for each stranded child either:

- **Abandon it.** The issue re-enters the drain and re-spawns on the epic's integration branch, or
- **merge its pull request yourself**, with its base re-targeted to the epic's integration branch.
  Shepherd notices the merge and records it as an integration.

Re-targeting a stranded PR **without** merging it does not help: Shepherd decides an epic child's
merge base from the base its *session* was spawned on, and that is fixed when the session is
created. The epic warning names the two remedies above for exactly this reason. The one exception
is the next section: once the branch a child was spawned on has itself landed on the epic branch,
Shepherd re-targets the child for you.

## When a predecessor lands before its successor opens a PR

A child is spawned on its predecessor's branch while the predecessor's PR is open. If the
predecessor merges into the epic branch **before** the child opens its own PR, there is nothing to
stack yet, so the predecessor lands on its own — and the child's PR is then opened against a branch
that has already merged. That branch will never be merged again, so work merged into it is lost to
the epic.

Shepherd handles this in three places:

- **It re-targets the child.** On the next drain pass, a child whose spawn branch belongs to an
  integrated sibling has its PR re-pointed at the epic's integration branch, and its session is
  moved onto that branch too. From then on it retires — and stacks with the layers above it — like
  any other child. If you re-targeted the PR yourself, Shepherd adopts that without another write.
  A predecessor that has *not* integrated is left alone: re-targeting then would land the
  predecessor's ungated commits on the epic branch. So is a child whose branch does not contain the
  predecessor's **final** commit (it was cut before the predecessor's last rework): landing it
  would bring back anything that rework removed. Rebase such a child onto the epic branch (or merge
  the predecessor's final branch into it); once its head contains either tip, Shepherd moves it.
- **It refuses manual merges into a dead base.** The Merge buttons on a session and in the Backlog
  PR list answer `base_already_merged` when a PR's base is the branch of a session whose own PR
  already merged, and name the branch to re-target onto. Merges made directly on GitHub cannot be
  stopped, which is why the re-target above happens on its own.
- **It never closes such a child's issue.** When an epic child's PR merges anywhere other than the
  epic branch, nothing is recorded as integrated and the issue stays open (the claim is kept, so it
  does not re-spawn). The epic shows a **blocking warning** naming the child and the branch its
  session was based on: land that work on the epic branch yourself, then close the issue.

After re-targeting, the PR's diff can show the predecessor's changes again — they were squashed
into the epic branch, so their original commits are not recognised as already merged. Squash-merging
the child is normally still clean.

## Known gaps

- **Merged layer branches are not cleaned up.** GitHub's stacked-merge API takes no delete-branch
  parameter, so a landed layer's head branch stays on the remote. Nothing reaps it today.
- **No partial repair.** Because there is no drop-one endpoint, a single lost layer dissolves the
  whole stack — including the layers below it, which were perfectly healthy and now need the same
  abandon-or-merge treatment. Deep stacks therefore cost more to repair; keep chains short.
