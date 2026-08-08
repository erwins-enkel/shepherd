# What could Shepherd do with GitHub's stacked pull requests?

**Brief:** GitHub put **stacked pull requests** into public preview on **2026-07-30**. Shepherd has
three mechanisms that exist largely _because_ GitHub had no stacking primitive — the one-session-one-PR
invariant, the `epic/<#>-<slug>` integration-branch model, and the merge train. This note establishes
what GitHub actually shipped (mechanics + automation surface), what it breaks in Shepherd **today**,
and what is worth building.

**This file is a research/reference note — not code.** Everything below was verified against
`docs.github.com`, the `github/gh-stack` repo, live `api.github.com` probes, and Shepherd's own source
on 2026-08-08. Implementation would be one or more follow-up issues; §6 ranks them.

---

## 1. TL;DR

- **It is fully automatable, and it is already on for us.** `GET /repos/erwins-enkel/shepherd/stacks`
  returns **200** (empty list). A `404` is how "not enabled for this repository" presents, so stacks are
  live on our repo right now. There is a first-class REST API, read-only GraphQL fields, a new
  `pull_request.stacked` webhook action, and an **official `gh-stack` SKILL.md that installs directly
  into Claude Code**.
- **There is a compat gap that exists independent of anything we choose to build.** `forge.merge()` is
  `gh pr merge --squash`, and GitHub documents that the legacy synchronous merge **cannot merge a
  stacked PR**. `--admin` bypass does not work on stacks either, and **auto-merge is unsupported
  entirely**. The merge train and the Backlog "Merge" button therefore fail against any stacked PR — and
  Shepherd already _renders_ stacked PRs (the `→base` chip), so the UI invites the click that breaks.
- **Our epic model is a hand-rolled stack whose main cost is serialization.** `selectEpicCandidates`
  only spawns a child once every blocker is `integrationMerged || issueClosed`. Dependent children run
  strictly one at a time. Stacks replace that _wait_ with a _base pointer_.
- **The flagship idea is Build Queue → stack layers.** The build queue is already an ordered,
  agent-authored, operator-editable, position-stable plan with a per-step lifecycle. It is the _shape_ of
  a stack that currently collapses into one big PR. Making approved steps into stack layers turns the
  plan the operator already approved into the review unit — which attacks the same human O(N) review
  ceiling the critic was built for.
- **Hard constraint to design around: stacks are strictly linear.** One parent, at most one child. That
  fits a dependency _chain_; it does not model the epic DAG.

**Recommended:** fix the merge-path compat gap (§6 Tier 0) → real stack awareness in the PRs tab
(Tier 1) → epic dependency chains as stacks (Tier 2) → build queue as a stack (Tier 3).
**Recommended against for now:** replacing the `epic/` integration branch outright (§7).

---

## 2. What GitHub actually shipped

### 2.1 Data model

A stack is a **first-class server-side object**, not merely an inferred base-branch chain. It has an
`id`, a repo-scoped `number`, a `node_id` (`PRS_…`), a `base.ref` (the _trunk_), an `open` flag, and an
ordered `pull_requests[]` (bottom → top). Base-branch alignment is the _precondition_ GitHub uses to
recommend linking; membership itself is stored metadata you create explicitly.

Each layer is still a normal PR with a real branch, based on the branch below it. The decisive semantic:

> "Every pull request in a stack is evaluated against rules for the **base of the stack** — typically
> `main` — regardless of which branch it directly targets."
> — [reference/stacked-pull-requests](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests)

Every PR resource gains a nullable `stack` object: `{ id, number, size, position, base: { ref, sha } }`,
with `position` **1-based, 1 = bottom**.

### 2.2 Merging

| Behavior                               | Detail                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order                                  | Bottom-up only. Merging PR _n_ merges _n_ **and every unmerged PR below it**, atomically.                                                                           |
| Mid-stack in isolation                 | **Impossible.** "the pull requests below it will always merge with it".                                                                                             |
| Squash method                          | One squashed commit **per layer** — _n_ layers ⇒ _n_ commits on base.                                                                                               |
| Lower layer merges                     | Remaining branches **auto-rebase**; next PR re-targets the trunk.                                                                                                   |
| Trunk moves / lower layer gets commits | **Manual** restack required (`gh stack rebase` or the UI button).                                                                                                   |
| Mid-stack **close**                    | **Blocks everything above it.** No auto-repair — requires unstack/modify.                                                                                           |
| Merge API                              | Legacy `PUT /pulls/{n}/merge` and the `mergePullRequest` GraphQL mutation **do not work**. Must use `PUT /pulls/{n}/merge-async` + poll `GET …/merge-async/{uuid}`. |
| Auto-merge                             | **Not supported at all** — neither per-layer nor whole-stack, neither direct nor via queue. Documented as "coming soon".                                            |
| Admin / rule bypass                    | **Not supported** on stacks.                                                                                                                                        |

### 2.3 Automation surface

| Capability                             | Status                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| Create stack                           | ✅ `POST /repos/{o}/{r}/stacks` — ordered PR numbers, bottom→top                      |
| Append to top                          | ✅ `POST /stacks/{n}/add`                                                             |
| Unstack                                | ✅ `POST /stacks/{n}/unstack` (merged/queued PRs stay linked)                         |
| Read stack                             | ✅ REST `.stack` on PRs, `GET /stacks?pull_request=<n>`, GraphQL `stack`/`stackEntry` |
| **Reorder / insert / drop one**        | ❌ No API. CLI `gh stack modify` is **TUI-only**. Workaround: unstack + recreate.     |
| **GraphQL mutations**                  | ❌ None exist                                                                         |
| **Server-side "Rebase stack" via API** | ❌ UI button only; programmatic restack = local `gh stack rebase` + `push`            |
| Merge a stack                          | ✅ async merge API only                                                               |
| Webhook for joining a stack            | ✅ new `pull_request.stacked` action                                                  |

Two traps worth writing down:

- **`pull_request.opened` never carries a `stack` object.** A PR always exists before it joins a stack.
  Any listener keyed on `opened` sees `null` forever; you must subscribe to `stacked`.
- **`base_ref` is the layer below, not the trunk.** `github.event.pull_request.base.ref` is the direct
  parent branch; the real target is `github.event.pull_request.stack.base.ref`. Any workflow or gate
  assuming `base_ref == main` sees a feature-branch name for middle layers.

### 2.4 CI cost

A `pull_request` workflow targeting `main` runs for **every** layer, because triggers evaluate against
the stack base. CI cost scales with stack depth. GitHub's own mitigation is to gate expensive jobs on
`stack.position == stack.size` (top layer carries the accumulated change) and on the lowest unmerged
layer.

### 2.5 The agent angle — `gh-stack` ships a SKILL.md

`github/gh-stack` contains `skills/gh-stack/SKILL.md` plus three reference files, installable with:

```
gh skill install github/gh-stack --agent claude-code
```

`gh skill` is a new (preview) command group present in `gh` 2.91.0 — the version already on this box.
The skill is a pre-written agent playbook: mental model, setup (`rerere.enabled`,
`remote.pushDefault`), branch-placement discipline ("create the stack _before_ writing files; never
implement everything on trunk and split later"), the `view --json` schema, and the exit-code table.

**Critically, it also documents a wedge hazard we have hit before in other forms.** `gh stack`
branches on TTY detection: piped it errors cleanly, but **under a PTY it opens a full-screen TUI and
blocks forever**. herdr panes are PTYs. Bare `gh stack view`, `gh stack submit`, `gh stack switch` and
any `gh stack modify` would hang an unattended agent exactly the way upsell dialogs do. The skill's own
"Non-interactive use" section exists to prevent this and mandates `--json` / `--auto` / `--yes`
unconditionally.

### 2.6 Stated limits

Strictly linear (no branching within a stack) · same-repo only, **no cross-fork** · GitHub Desktop
unsupported · server-side rebase commits are **unsigned** (breaks required-signed-commits) · completed
stacks cannot be extended · merge-queue support still rolling out · max depth not documented (REST
create accepts up to 100 PRs) · every docs page carries "public preview and subject to change".

---

## 3. Why this lands directly on Shepherd

Three Shepherd mechanisms are, in effect, stacking workarounds.

**The one-PR invariant.** `sessions.branch` is a single nullable column and the _only_ handle Shepherd
has on a session's PR. Everything is re-derived from `forge.prStatus(branch)` — a branch-keyed
`gh pr list … --limit 1`. There is no `sessions.prNumber`, no per-session PR list, and no PR→PR edge
anywhere in the schema. The rule is stated in three advisory places (the `shepherd-pull-requests` skill,
the `SINGLE_PR_INVARIANT` prompt block, the `gh pr create` tool-guard hook) and enforced in none — as
`src/service.ts` itself says, "the data layer cannot see a second PR on another branch."

**The epic integration branch.** `epic/<#>-<slug>` is pinned in an `epic_branch` table, children are
squash-merged into it at retire, an aggregate landing PR carries it to `main`, and a `landingState`
machine plus divergence detection plus fail-closed base checks keep it honest. That is a stack,
hand-rolled, with the ordering enforced by _waiting_ instead of by _basing_.

**The critic already solves the stacked-base problem in prose.** `resolveEpicContext` hands the critic
the base delta because "this branch was never rebased onto it — so the checked-out tree is missing every
sibling that merged since the fork." With real stacks, `stack.position` and `stack.base.ref` give that
structure as data instead of narrative.

---

## 4. What breaks today, before we build anything

This is the part that is arguably urgent regardless of which proposals land.

1. **The merge train cannot merge a stacked PR.** `GithubForge.merge()`
   (`src/forge/github.ts:1619`) shells out to `gh pr merge <n> --squash --delete-branch`. GitHub
   documents that the legacy synchronous merge path does not work on stacks. `AutoMergeService` would
   burn its `MERGE_ERROR_CAP = 3` retries and hold.
2. **The Backlog "Merge" button has the same defect** — `POST /api/prs/merge` → `handlePrMerge` →
   `forge.merge`. And Shepherd _already displays_ stacked PRs: `PrRow.svelte` renders a `→{nonDefaultBase}`
   target-branch chip whose type comment literally says it "exists solely to surface non-default
   (**stacked**) PRs in the backlog PRs tab." We show them, then offer a button that fails.
3. **`isFullAuto` only excludes `epic/` bases** (`src/full-auto.ts:24`). A session based on any other
   sibling branch is still train-eligible, and nothing rebases or retargets dependents after it lands.
4. **`--admin` bypass and auto-merge are both unavailable on stacks**, so any future "just force it"
   recovery path is closed off by design.

None of this is speculative — it is the current code meeting a feature that is already enabled on our
repo.

---

## 5. What Shepherd could do with it

### 5.1 Build Queue → stack layers _(the flagship)_

The build queue is already: ordered (`position`, dense, re-derived on every full-array PUT),
id-stable, agent-authored, operator-editable, with a four-state per-step lifecycle
(`pending|active|done|skipped`) and a single approval gate. Its own prompt framing is "an ordered,
curatable, self-revising plan that you author before starting work, then execute step-by-step."

Today all of that collapses into **one PR**. The operator approves a five-step plan and then reviews a
single 2000-line diff. With stacks, each approved step becomes a layer: five PRs of ~400 lines,
reviewable in parallel, mergeable in one operation. The plan the operator already approved becomes the
review unit.

This is the same problem the critic-on-PR feature was built for — the human O(N) review ceiling — but
attacked from the other side: instead of an AI pre-reviewing one big diff, the diff arrives pre-cut
along the seams the operator already signed off on.

What is missing from the data model: no `branch`, `baseBranch`, or `prNumber` on `build_queue_steps`;
rows are keyed by `sessionId` alone. Adding those three columns is the bulk of the work.

### 5.2 Epic dependency chains as stacks

`selectEpicCandidates` gates a child on `integrationMerged || issueClosed`. A chain of three dependent
children runs strictly serially — child 2 cannot start until child 1's PR has merged into the
integration branch. With stacks, child 2 starts _immediately_ on top of child 1's branch, and the whole
chain lands bottom-up in one operation.

The DAG already exists: `EpicDraftChild.blockedBy` is an explicit list of dependency edges
(`src/types.ts:981`). The limit is linearity — a stack models one chain, not a DAG. The natural fit is
to stack the **critical path** (or each maximal chain) and leave independent siblings as today's
parallel branches off the integration branch. That is a throughput win on exactly the epics that are
slowest today.

### 5.3 Real stack awareness in the PRs tab

`listOpenPrSnapshot` already fetches `headRefName` **and** `baseRefName` for up to 200 open PRs in a
single `gh pr list`, alongside a cached `defaultBranch()`. Joining head→base yields the stack graph at
**zero additional API cost**; `GET /repos/{o}/{r}/stacks` gives it authoritatively in one more call.
Today `mapGhPrToPullRequest` throws the structure away, collapsing it to the display-only
`nonDefaultBase` string that no code branches on — and the REST fallback path
(`mapRestPullToPullRequest`) never sets even that, so the chip silently vanishes under GraphQL
rate-limiting.

Upgrading this to a real stack map — position, depth, which layer is blocking — is small, useful on its
own, and a precondition for everything else.

### 5.4 A stack-aware critic

Per-layer review is what stacks are _for_, and the critic is already per-diff-base. Two concrete gains:
review each layer against its own parent (a genuinely focused diff), and use `position == size` to know
which layer carries the accumulated change and therefore deserves the expensive whole-system pass. This
also maps onto GitHub's own CI-cost guidance, so the same predicate serves both.

### 5.5 Ship the official `gh-stack` skill to agents

`AGENT_SKILL_NAMES` is a two-entry literal and skills reach sessions via `--add-dir`. Vendoring or
installing `gh-stack`'s SKILL.md is close to free and is the enabling step for any agent-authored
stack — with the non-negotiable caveat from §2.5 that the non-interactive flags must be mandatory, or
unattended agents will wedge on the TUI.

---

## 6. Ranked recommendation

| Tier  | Item                                                                                                                                                                    | Why now                                                                                          | Size |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---- |
| **0** | Stack-safe merge path: `merge-async` + uuid polling behind `forge.merge`, and refuse-with-explanation rather than fail-with-retries when a stacked PR reaches the train | Breakage exists today on an already-enabled feature; everything else depends on it               | S–M  |
| **1** | Real stack graph in the PRs tab (stop collapsing `baseRefName`, fill the REST-fallback gap, render position/depth)                                                      | Zero extra API cost; independently useful; precondition for the rest                             | S    |
| **2** | Epic dependency chains as stacks — spawn a blocked child on its blocker's branch instead of waiting                                                                     | Converts serialization into parallelism on the slowest epics; the `blockedBy` DAG already exists | M–L  |
| **3** | Build queue steps → stack layers                                                                                                                                        | Highest leverage on review load, but wants Tiers 0–1 in place first                              | L    |
| —     | Ship `gh-stack` SKILL.md to agents, with mandatory non-interactive flags                                                                                                | Cheap, but only meaningful once something above needs agents to author stacks                    | S    |

Tier 0 is the one that plausibly deserves its own issue immediately; the rest are worth sequencing
deliberately behind it.

---

## 7. Evaluated and recommended against (for now)

**Replacing the `epic/` integration branch with a stack.** Tempting — it would delete the integration
branch, the aggregate landing PR, `landingState`, divergence detection, and the fail-closed base checks.
But: stacks are **strictly linear** and the epic model is a DAG; a **mid-stack close blocks every layer
above it**, whereas today an abandoned epic child is harmless; there is **no reorder API**, so
restructuring means unstack-and-recreate; and cross-fork is unsupported. Trading a working DAG for a
linear chain with a new wedge mode is a bad deal while the feature is in preview. Revisit if GitHub
ships reorder + mid-stack repair.

**Relying on GitHub auto-merge for stacks.** Not available, at any granularity. Worth noting that this
costs us little: `AutoMergeService` is already its own poll-and-merge loop rather than a wrapper around
GitHub auto-merge. It needs the async merge API, not the auto-merge feature.

---

## 8. Risks

- **Preview feature.** Every docs page says "subject to change". Two internal doc contradictions already
  visible (min `gh` version 2.90.0 vs 2.0; "no enablement required" vs CLI exit code 9 "not enabled for
  repository"). Anything built now should be behind a repo-level flag.
- **CI cost multiplies by stack depth.** A five-layer stack is five full CI runs, and an automatic
  restack after a partial merge re-fires CI for the whole remainder unprompted. Shepherd runs a
  self-hosted runner; this is a real capacity question, not a billing footnote.
- **TUI wedge.** See §2.5. This is the same failure class as agents wedging on Claude Code upsell
  dialogs, and it is entirely preventable with mandatory flags.
- **Unsigned server-side rebase commits** — irrelevant to us today, but it forecloses the UI rebase
  path for any repo that requires signed commits.
- **Worktree contention.** `gh stack` keeps lock-protected state in `.git/gh-stack` and force-pushes
  each branch non-atomically. Two agents sharing a worktree will collide (exit code 8). Driving stacks
  over REST avoids the lock entirely — a good reason to prefer the API over the CLI server-side.

---

## 9. Open questions

- Do we want stacks to be **agent-authored** (agent runs `gh stack`) or **server-composed** (Shepherd
  opens chained PRs and `POST /stacks` links them)? Server-composed avoids the TUI wedge, the `.git`
  lock, and the force-push, and it works for Codex sessions, which get no skills at all.
- CI budget: is 5× runs on a five-layer stack acceptable on the self-hosted runner, or do we need the
  `position == size` gating from day one?
- Does the one-PR-per-session invariant become _one stack per session_ (the honest generalization), or
  does a stack imply multiple sessions? This decides whether `reviews`/`build_queue_state`
  (`sessionId PRIMARY KEY`) need to change.

---

## Sources

- [Stacked pull requests are now in public preview — GitHub Changelog, 2026-07-30](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/)
- [About stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs) ·
  [Quickstart](https://docs.github.com/en/pull-requests/get-started/stacked-prs-quickstart) ·
  [Reference](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests)
- [Creating](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-stacked-pull-requests) ·
  [Managing](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/managing-stacked-pull-requests) ·
  [Merging](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests) ·
  [Troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-stacked-pull-requests) ·
  [Optimizing CI](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests)
- [REST: pull request stacks](https://docs.github.com/en/rest/pulls/stacks) ·
  [REST: pulls / merge-async](https://docs.github.com/en/rest/pulls/pulls) ·
  [CLI command reference](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands) ·
  [REST & GraphQL reference](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-rest-and-graphql-apis)
- [Rolling out stacked PRs to an org](https://docs.github.com/en/pull-requests/tutorials/roll-out-stacked-prs)
- [github/gh-stack](https://github.com/github/gh-stack) ·
  [skills/gh-stack/SKILL.md](https://github.com/github/gh-stack/blob/main/skills/gh-stack/SKILL.md) ·
  [gh-stack docs](https://github.github.com/gh-stack/)
- [Community discussion #201439](https://github.com/orgs/community/discussions/201439)

Shepherd source referenced: `src/forge/github.ts`, `src/forge/types.ts`, `src/full-auto.ts`,
`src/automerge.ts`, `src/automerge-core.ts`, `src/drain.ts`, `src/epic-core.ts`, `src/epic-branch.ts`,
`src/review.ts`, `src/autopilot.ts`, `src/service.ts`, `src/store.ts`, `src/types.ts`,
`src/agent-skills.ts`, `ui/src/lib/components/PrRow.svelte`.
