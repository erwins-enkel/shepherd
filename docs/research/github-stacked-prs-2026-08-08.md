# What could Shepherd do with GitHub's stacked pull requests?

**Brief:** GitHub put **stacked pull requests** into public preview on **2026-07-30** and made them
**generally available on 2026-10-06**. Shepherd has
three mechanisms that exist largely _because_ GitHub had no stacking primitive — the one-session-one-PR
invariant, the `epic/<#>-<slug>` integration-branch model, and the merge train. This note establishes
what GitHub actually shipped (mechanics + automation surface), what it breaks in Shepherd **today**,
and what is worth building.

**This file is a research/reference note — not code.** Everything below was verified against
`docs.github.com`, the `github/gh-stack` repo, live `api.github.com` probes, and Shepherd's own source
on 2026-08-08. Implementation would be one or more follow-up issues; §6 ranks them.

**Status since first draft (2026-08-09).** Two things moved and are folded in below rather than left
stale:

- **Tier 0 shipped.** #2059 → PR #2061 (merged): `GithubForge.merge` now probes for stack membership
  and routes stacked merges through `merge-async` + uuid polling, behind an explicit
  `MergeInput.allowStacked` opt-in with typed refusals. §4 is kept as the rationale, marked resolved.
- **The atomicity contradiction is settled.** #2060 Step 1 → PR #2064 (merged); the spike note is on
  `main` at `docs/research/stacked-pr-partial-merge-spike-2026-08-09.md`. Result folded into §5.2.1 and §7.
  Step 2 (shape (b)) is now #2063; a defect the spike surfaced is #2062.
- **Re-assessed 2026-10-19 (#3189) — see §10.** Stacks are GA (2026-10-06), shape (b) shipped but is
  enabled on no repo, and the recommendation is now a hybrid: shape (b) stays default, shape (a)
  becomes an opt-in per-epic "incremental landing" mode.
- **§2 refreshed to the GA state (2026-10-21, #3193).** Merge queue, bypass, signed restack,
  `gh stack` 0.2.1 and the open doc contradictions (§2.7) are now in §2 itself.

---

## 1. TL;DR

- **It is fully automatable, and it is already on for us.** `GET /repos/erwins-enkel/shepherd/stacks`
  returns **200** (empty list). A `404` is how "not enabled for this repository" presents, so stacks are
  live on our repo right now. There is a first-class REST API, read-only GraphQL fields, a new
  `pull_request.stacked` webhook action, and an **official `gh-stack` SKILL.md that installs directly
  into Claude Code**.
- **There was a compat gap independent of anything we chose to build — now fixed (#2061).**
  `forge.merge()` was `gh pr merge` (method and `--delete-branch` from `MergeInput`; `--squash` in
  practice because `mergeMethod` defaults to `"squash"`), and GitHub documents that the legacy
  synchronous merge **cannot merge a stacked PR**. The merge train and the Backlog "Merge" button
  therefore failed against any stacked PR — while Shepherd already _rendered_ them (the `→base` chip),
  so the UI invited the click that broke. Now routed through `merge-async`. Still constraining at
  GA: **bypass merges only the bottom PR, never the whole stack, and stack auto-merge is not available
  yet** (the changelog says it is rolling out; the Merging page says unsupported; §2.2, §2.7).
- **Our epic model is a hand-rolled stack, and the landing PR is where it hurts.** `selectEpicCandidates`
  only spawns a child once every blocker is `integrationMerged || issueClosed`, so dependent children run
  strictly one at a time — stacks convert that _wait_ into a _base pointer_ for the edges that fall
  inside a chain, while cross-chain edges keep the gate (§5.2). More importantly, the whole
  landing-PR apparatus (`landingState`, `landingAttempts`, rebase pause reasons, repair sessions,
  stranded escalation, divergence detection) is failure handling for **one structural cause: a long-lived
  integration branch that accumulates merges while `main` moves underneath it**. Stacks remove that drift
  by construction. See §5.2.1 — this is the most interesting application in the report.
- **The flagship idea is Build Queue → stack layers.** The build queue is already an ordered,
  agent-authored, operator-editable, position-stable plan with a per-step lifecycle. It is the _shape_ of
  a stack that currently collapses into one big PR. Making approved steps into stack layers turns the
  plan the operator already approved into the review unit — which attacks the same human O(N) review
  ceiling the critic was built for.
- **Hard constraint to design around: stacks are strictly linear.** One parent, at most one child. That
  fits a dependency _chain_; it does not model the epic DAG, where `blockedBy` gives first-class fan-in
  and fan-out. Stacks therefore **augment** `selectEpicCandidates` rather than replacing it — chain
  edges become base pointers, cross-chain edges keep the existing wait-gate (§5.2, §7).

**Recommended:** ~~fix the merge-path compat gap (§6 Tier 0)~~ **done, #2061** → real stack awareness in
the PRs tab (Tier 1) → epic dependency chains as stacks (Tier 2, now #2063) → build queue as a stack
(Tier 3). **Recommended against for now:** replacing the `epic/` integration branch outright (§7) —
weakened by the atomicity spike, but not to a green light.

---

## 2. What GitHub actually shipped

**Updated 2026-10-21 to the GA state (#3193).** Stacked PRs went **generally available on 2026-10-06**
on all github.com plans (GHES: "upcoming release"); the async merge API went **GA on 2026-10-01**.
Facts below were re-checked against GitHub's docs and changelog on 2026-10-21. Where the preview
behaved differently, the August value is kept as "_August:_ …". Where GitHub's own pages disagree,
see §2.7.

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

| Behavior                               | Detail                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order                                  | Bottom-up only. Merging PR _n_ merges _n_ **and every unmerged PR below it**, atomically.                                                                                                                                                                                                                                                                                                      |
| Mid-stack in isolation                 | **Impossible.** "the pull requests below it will always merge with it".                                                                                                                                                                                                                                                                                                                        |
| Squash method                          | One squashed commit **per layer** — _n_ layers ⇒ _n_ commits on base. The merge-commit method likewise creates one merge commit per PR, not one per group (GA changelog).                                                                                                                                                                                                                      |
| Lower layer merges                     | Remaining branches **auto-rebase**; next PR re-targets the trunk.                                                                                                                                                                                                                                                                                                                              |
| Trunk moves / lower layer gets commits | **Manual** restack required (`gh stack rebase` or the UI "Rebase stack" button). Since GA the UI restack keeps approvals on unchanged code and signs its commits, per the changelog and Reference page (_August:_ unsigned). The Managing page still says unsigned (§2.7). Still UI-only (§2.3).                                                                                               |
| Mid-stack **close**                    | **Blocks everything above it.** No auto-repair — requires unstack/modify.                                                                                                                                                                                                                                                                                                                      |
| Merge API                              | **GA 2026-10-01.** Legacy `PUT /pulls/{n}/merge` and the `mergePullRequest` GraphQL mutation **do not work**. Must use `PUT /pulls/{n}/merge-async` + poll `GET …/merge-async/{uuid}`. Body takes `merge_action` (`default\|direct_merge\|merge_queue`) alongside `merge_method`/`sha`.                                                                                                        |
| Merge queue                            | **Supported since GA** (_August:_ "still rolling out"). A stack enters the queue as **one merge group**, in order; the group may exceed the configured max size by up to 50% to stay together, and a stack too large for that goes into the next group as a unit. **Ejecting a layer ejects every layer above it.** The CLI page disagrees on group atomicity (§2.7).                          |
| `merge_queue` + custom params          | **`422` at request time.** `merge_method`, `commit_title` and `commit_message` are rejected with `merge_action: merge_queue`. Worse, sending `merge_method` with **no** `merge_action` is accepted and then fails _asynchronously_ on a queue-required branch (`"Custom merge params are not supported when merging via a merge queue"`) — live-verified; ours did this until #2062 was fixed. |
| On validation failure                  | **Nothing lands** — the whole group is rejected before the base branch is touched (§5.2.1, live-verified across rule failure and merge conflict, both merge actions).                                                                                                                                                                                                                          |
| Branch cleanup                         | `merge-async` takes **no delete-branch parameter**; layer branches survive a stack merge and nothing reaps them.                                                                                                                                                                                                                                                                               |
| Auto-merge                             | **Treat as not available yet.** The GA changelog says stack auto-merge is "rolling out over the next few weeks"; the Merging page still says "Auto-merge is not supported for stacked pull requests" (§2.7). _August:_ not supported, "coming soon".                                                                                                                                           |
| Admin / rule bypass                    | **Bottom PR only.** A user with bypass permission can merge the lowest unmerged PR in a stack; the whole stack cannot be merged with bypass (Reference, GA changelog). _August:_ not supported.                                                                                                                                                                                                |
| Base branch deleted                    | GitHub re-targets the stack instead of closing its bottom PR (GA changelog), which supports stacks branched off other stacks.                                                                                                                                                                                                                                                                  |

### 2.3 Automation surface

| Capability                             | Status                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| Create stack                           | ✅ `POST /repos/{o}/{r}/stacks` — ordered PR numbers, bottom→top                      |
| Append to top                          | ✅ `POST /stacks/{n}/add`                                                             |
| Unstack                                | ✅ `POST /stacks/{n}/unstack` (merged/queued PRs stay linked)                         |
| Read stack                             | ✅ REST `.stack` on PRs, `GET /stacks?pull_request=<n>`, GraphQL `stack`/`stackEntry` |
| Compose existing PRs into a stack      | ✅ `gh stack link <PRs…>` (0.2.x) — additive, no prompts                              |
| **Reorder / insert / drop one**        | ❌ No API (unchanged at GA). `gh stack modify` is **TUI-only**. Unstack + recreate.   |
| **GraphQL mutations**                  | ❌ None — GraphQL is read-only for stacks: "there are no stack mutations"             |
| **Server-side "Rebase stack" via API** | ❌ UI button only (unchanged at GA); programmatic = `gh stack rebase` + `push`        |
| Merge a stack                          | ✅ async merge API only (GA 2026-10-01)                                               |
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
layer. Since GA the merge queue is the stronger lever: the whole stack is one `merge_group`, so
expensive jobs can run once on the merged result (§10.3).

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

**As of `gh stack` 0.2.1 (2026-10-09)** the hazard is narrower but not gone:

- `link` creates or updates a stack from existing branches or PR numbers, bottom → top, with no
  prompts. It is additive and never removes PRs.
- `merge -y`, or `merge` with no TTY, merges the whole stack (or up to a named PR) headless and
  all-or-nothing.
- `sync` with no TTY pulls clean remote-ahead changes and aborts on divergence without pushing; it
  exits 0 when it aborts, so check the result.
- Still interactive under a PTY: `modify` (always a TUI), `switch`, bare `view`, bare `submit`, bare
  `checkout`, and the `init`/`add`/`sync`/`merge` prompts. Under a PTY the flags above stay mandatory.

### 2.6 Stated limits

Strictly linear (no branching within a stack) · same-repo only, **no cross-fork** · GitHub Desktop
unsupported · fully linear history required before merging · completed stacks cannot be extended ·
max depth not documented (REST create accepts up to 100 PRs) · GHES not yet (upcoming release).

_August, now lifted:_ the preview banner ("public preview and subject to change") is gone at GA.
Merge-queue support was "still rolling out" and has now shipped (§2.2). Server-side rebase commits
were unsigned; since GA they are signed per the changelog and Reference page, though the Managing page
disagrees (§2.7).

**Undocumented, found empirically (spike §5):** a ruleset that requires a status check on **all**
branches blocks the restack force-push outright —
`GH013: Repository rule violations found for refs/heads/<layer>`. Branch _creation_ can be exempted
(`do_not_enforce_on_create`), but _updates_ cannot, and a restack is an update. Such a repo cannot
restack over `gh stack rebase` + push at all, leaving only the server-side UI button — whose commits
are unsigned. This is a ruleset shape to avoid alongside stacks, and it is not mentioned anywhere in
GitHub's docs. (Not re-tested since GA. If the GA signing claim holds, the UI-button fallback no longer
breaks required-signed-commits, but the force-push block on `gh stack rebase` + push is unaffected.)

### 2.7 Doc contradictions (as of 2026-10-21)

GitHub's pages disagree on three points. Until one is settled live, design for the conservative
reading.

| Point                 | One source says                                                                                       | The other says                                                                                | Treat as                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Stack auto-merge      | GA changelog: stacks can auto-merge once requirements are met — "rolling out over the next few weeks" | Merging page: "Auto-merge is not supported for stacked pull requests"                         | **Not available**                                                  |
| Server-side restack   | GA changelog + Reference: "Rebase stack" creates **signed** commits and keeps approvals               | Managing page: "Commits created by a server-side rebase are **not** signed"                   | **Unsigned** on repos that require signatures; verify on first use |
| Merge-group atomicity | Reference + Merging page + GA changelog: a stack enters and lands as **one merge group**              | CLI page (`gh stack merge`): queued PRs "can land in separate groups rather than all at once" | **May split**; verify on the first real queued stack               |

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

## 4. What broke before we built anything — RESOLVED by #2061

**Status:** fixed on `main`. `GithubForge.merge` now probes stack membership and routes stacked merges
through `merge-async` + uuid polling, gated on an explicit `MergeInput.allowStacked` opt-in with typed
refusals (`stacked_refused` / `merge_enqueued` / `merge_pending`). The analysis below is kept because it
is the rationale, and because items 3 and 4 are still live.

This was the part that was urgent regardless of which proposals land.

1. **The merge train cannot merge a stacked PR.** `GithubForge.merge()`
   (`src/forge/github.ts:1619-1625`) shells out to `gh pr merge <n> [--squash|--merge|--rebase]
[--delete-branch]` — both flags conditional on `MergeInput`, with `--squash` the effective default
   because `mergeMethod` defaults to `"squash"` (`src/forge/github.ts:440`). GitHub
   documents that the legacy synchronous merge path does not work on stacks. `AutoMergeService` would
   burn its `MERGE_ERROR_CAP = 3` retries and hold.
2. **The Backlog "Merge" button has the same defect** — `POST /api/prs/merge` → `handlePrMerge` →
   `forge.merge`. And Shepherd _already displays_ stacked PRs: `PrRow.svelte` renders a `→{nonDefaultBase}`
   target-branch chip whose type comment literally says it "exists solely to surface non-default
   (**stacked**) PRs in the backlog PRs tab." We show them, then offer a button that fails.
3. **`isFullAuto` only excludes `epic/` bases** (`src/full-auto.ts:25`). A session based on any other
   sibling branch is still train-eligible, and nothing rebases or retargets dependents after it lands.
4. **`--admin` bypass and auto-merge are both unavailable on stacks**, so any future "just force it"
   recovery path is closed off by design.

None of this was speculative — it was the current code meeting a feature already enabled on our repo.

**Still open after #2061:** item 3 (`isFullAuto`) is untouched. And the spike surfaced a follow-on
defect in the new path — `putMergeAsync` always sends `merge_method` and never `merge_action`, which a
queue-required branch accepts and then fails asynchronously with a message about request parameters the
operator never chose (#2062). §5.2.1's two mergeability findings also apply directly: the merge gate
must read the whole stack, not the selected PR.

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
a step's only external key is `sessionId` (the primary key itself is composite,
`PRIMARY KEY (sessionId, id)`, `src/store.ts:1425`). Adding those three columns is the bulk of the work.

### 5.2 Epic dependency chains as stacks

`selectEpicCandidates` gates a child on `integrationMerged || issueClosed`. A chain of three dependent
children runs strictly serially — child 2 cannot start until child 1's PR has merged into the
integration branch. With stacks, child 2 starts _immediately_ on top of child 1's branch, and the whole
chain lands bottom-up in one operation.

The DAG already exists: `EpicDraftChild.blockedBy` is an explicit list of dependency edges
(`src/types.ts:981`), and `Epic.noDependencyEdges` treats an epic with **zero** edges as a legibility
_warning_ (`src/epic-model.ts:176`, surfaced in `EpicPanel.svelte:149`) — so Shepherd already expects
real dependency structure to be the norm.

**A stack models one chain, and Shepherd's dependency model is a genuine DAG — so stacks augment
`selectEpicCandidates`, they do not replace it.** `blockedBy` is a per-child _list_ of blockers — the
runtime form the gate reads is `EpicChild.blockedBy: number[]` (`src/epic-core.ts:15`); the
pre-materialize draft form is `EpicDraftChild.blockedBy: string[]` (`src/types.ts:990`) — and
`assembleEpic` filters only self-loops and out-of-epic edges
(`src/epic-model.ts:135-145`). Fan-in and fan-out are both first-class: a child may have several
blockers, and several children may share one.

That matters because a chain decomposition covers **nodes**, not **edges**. Assign every child to
exactly one chain and each chain becomes a stack — but any edge that crosses chains is not represented
by a base pointer and must still be enforced by the existing gate,
`blockedBy.every(b => done.has(b))` (`src/epic-core.ts:85`). With `C.blockedBy = [A, B]`, `C` can sit
on top of at most one of `A` or `B`; the other edge stays a wait, no matter how the chains are cut.

So the precise win is narrower than "linearity costs nothing":

- **Within-chain edges** convert from _wait for the blocker to merge_ into _base on the blocker's
  branch_ — the serialization disappears.
- **Cross-chain edges** keep the `integrationMerged || issueClosed` gate exactly as today.
- A child is therefore spawnable early only when its chain predecessor is its **sole** outstanding
  blocker; if it still has an unsatisfied cross-chain blocker, the gate holds it regardless of the
  stack. The two mechanisms compose, with the gate remaining authoritative.

The payoff scales with what fraction of the edge set a good chain cut can absorb. A mostly-linear epic
(the slow ones this targets) absorbs nearly all of it; a wide fan-in epic absorbs little. Neither the
chain cut nor a maximum path cover exists in the code today — that is part of the work, not a
precondition already met.

### 5.2.1 The landing PR is where this actually pays off

The aggregate landing PR is the single most machinery-dense object in the epic model. Around it sit:
`landingState` (`pending|open|merged|error|none`), `landingAttempts` with `MAX_LANDING_ATTEMPTS = 5`,
`landingRebasePauseReason` (`cap|conflict|driver`), `landingRepairCount`/`landingRepairHead` (one
lifetime agent-repair session per landing), `landingStranded` escalation, `landingCiFailing`,
`landingRepairing`, a pre-warm draft PR, an in-flight dedup set, a per-head merge backoff, a
fail-closed `tryAutoLandEpic` with race reconciliation against the manual land endpoint, plus
`scanDivergentEpicBranches` and the `epic_base_mismatch` self-healing sweep protecting its base.

Almost all of that is **failure handling for one structural cause: drift.** The integration branch is
long-lived and accumulates children one squash-merge at a time over days while `main` moves underneath
it. Nothing rebases it — the critic is handed the base delta in prose precisely because "this branch was
never rebased onto it." The landing PR is where all that accumulated drift finally has to be
reconciled, at the very end, when the epic is nominally done. That is the worst possible moment to
discover a conflict, and the repair machinery exists because it happens.

**Stacks remove the drift by construction.** When a lower layer merges, GitHub auto-rebases the
remainder. When the trunk moves, there is an explicit restack (button or `gh stack rebase`) that
happens continuously rather than once at the end. The reconciliation cost is paid in small increments
against a live stack instead of as one lump against a months-old branch.

Two shapes are available, and they differ in what happens to the landing PR:

**(a) Stack rooted at `main` — the landing PR disappears entirely.** Children stack toward the default
branch; `gh stack merge` lands the chain. No integration branch, so no landing PR, no `landingState`, no
repair sessions, no divergence detection, no fail-closed base checks. This also fixes a real
history-quality problem: today the landing PR is squash-merged (`forge.mergeMethod` defaults to
`"squash"`), so **an entire epic collapses into one commit on `main`** — one changelog entry, one revert
unit, one bisect point for N children. Stack squash-merge produces **one commit per layer**, restoring
per-child granularity in release notes and history.

**(b) Stack rooted at the integration branch — the landing PR survives but stops being eventful.** The
docs describe the trunk as "the base branch of the bottom pull request… typically your `main` branch,
but it can be any branch, such as a release branch or a long-lived feature branch"
([reference](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests)). Rooting the
stack at `epic/<#>-<slug>` means children land into the integration branch in one bulk operation at the
end rather than trickling in, shrinking the drift window from "the whole epic" to "the gap between
stack-merge and land". The landing PR keeps its shape, its single conventional title, and its
`Closes #parent` — it just becomes a formality instead of a repair site.

**What (a) genuinely costs, and (b) preserves:**

- **The single `Closes #parent`.** `buildLandingPrBody` emits `Closes #parent` plus one `Closes #child`
  per child, so one merge closes the whole epic. Without a landing PR, each layer closes its own child
  issue but the parent needs an explicit close.
- **One conventional-commit title for release-please.** Today exactly one title has to be
  release-please-parseable: the landing PR's, because it doubles as the squash-merge **subject**
  (`src/epic-landing.ts:41-44`, #1206). `buildLandingPrTitle` normalizes the **parent** title to
  guarantee that — lowercasing a recognized type, stripping a leading `Epic:` / trailing `[EPIC]`, or
  prepending `feat:`, then appending `(epic #N)` (`src/epic-landing.ts:46-48`, `:59-69`). Child titles
  never reach it; they are only sanitized for the body's table cells (`cellSafe`,
  `src/epic-landing.ts:72`). Per-layer squash inverts that: every child title becomes a squash subject
  and therefore a changelog line — better output, but it turns one normalized title into N titles that
  must each be conventional, and nothing currently enforces that on a child PR.
- **The whole-epic review artifact.** The standalone critic sweeps a repo without `criticAllPrs` _only_
  because it has an open landing PR, and reviews exactly that PR (`isEpicIntegrationBranch(headRefName)`,
  `src/standalone-critic.ts:291`). It is the one place the assembled epic gets looked at as a whole. The
  substitute in a stack is the top layer — `position == size` carries the accumulated change — but that
  is a substitute, not the same thing.
- **The migration-awareness gate.** `migrationPaths` / `migrationsAckedAt` currently gate on the landing
  PR's diff. The gate does not disappear, but it has to move to per-layer or whole-stack detection.

**Settled (2026-08-09): no partial landing was observed, in any leg.** The docs appeared to conflict —
the merging page says the group lands "together as a single operation", the troubleshooting page says
"Merges stop at the failed pull request. Successfully merged PRs land on the base branch." The spike
(#2060 Step 1, PR #2064 merged; `docs/research/stacked-pr-partial-merge-spike-2026-08-09.md`) ran three
independent 3-layer stacks on a throwaway repo with a required check failing only on the middle layer,
plus a positive control:

| Leg | Failure class                  | `merge_action` | Outcome                                         |
| --- | ------------------------------ | -------------- | ----------------------------------------------- |
| A   | required check fails mid-stack | `direct_merge` | nothing lands, all three stay open              |
| B   | required check fails mid-stack | `merge_queue`  | nothing lands, nothing ever enters the queue    |
| C   | merge-time conflict mid-stack  | `direct_merge` | nothing lands, all three stay open              |
| D   | positive control, all green    | `direct_merge` | three squash commits, one per layer, bottom→top |

Leg C is decisive: a genuine merge-time conflict (`"Merge conflict detected"`), with a bottom layer that
was green and independently mergeable into `main`. It still did not land. Leg D confirms this section's
per-layer-commit claim directly — one squash commit per layer from a single merge call on the top PR.

**The two pages are not actually in conflict; they describe different failure classes.** GitHub
validates and stages the whole group before mutating the base branch, so everything reachable from
outside is all-or-nothing. The troubleshooting page's scenario is an error path _after_ the first
layer's ref update has committed ("an unexpected conflict or an **intermittent failure**"), which is not
forceable on demand.

So the specific fear — a rule failure stranding a half-epic on `main`, exactly what `resolveSpawnBase`
fails closed to prevent — **is disproven**. Shape (a) moves from "unsafe" to "unproven": the residual
window is undocumented, unbounded, and unfalsifiable from outside GitHub. That is a weaker objection
than before, but not a green light (§7).

Two spike findings are direct design input for whatever lands next:

- **The top layer's own state does not reveal that the stack is unmergeable.** In legs A and B the top
  PR reported `mergeable_state: clean` while a layer beneath it was `blocked`. Stack-mergeability must
  be derived from the **whole stack**, never from the selected PR.
- **A conflict against the trunk is invisible until merge time.** Leg C's middle layer reported
  `CLEAN`/`MERGEABLE` right up to the merge attempt, because layers are diffed against the layer below,
  not against the moved trunk. Any "this stack is ready" decision from per-PR mergeability is wrong
  whenever the trunk has moved.

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

| Tier     | Item                                                                                                                                                                                                    | Why now                                                                                                  | Size |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---- |
| **0** ✅ | **DONE (#2059 → PR #2061).** Stack-safe merge path: `merge-async` + uuid polling behind `forge.merge`, and refuse-with-explanation rather than fail-with-retries when a stacked PR reaches the train    | Breakage exists today on an already-enabled feature; everything else depends on it                       | S–M  |
| **1**    | Real stack graph in the PRs tab (stop collapsing `baseRefName`, fill the REST-fallback gap, render position/depth)                                                                                      | Zero extra API cost; independently useful; precondition for the rest                                     | S    |
| **2**    | **Tracked as #2063.** Epic dependency chains as stacks, rooted at the integration branch (§5.2.1 shape (b)) — base a child on its chain predecessor's branch; the wait-gate stays for cross-chain edges | Converts within-chain serialization into parallelism AND collapses the landing PR's drift-repair surface | M–L  |
| **3**    | Build queue steps → stack layers                                                                                                                                                                        | Highest leverage on review load, but wants Tiers 0–1 in place first                                      | L    |
| —        | Ship `gh-stack` SKILL.md to agents, with mandatory non-interactive flags                                                                                                                                | Cheap, but only meaningful once something above needs agents to author stacks                            | S    |

Tier 0 shipped in PR #2061; #2062 is its outstanding follow-on defect. Tier 2 is #2063, unblocked by
the atomicity spike (§5.2.1) but not dependent on it. Tiers 1 and 3 are unfiled.

_2026-10-19:_ Tier 2 shipped (#2066/#2068/#2069/#2070) behind `epicStacksEnabled`, which no repo has
turned on. Follow-up issues (#3191, #3192, #3193, aetherial#585) are in §10.8.

---

## 7. Evaluated and recommended against (for now)

> **Superseded in part by §10 (2026-10-19).** Item 5 (preview churn) is gone with GA; shape (a) is
> now recommended as an opt-in per-epic mode, not as a replacement for the integration branch.

**Retiring the `epic/` integration branch and the landing PR outright (§5.2.1 shape (a)) — not yet, but
this is a "when", not a "no".** The prize is real and large: the entire landing-repair surface deleted,
plus per-child commits on `main` instead of one squashed epic. The blockers:

1. **Linearity — a partial constraint, not a solved one.** A stack is a chain; `blockedBy` is a DAG with
   first-class fan-in and fan-out (§5.2). Chains absorb only the edges that fall inside them, so
   cross-chain edges still need `selectEpicCandidates`' `integrationMerged || issueClosed` gate. Stacks
   therefore cannot be the _whole_ ordering mechanism for an epic — the gate has to survive alongside
   them, which is a good reason not to demolish the structure that currently implements it.
2. **Partial-merge atomicity — weakened, not cleared** (§5.2.1). The specific fear, a rule or conflict
   failure stranding a half-epic on `main`, is **disproven** by the spike: nothing lands, across both
   failure classes and both merge actions. What remains is a post-commit window GitHub documents but
   offers no lever to force — undocumented in size, unbounded, unfalsifiable from outside. Shape (a) is
   now "unproven" rather than "unsafe", which is a real improvement and still not a green light.
3. **A mid-stack close blocks every layer above it**, with no auto-repair. Today an abandoned epic child
   is harmless; in a stack it wedges the chain. Shepherd abandons children often enough that this needs
   a deliberate answer, and there is **no reorder API** — repair means unstack-and-recreate.
4. **An all-branch required-check ruleset makes the CLI restack path unusable** (§2.6, `GH013`),
   leaving only the UI button and its unsigned commits. New, found empirically; not in GitHub's docs.
5. **Preview churn.** Betting the epic model on a one-week-old preview feature is premature regardless
   of how good the design is.

Shape **(b)** — stack rooted at the integration branch — is the low-risk way to get most of the drift
reduction while keeping the landing PR, the single `Closes #parent`, the conventional title, and the
whole-epic review artifact. It is the better first move, and it does not foreclose (a).

**Relying on GitHub auto-merge for stacks.** Not available, at any granularity. Worth noting that this
costs us little: `AutoMergeService` is already its own poll-and-merge loop rather than a wrapper around
GitHub auto-merge. It needs the async merge API, not the auto-merge feature.

---

## 8. Risks

- **Preview feature.** Every docs page says "subject to change". Two internal doc contradictions already
  visible (min `gh` version 2.90.0 vs 2.0; "no enablement required" vs CLI exit code 9 "not enabled for
  repository"). Anything built now should be behind a repo-level flag.
- **CI cost multiplies by stack depth — as latency, not as spend (for us).** A five-layer stack is five
  full CI runs, and an automatic restack after a partial merge re-fires CI for the whole remainder
  unprompted. Every workflow here is GitHub-hosted (`runs-on: ubuntu-latest` throughout
  `.github/workflows/`), deliberately pinned rather than toggled — `ci.yml:42-46` records why: the repo
  is public, so hosted minutes are free, and a self-hosted runner would execute fork-PR code on our
  host. So depth costs us **wall-clock and queue contention**, not money. It costs money on any private
  consumer repo Shepherd manages, which is where a depth cap or `position == size` gating earns its
  keep.
- **TUI wedge.** See §2.5. This is the same failure class as agents wedging on Claude Code upsell
  dialogs, and it is entirely preventable with mandatory flags.
- **Unsigned server-side rebase commits** — irrelevant to us today, but it forecloses the UI rebase
  path for any repo that requires signed commits. Compounding: a repo with an **all-branch** required
  check cannot use the CLI restack path either (§2.6, `GH013`), so the two together leave such a repo
  with no legal restack at all.
- **Per-PR mergeability lies about a stack.** The top layer can report `clean` while a layer beneath it
  is `blocked`, and a layer that conflicts with a moved trunk reports `CLEAN` until the merge attempt
  (§5.2.1). Any readiness gate — the Backlog Merge button, `AutoMergeService`, a future landing gate —
  must derive mergeability from the whole stack.
- **Layer branches are never reaped.** `merge-async` takes no delete-branch parameter, and
  `BranchPruner` only sweeps local `shepherd/*` branches, so a merged stack leaves its layer branches
  behind on the remote.
- **Worktree contention.** `gh stack` keeps lock-protected state in `.git/gh-stack` and force-pushes
  each branch non-atomically. Two agents sharing a worktree will collide (exit code 8). Driving stacks
  over REST avoids the lock entirely — a good reason to prefer the API over the CLI server-side.

---

## 9. Open questions

- Do we want stacks to be **agent-authored** (agent runs `gh stack`) or **server-composed** (Shepherd
  opens chained PRs and `POST /stacks` links them)? Server-composed avoids the TUI wedge, the `.git`
  lock, and the force-push, and it works for Codex sessions, which get no skills at all. _Evidence
  since:_ the atomicity spike composed all four of its stacks over `POST /stacks` and never invoked
  `gh stack`, citing the PTY wedge — the first real run of this leaned server-composed without
  friction.
- CI budget: 5× runs on a five-layer stack costs this repo **time, not minutes** — everything is
  GitHub-hosted and the repo is public (§8). So `position == size` gating is _not_ needed from day one
  for our own cost; the question is whether the added wall-clock on the critical path is acceptable,
  and separately whether a managed **private** repo needs the gating from the start, where the same
  depth is billed.
- Does the one-PR-per-session invariant become _one stack per session_ (the honest generalization), or
  does a stack imply multiple sessions? This decides whether `reviews`/`build_queue_state`
  (`sessionId PRIMARY KEY`) need to change.

---

## 10. Re-assessment 2026-10-19 — epics vs. stacks, shape (a), CI cost (#3189)

**Brief.** #3189 asks whether epics should keep landing through the integration branch and a landing
PR (shape (b), shipped via #2063) or whether GitHub stacks are now good enough for shape (a). Inputs:
GitHub's docs and changelog as of 2026-10-19, a manual stack merge in aetherial (stack #583 =
aetherial#578 → #580 → #582, `gh stack` 0.2.1), the dependency graphs of six aetherial epics, the CI
run history behind them, and the live Shepherd DB. Research only — no code, no running epic touched.
§2 (and the stale §1 lines) were refreshed to the GA state by #3193. Sections 3–9 stay as the August
record, and this section supersedes them where they disagree.

### 10.1 TL;DR

- **Recommendation: hybrid.** Keep shape (b) as the default. Add shape (a) as an **opt-in, per-epic
  "incremental landing" mode** for epics whose children are each independently shippable. Do not flip
  the default.
- **Most of what shape (a) deletes comes from dropping the integration branch, not from stacks.** On
  real aetherial epics, chains carry only 3 of 11 dependency edges (#464), and 27–57% across the
  six epics measured (§10.5). In #464, 7 of 13 children have no in-epic blocker, so under shape (a)
  they would simply be plain PRs to `main`. Stacks only help along the few real chains.
- **The aetherial stack merge worked, and it shipped an untested combination.** aetherial#579 landed on
  `main` after #578's only CI run. The stack merge landed all three layers on top of it without any
  CI on the merged result: aetherial has no required checks and no CI on `push` to `main`. Shape (a)
  makes that the normal case unless the check moves to merge time (§10.3).
- **CI: the answer is a merge queue, not position-gating alone.** Since GA, a stack enters the merge
  queue as one merge group. Run the expensive jobs on `merge_group`, and run `quality` plus
  top-of-stack e2e on `pull_request`. The org is on the Enterprise plan, so the merge queue is
  available for the private aetherial repo.
- **Shape (b) stacks have zero production mileage.** `epicStacksEnabled` is `0` for all 63 repos in the
  live DB, and `epic_stack` / `epic_stack_wedge` are empty. The August plan's "first move" is built
  but has never run.

### 10.2 What changed since August

| Item                              | August (§2, spike)                         | 2026-10-19                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                            | Public preview (2026-07-30)                | **Generally available 2026-10-06**, all github.com plans; GHES "upcoming" ([changelog](https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available/))                                                                              |
| Async merge API                   | Required for stacks; preview               | **GA 2026-10-01**, still the only API that merges a stack ([changelog](https://github.blog/changelog/2026-10-01-github-async-merge-api-generally-available/))                                                                                             |
| Atomic stack merge                | Spike: nothing lands on validation failure | Docs: "single, all-or-nothing operation" (`gh stack merge`). aetherial stack #583: three squash commits `5338881`/`c0e66c8`/`2822fd9` within 3 s, no manual rebase despite #579 landing in between                                                        |
| Merge queue                       | "Still rolling out"; spike untested        | **Shipped.** A stack enters the queue as one merge group (the group may exceed max size by 50% to stay together); ejecting a layer ejects every layer above it ([reference](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests))    |
| Server-side "Rebase stack"        | UI only, commits unsigned                  | Still **UI only — no REST/GraphQL endpoint**. GA changelog says it now keeps approvals and signs commits; the Managing page still says "not signed" (doc contradiction)                                                                                   |
| Reorder / insert / drop one layer | No API                                     | **Unchanged.** REST is list/create/get/`add`/`unstack`; GraphQL is read-only, "there are no stack mutations" ([APIs](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks))                                         |
| Auto-merge                        | Not supported                              | "Rolling out over the next few weeks" (GA changelog) vs. "not supported" (Merging page) — treat as **not available yet**                                                                                                                                  |
| Admin/bypass                      | Not supported                              | Bottom PR mergeable with bypass rules (GA changelog)                                                                                                                                                                                                      |
| Base branch deleted               | —                                          | Stack is re-targeted (GA changelog)                                                                                                                                                                                                                       |
| `gh stack`                        | v0.0.x, TUI wedge hazard                   | v0.2.1 (2026-10-09). `link` composes **existing** PRs into a stack, with no prompts. `merge -y`, or with no TTY, is headless. `sync` aborts safely without a TTY ([CLI ref](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands)) |
| Shepherd shape (b)                | Planned (#2063)                            | Shipped: #2066 chains, #2068 forge surface, #2069 stacked spawn, #2070 bottom-up retire + wedge repair; #2062 merge-queue defect fixed. Opt-in `epicStacksEnabled`, **enabled nowhere**                                                                   |

Remaining doc contradictions (auto-merge, restack signing, merge-group atomicity) are tracked in
§2.7. Verify group atomicity on the first real queued stack before relying on it.

### 10.3 Issue point 2 — CI cost per layer

**Measured (aetherial stack #583, Actions job durations incl. setup):**

| PR             | Full CI runs   | e2e min               | Job-min | Note                                                                                             |
| -------------- | -------------- | --------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| #578 (layer 1) | 1              | 16.7                  | 31.2    | Never re-run after #579 landed on `main`                                                         |
| #580 (layer 2) | 1              | 16.5                  | 32.1    |                                                                                                  |
| #582 (layer 3) | 1 (+2 aborted) | 14.9 (+4.3 wasted)    | 40.5    | Restack = `head_ref_force_pushed` + `base_ref_changed` 1 s apart → two runs, one cancelled empty |
| **Stack**      | 3              | **52.4** (4.3 wasted) | 103.8   | 10.9 job-min (10%) wasted by the restack                                                         |

The issue comment reports 15.1 / 15.0 / 13.5 min for the same e2e jobs, which is the same order of
magnitude.

For comparison, epic #464 under today's shape (b): 13 child PRs → 24 CI runs, **691 e2e min / 1451
job-min**. The landing PR aetherial#543 added 11 runs, **88 e2e min / 217 job-min** (13% on top).
Caveat: child runs before aetherial#558 (15:52Z) used three hosted shards, which inflates the early
children's numbers.

**Cost model.** Let _d_ be stack depth and _r_ the number of restacks (each trunk move the stack
must absorb, plus each push to a lower layer).

- Ungated per-layer CI ≈ `d + Σ(layers above each restack point)` full runs. A restack force-pushes
  every layer above the change, and GitHub documents that CI re-triggers ("CI checks are
  re-triggered", [Managing](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/managing-stacked-pull-requests)).
- After a **partial** stack merge, GitHub auto-rebases the remainder. The docs do not say explicitly
  that every remaining layer gets a `synchronize`, so assume it does.
- Shape (b) today costs `Σ child runs + landing-PR runs`. Shape (a) removes the landing term (13% on
  #464) and adds the restack term.

**What a workflow can see.** `github.event.pull_request.stack.{number,size,position,base.ref,base.sha}`
is in the `pull_request` payload (`null` when not stacked); no API call is needed. GitHub's own
recipe ([Optimizing CI](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests)):

```yaml
# lowest unmerged layer
if: github.event.pull_request.stack != null && github.event.pull_request.stack.base.ref == github.event.pull_request.base.ref
# top layer
if: github.event.pull_request.stack != null && github.event.pull_request.stack.position == github.event.pull_request.stack.size
```

`on.pull_request.branches: [main]` matches against the **stack base**, so such a workflow runs for every
layer. Required checks and rulesets are also evaluated against the stack base. A layer can merge only
when every layer below it passes them.

**The three options from the issue:**

| Option                                               | e2e runs per stack                      | Gap                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| e2e only where `stack == null` or `position == size` | 1 per top-layer push/restack            | Lower layers carry no e2e. Fine if they only ever land **with** the top; wrong for a bottom-up partial merge, which is exactly what Shepherd's retire gate does (`src/epic-stack.ts` → `stackRetireGate()`). A job skipped by `if:` reports success (general Actions rule; the stack docs are silent), so a required e2e check does not block lower layers |
| Draft until merge (aetherial#558)                    | 0 while draft, then **d at once**       | `gh stack merge` requires every layer to be open and non-draft. Flipping a stack to ready fires _d_ full e2e runs at the same moment, so on 3 runners a depth-4 stack waits about one extra e2e cycle. Saves cost, not latency                                                                                                                             |
| Full check only at stack merge (merge queue)         | 1 per merge group (+ retry on ejection) | Needs a merge queue on `main`, `merge_group` triggers, and **required checks** (aetherial has none: `rules/branches/main` = `[]`, no protection). Shepherd must enqueue with `merge_action=merge_queue` and without `merge_method` (#2062 fixed that path)                                                                                                 |

**The stack #583 merge shows why the third option matters.** All three layers were green and the
merge was atomic, yet the content that landed was never tested together with aetherial#579, which hit
`main` in between. No CI ran on the merged commits. Top-layer gating would not have caught this,
because the top layer was green against a trunk SHA that had already moved. Only a merge-time check
on the real merge result does. This is spike finding 4 ("a conflict against the trunk is invisible
until merge time"), observed live with a semantic rather than a textual conflict.

**Recommended CI shape for a stacked repo:**

- On `pull_request`, run cheap jobs (`quality`, PR title) on every layer.
- Run e2e on `pull_request` only when `stack == null || position == size`, as an early signal.
- Run `db` and `e2e` as **required** checks on `merge_group`.

Drafts stop being a cost lever once that is in place.

### 10.4 Issue points 1 and 3 — shape (a) re-evaluated, abandoned children

**What shape (a) deletes** (per epic in the mode):

- the landing PR and every `landing*` column on `epic_completed` (`src/store.ts`: `landingState`,
  `landingAttempts`, `landingRebase*`, `landingRepair*`, `landingRerun*`, `landingConflict*`)
- `src/landing-rebase.ts`, the pre-warm draft, `DrainService.tryAutoLandEpic()` race reconciliation
- `epic_branch` pinning plus `baseBehindSince` / `baseConflictSince`
- divergence detection and `epic_base_mismatch` for the epic branch

**The live DB says that cost is real.** 50 epics completed since 2026-08-10. Of those, **18 (36%)** had
`landingConflictReworkCount > 0`, and one needed an agent repair session. In aetherial, 2 of 12. This
is the drift cost §5.2.1 predicted, still being paid three months later.

**What shape (a) has to replace:**

| Today (shape (b))                                                                                                                                                                        | Replacement under shape (a)                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Closes #parent` in `buildLandingPrBody()` (`src/epic-landing.ts`)                                                                                                                       | Shepherd closes the parent when the last child integrates. Every child PR already carries its own `Closes #child`                                                       |
| One normalized title, `buildLandingPrTitle()`                                                                                                                                            | N child titles land as N subjects. See §10.6: already gated wherever the PR targets `main`                                                                              |
| Whole-epic critic: `src/standalone-critic.ts` reviews the open landing PR (`isEpicIntegrationBranch(headRefName)`)                                                                       | Per-child critic already runs. The whole-epic pass has no single artifact, because siblings land at different times. Accept that, or review the top layer of each chain |
| Migration gate on the landing diff (`migrationPaths` / `migrationsAckedAt`, `src/completed-epic.ts`)                                                                                     | Per child PR. Every child that touches migrations gates individually, which is stricter, not weaker                                                                     |
| Cross-chain wait gate (`selectEpicCandidates()`, `src/epic-core.ts`)                                                                                                                     | **Unchanged.** A cross-chain blocker counts as done once it is merged to `main` (issue closed). For wide epics this is the primary mechanism (§10.5)                    |
| `DrainService.resolveSpawnBase()` (`src/drain.ts`) fails closed rather than "silently base an epic child on the default branch"; `epicChildBaseOk()` (`src/epic-stack.ts`) guards retire | **Inverted by design** for epics in the mode. This is the semantic change shape (a) really means: the epic lands **incrementally** on `main`, not atomically            |

**The real question is not stacks.** Shape (a) means "this epic may be partly on `main`". The August
objection was a half-epic stranded by a failed merge. GA and the spike make that case very unlikely,
because validation is all-or-nothing. But shape (a) produces a half-epic on `main` **by design** as soon
as the first chain or standalone child merges. That is fine for epics whose children are each
shippable, and wrong for epics that ship one feature in slices. Only the operator can know which
kind an epic is, so it has to be an explicit per-epic mode, not a global switch.

**Abandoned children (issue point 3).** #2070's handling (`detectStackWedge()` → `forge.unstack()` → a
blocking `assembleEpic` warning) carries over. The repair primitive is still unstack-and-recreate, and
there is still no drop-one or reorder API. Two things change when the trunk is `main`:

- Layers **below** the hole may already be on `main`. Unstack keeps merged PRs linked, so they are
  not victims. What is left is exactly the "half-epic on `main`" state the incremental mode accepts
  anyway, so the wedge is a latency problem, not a correctness one.
- The stranded layers above the hole must be rebased onto `main` minus the lost layer's commits.
  Today they rebase onto the integration branch instead. It is the same work, and under shape (a) it
  happens against a branch that moves faster. #2070's "fail-visible, leave the branches, operator or
  repair steer" stays the right policy, and no new mechanism is needed.

### 10.5 Issue point 4 — how linear are real epics?

aetherial epics with an `epic-dag` fence (native `blocked_by` / sub-issues are empty), chain cover
computed greedily (for #464 also checked against the Dilworth minimum, which agreed):

| Epic                  | Nodes | Edges | Fan-in >1   | Fan-out >1 | Isolated | Longest path | Chains | In-chain / cross edges |
| --------------------- | ----- | ----- | ----------- | ---------- | -------- | ------------ | ------ | ---------------------- |
| #464 M4 Lückenanalyse | 13    | 11    | 2 (#462: 5) | 2          | 3        | 2            | 10     | **3 / 8**              |
| #433 M0–M3 gaps       | 16    | 7     | 2 (max 3)   | 2          | 9        | 2            | 12     | 4 / 3                  |
| #58 M4 Nachbereitung  | 12    | 8     | 0           | 2          | 2        | 3            | 8      | 4 / 4                  |
| #57 M3 Vor Ort        | 18    | 19    | 5 (max 2)   | 3          | 1        | 3            | 10     | 8 / 11                 |
| #59 M5 KI (open)      | 11    | 12    | 2           | 2          | 0        | 3            | 6      | 5 / 7                  |
| #521 Sponsoren        | 5     | 2     | 0           | 1          | 2        | 1            | 4      | 1 / 1                  |

- **Real epics are wide and shallow.** The longest path is at most three edges. #464 has 10 chains
  for 13 children: two non-trivial ones (#451 → #452 and #459 → #460 → #462), and the longer one
  ends in a five-way fan-in that a stack cannot express.
- **Stacks would replace only part of the wait gate's edges.** In-chain edges are 3/11, 4/7, 4/8,
  8/19, 5/12 and 1/2 (27–57%); cross-chain edges are the majority in three of six epics and half in
  two more. The gate in `selectEpicCandidates()` stays the primary ordering mechanism.
- **Consequence for shape (b).** The parallelism #2063 bought (spawning a child on its predecessor's
  branch) applies to one child per in-chain edge (1–8 per epic here), and only while that child's
  predecessor is still unmerged. For #464 that is 3 of 13 children.
- **Consequence for shape (a).** Most children would be unstacked PRs to `main`. The mode is "children
  land on `main` as they finish", with stacks as an optimization for the occasional chain.

### 10.6 Issue point 5 — commit history, release-please, commitlint

- **Granularity.** Stack squash gives one commit per layer. Shape (a) more generally gives one commit
  per child on `main`, so the changelog gets N lines instead of one `feat: … (epic #N)` line. That is
  the history-quality gain §5.2.1 already argued for. The cost is that a child typed `build:` /
  `ci:` / `chore:` / `test:` / `style:` is hidden by `release-please-config.json`'s
  `changelog-sections` (`refactor:` is shown, under "Code Refactoring"). An epic of
  mostly hidden types would no longer show up as one feature line. A `!` breaking marker must sit on
  the child that breaks, not on the parent.
- **Which subject lands.**
  - aetherial sets `squash_merge_commit_title = PR_TITLE`, and its `pr-title.yml` (commitlint) has no
    `branches:` filter, so it gates every layer today.
  - Shepherd sets `COMMIT_OR_PR_TITLE`. `pr-title.yml` is filtered to `branches: [main]`, which
    GitHub matches against the stack base, so it covers every layer of a stack rooted at `main` and
    every unstacked child targeting `main`. Single-commit PRs are covered by the commit-msg hook (see
    the workflow header).
  - Under shape (b) child PRs into `epic/*` are not title-gated at all. That is correct today, because
    only the landing title reaches `main`, and it becomes unnecessary under shape (a).
- **Nothing in shape (a) breaks release-please.** The one thing to keep is `buildLandingPrTitle()`'s
  guarantee that the **parent** semantics show up somewhere. Leave that to the children's own types,
  or prefix the first child's title. That is a product choice for the follow-up, not a blocker.

### 10.7 Recommendation

**Hybrid. Keep shape (b) as the default and add shape (a) as an opt-in "incremental landing" mode per
epic.**

1. **Why not stay put.** 36% of recent epics paid landing-PR conflict rework, and #464's landing PR
   cost 13% extra CI. That cost exists only because of the integration branch, and for epics whose
   children ship independently it buys nothing. GA removed the preview-churn objection (§7 item 5).
   The spike already removed the partial-merge objection for every failure reachable from outside
   GitHub (§7 item 2).
2. **Why not flip the default.** Many epics must not be half-shipped, and only the integration branch
   gives atomic landing. Auto-merge for stacks is not available yet, the restack API still does not
   exist, and the stack-mergeability gaps from spike findings 3 and 4 remain open. The #583 merge
   showed finding 4 live.
3. **Why stacks are secondary.** Real epic DAGs are wide and shallow (§10.5). Shape (a)'s value is
   "children land on `main`". Stacks only add parallelism along the rare chain. Do not build the mode
   around stacks. Treat stacks as an optional layer on top of it, reusing #2066/#2068/#2069 code.
4. **Shape (b) stacks.** These are built, unused, and low-value on this portfolio. Leave them opt-in.
   Do not invest further until a deep-chain epic actually shows up.

**What would flip this to shape (a) as the default:**

- stack auto-merge is GA in the docs (not only the changelog) and
- a merge-queue-gated repo has run a few dozen stacked merges without an ejection anomaly and
- most epics are marked "independently shippable" once the mode exists.

**What would retire shape (a):** a confirmed partial landing outside the validation phase (the
troubleshooting page's "intermittent failure" path).

### 10.8 Follow-up issues

**#3191 — `feat(epic): opt-in incremental landing mode (children → main, no landing PR)`**

- Per-epic setting (`epic_settings`) chosen at epic approval. Children base on and target the default
  branch, with no `epic/` branch, no landing PR, and no `landing*` state.
- The parent closes when the last child integrates. The migration gate runs per child PR. The
  cross-chain gate is unchanged, with "merged to `main`" as the done signal.
- `resolveSpawnBase`'s "never base an epic child on the default branch" becomes conditional on the
  mode.
- Stacks are optional, rooted at `main`, behind `epicStacksEnabled`.

**#3192 — `fix(forge): stack merge must not land a combination nobody tested`**

- Before `merge-async` on a stack outside a merge queue, refuse when the top layer's last green run
  was against a `stack.base.sha` other than the trunk's current SHA. Restack first, or route through
  `merge_action=merge_queue` when the repo requires one.
- Evidence: aetherial stack #583 vs. #579.
- This also applies to shape (b), where the trunk is the epic branch.

**aetherial#585 — `ci: stack-aware e2e and merge queue on main`**

- `quality` and PR title on every PR.
- `db`/`e2e` on `pull_request` only when `stack == null || stack.position == stack.size`.
- Enable the merge queue on `main` (Enterprise plan) and add a `merge_group` trigger.
- Make `quality` / `db` / `e2e` **required checks** (there are none today).
- Revisit the draft gate (#558) afterwards; it should become unnecessary.

**#3193 — `docs: refresh stacked-PR facts after GA`** — **done** (§2, §2.7)

- Refresh §2 of this note: GA, merge queue, signed restack, the read-only API, the doc contradictions
  in §10.2.
- Alternatively fold this into whichever implementation issue lands first.

---

## Sources

- [Stacked pull requests are now in public preview — GitHub Changelog, 2026-07-30](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/)
- [Stacked pull requests generally available — GitHub Changelog, 2026-10-06](https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available/) ·
  [Async merge API generally available — GitHub Changelog, 2026-10-01](https://github.blog/changelog/2026-10-01-github-async-merge-api-generally-available/)
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
  [REST & GraphQL reference](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-rest-and-graphql-apis) ·
  [APIs and webhooks](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks)
- [Rolling out stacked PRs to an org](https://docs.github.com/en/pull-requests/tutorials/roll-out-stacked-prs)
- [github/gh-stack](https://github.com/github/gh-stack) ·
  [skills/gh-stack/SKILL.md](https://github.com/github/gh-stack/blob/main/skills/gh-stack/SKILL.md) ·
  [gh-stack docs](https://github.github.com/gh-stack/) ·
  [gh-stack v0.2.1 release](https://github.com/github/gh-stack/releases/tag/v0.2.1)
- [Community discussion #201439](https://github.com/orgs/community/discussions/201439)

Companion note (empirical, this repo): `docs/research/stacked-pr-partial-merge-spike-2026-08-09.md` —
#2060 Step 1 / PR #2064 (merged). Source of every "live-verified" claim about merge behaviour in §2.2, §2.6,
§5.2.1 and §8.

Shepherd source referenced: `src/forge/github.ts`, `src/forge/types.ts`, `src/full-auto.ts`,
`src/automerge.ts`, `src/automerge-core.ts`, `src/drain.ts`, `src/drain-core.ts`, `src/epic-core.ts`,
`src/epic-branch.ts`, `src/epic-model.ts`, `src/epic-landing.ts`, `src/completed-epic.ts`,
`src/review.ts`, `src/standalone-critic.ts`, `src/autopilot.ts`, `src/service.ts`, `src/store.ts`,
`src/types.ts`, `src/agent-skills.ts`, `ui/src/lib/components/PrRow.svelte`,
`ui/src/lib/components/EpicPanel.svelte`.
