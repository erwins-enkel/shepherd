# Epic integration branches — land an epic in one piece on the default branch

## Problem

An epic is a tracking GitHub issue (e.g. #327) with native sub-issues (#320,
#322, #323, #325…) wired by `blocked_by` edges. Shepherd's Epic Runner spawns a
session per ready child, each opening its own PR. Today every spawn — epic child
or regular task — bases its worktree on the **default branch** and its PR targets
the **default branch** (`drain.ts` `doSpawn`: `const base = await forge.defaultBranch()`).

The operator's intent for epics is different: an epic should **land in one piece
on the default branch**, not trickle in as N granular PRs. When that intent was
applied to the EFI epic, an agent improvised an integration branch
`epic/efi-valuemap-327` and retargeted the child PRs at it. PR #330 then merged
into that branch — and the epic **stalled**:

- The child PR body said `Closes #320`. GitHub **only auto-closes a referenced
  issue when the PR merges into the repository's default branch.** Merged into
  `epic/efi-valuemap-327` (not default), GitHub left #320 **open**.
- Shepherd's entire epic state machine gates on **issue-closed**:
  - `epic-core.ts:48` — a child is `"merged"` **iff** `c.issueClosed`.
  - `epic-core.ts:54,60,67` — a child is `"ready"` only when every `blockedBy`
    number is in the `closed` set, and `closed` is built **solely** from
    `issueClosed` children.
  - `drain.ts:340` — the epic auto-completes only when every child reaches
    `state === "merged"` (issue closed).
- So #320 never counted as done → its dependents #322/#323/#325 stayed
  `blocked` → the epic could neither advance nor complete.

Two gaps to close:

1. **The integration-branch model is unbuilt.** Shepherd has no epic-branch
   awareness anywhere; the branch above was agent-improvised. To make
   "land in one piece" the **default for epics**, Shepherd must own the
   integration branch end-to-end.
2. **The gate keys off the wrong signal.** Once children merge into an
   integration branch they do not auto-close, so the dependency gate must key
   off **child PR merged into the integration branch**, not issue-closed.

This is the default for **epics only**. Regular (non-epic) tasks are unchanged:
branch off default, one PR → default, `Closes #N` auto-closes on merge.

## Why an integration branch is correct, not just cosmetic

The children share code seams. Epic #327 seam #1: the population-σ helper is
introduced by #320 (`src/lib/server/efi.ts`) and **reused** by #322 and #323.
Basing each child worktree on the **integration branch's latest state** means
#322 builds on #320's *merged* work instead of a stale default branch. The
dependency DAG enforces order; the integration branch carries the accumulated
result so downstream children compile against their blockers' code.

## Design overview

```
epic run → running
  └─ ensure integration branch  epic/<parent#>-<slug>  off latest default
  └─ per ready child (DAG-gated):
        spawn worktree based on integration branch
        child PR targets integration branch
        green + approved → SQUASH-merge child PR into integration branch
        → child is "integration-merged" → dependents unblock
  └─ all children integration-merged → status: landing
        open ONE PR  integration → default  (Closes every child# + parent#)
  └─ that PR merged (human / merge-train) → all issues close → status: idle (complete)
```

Statuses: `running → landing → idle`. The terminal `idle` is still driven by the
genuine completion signal (all issues closed once the final PR lands).

## Integration branch

- **Name:** `epic/<parentNumber>-<slug>`, where `<slug>` is a sanitized,
  length-bounded kebab of the parent issue title (e.g. `epic/327-efi-value-map-cluster`).
  Deterministic so it is recomputable from the parent issue across restarts.
- **Creation:** on epic run `→ running`, ensure the branch exists off the
  **latest** default branch (fetch default, create + push if absent; reuse if
  present — idempotent). Lives in a small helper alongside the worktree/forge
  layer; the forge gains a "create branch from ref / branch exists" capability if
  one isn't already available.
- **Lifecycle:** persists for the epic's duration. Cleanup (deleting the merged
  integration branch) is **out of scope** for this change — it is left after the
  final PR lands, same as any merged feature branch.

## Child spawns target the integration branch

`drain.ts` `doSpawn` becomes epic-aware:

- The spawn decision already flows from `buildState`, which knows `epicParent`
  and the built epic. Thread the epic's integration branch into the spawn
  decision so `doSpawn` can choose the base branch.
- For an **epic child of an active epic**: `baseBranch = integrationBranch`
  (fetched to latest first).
- For everything else: `baseBranch = forge.defaultBranch()` — **unchanged**.

Concurrent children that share a blocker branch off the same integration commit.
When one merges first, a lagging sibling is **behind** the integration branch;
the existing `worktree.behindBase` + AutoMergeService rebase-recovery handles
rebasing it onto the integration branch before its own merge. No new rebase
logic — point the existing logic at the integration branch for epic children.

## The done-signal change (the actual unblock)

Stop gating on issue-closed; gate on **PR merged into the integration branch**.

- `EpicChild` gains `integrationMerged: boolean`. **Source: a persisted set,
  recorded at merge time** — not a per-child PR query. Rationale: once Shepherd
  squash-merges a child PR into the integration branch, the child *issue stays
  open* and the session is archived, so there is no live PR/issue state to read
  the "done" fact back from. Shepherd owns the merge, so it records the child
  number into a persisted `epic_integrated` set (`store.ts`) at the moment of
  merge. `buildEpic` loads that set and passes it into `assembleEpic`, which sets
  `child.integrationMerged = integrated.has(child.number)`. (A human manually
  merging a child PR into the integration branch is out of the normal flow and
  won't be recorded — acceptable for this change; a forge-query reconciliation is
  a possible later refinement.)
- A child is **done-in-epic** ⇔ `integrationMerged || issueClosed`. The
  `|| issueClosed` arm preserves the legacy/default path (and the post-landing
  state, where issues finally close).
- `epic-core.ts`:
  - `deriveChildState`: return `"merged"` when `integrationMerged || issueClosed`
    (rename the `closed` param to a `done` set to match).
  - `selectEpicCandidates`: build the satisfied set from **done-in-epic**
    children, not `issueClosed` only. **This unblocks #322/#323/#325 the moment
    #320's PR squash-merges into the integration branch** — no GitHub auto-close
    needed.

## Child auto-merge into the integration branch

When a child session is green + approved (existing critic / review / signoff
gates — **unchanged**), the drain **retire path** for an epic child **squash-merges
its PR into the integration branch** instead of leaving it open:

- `drain.ts` `doRetire` branches: epic child of an active epic → merge into the
  integration branch (reuse AutoMergeService merge mechanics: behindBase gate,
  rebase recovery, squash) then archive. Non-epic retire is **unchanged** (PR
  left open for a human; `ensureIssueLink` still applied).
- One PR per sub-issue (no batching). After merge → archive → the next pump sees
  `integrationMerged` and unblocks dependents.
- Merge failure (conflict, not-green) must not abort the pump — warn and defer,
  same isolation as the current retire path; the session stays live and the next
  tick retries.

This is the one place the "autopilot never merges" invariant is relaxed — and
only for the **intra-epic** step into a **non-default** branch (not production).
The final landing onto default stays gated (below).

## Final epic → default PR + completion

- When **every** child is `integrationMerged` (in dependency order; the DAG
  guarantees the order children could even reach this state) but the issues are
  still open, Shepherd opens **one** PR `integration → default`:
  - Body aggregates `Closes #<child>` for **every** child **plus** `Closes
    #<parent>`, so a single merge closes all child issues and the parent.
  - Idempotent: if the epic PR already exists, do not open a second.
  - Epic run enters new status **`landing`**.
- Landing the final PR is **not** auto-merged — it follows the existing gate
  (human click or merge-train), per the operator's choice. Merging it (squash,
  repo default) closes all child issues + the parent.
- Completion: once all issues are closed, the existing `handleEpicSideEffects`
  check (`drain.ts`) transitions `landing → idle`. This stays the genuine
  terminal state; it now fires only after the **final** PR lands, not after the
  children integrate.

## Staging — two PRs

Coupled but separable; the reported stall is fixed by Stage A alone.

**Stage A — epic flows (this fixes the bug):**
- Integration branch ensure/create off default.
- Epic-aware base branch in `doSpawn`.
- `integrationMerged` signal in `epic-model.ts` + `epic-core.ts` done-set.
- Child squash-merge into the integration branch in `doRetire`.
- `epic_run` status: keep `running`; dependents unblock and children accumulate
  on the integration branch.

After Stage A the epic **advances and integrates** correctly, but does not yet
land on default (children sit merged on the integration branch).

**Stage B — epic lands + surfaces:**
- `landing` status in the `epic_run` enum + store.
- Final `integration → default` PR aggregation (all `Closes #N` + parent).
- `running → landing → idle` lifecycle wiring; completion fires on issues-closed.
- Epic panel UI: integration branch name, per-child "merged-into-epic" vs
  "issue-closed" distinction, and a `landing` banner with the final PR link
  (i18n EN+DE + one feature-catalog entry).

## Touch list

| Area | File | Change |
| --- | --- | --- |
| Done-signal | `src/epic-core.ts` | `deriveChildState` / `selectEpicCandidates` gate on done-in-epic (`integrationMerged \|\| issueClosed`); rename `closed`→`done` set |
| Child PR facts | `src/epic-model.ts` | populate `EpicChild.integrationMerged` from the persisted `integrated` set threaded through `AssembleInput` |
| Merge record | `src/store.ts` | `epic_integrated` table: record/list child numbers squash-merged into the integration branch |
| Child type | `src/epic-core.ts` | `EpicChild.integrationMerged: boolean`; `EpicRunStatus` += `landing` (Stage B) |
| Spawn base | `src/drain.ts` | epic child → base on integration branch; thread integration branch into the spawn decision |
| Child merge | `src/drain.ts` | `doRetire` epic child → squash-merge into integration branch (reuse AutoMergeService mechanics) |
| Final PR + lifecycle | `src/drain.ts` | open aggregated `integration→default` PR; `running→landing→idle` (Stage B) |
| Branch ensure | small helper + `src/forge/*` | create/ensure `epic/<#>-<slug>` off default; read PR base+merged; create epic PR |
| Store | `src/store.ts` / `epic_run` | persist `landing` status (Stage B) |
| UI | `ui/src/lib/components/` epic panel | integration branch, merged-into-epic vs issue-closed, landing banner + final PR link; i18n EN+DE; feature-catalog entry (Stage B) |

## Tests

- **`epic-core` (unit):** with a child `integrationMerged` (issue still open), its
  dependents become `ready` and it reads `"merged"`; legacy `issueClosed`-only
  path still works; `selectEpicCandidates` excludes done-in-epic children and
  yields the next blocked-now-unblocked child in DAG order.
- **`epic-model` (unit):** `integrationMerged` true only when PR `merged` **and**
  `baseRefName === integrationBranch`; false for a PR merged into default or
  still open.
- **`drain` (server):** epic child retire squash-merges into the integration
  branch (mocked forge) then archives; non-epic retire leaves the PR open
  (unchanged); merge failure defers without aborting the pump. Stage B: final PR
  opened once all children integration-merged, body carries every `Closes #N` +
  parent, idempotent (no second PR); `running→landing→idle` on issues-closed.
- **UI (vitest, Stage B):** epic panel shows the integration branch, the
  merged-into-epic vs issue-closed child distinction, and the landing banner +
  final PR link.

## Out of scope

- Regular (non-epic) task flow — unchanged.
- Auto-merging the final `integration → default` PR — stays human/merge-train
  gated.
- Integration branch deletion/cleanup after landing.
- Markdown-epic (non-native) dependency richness — unchanged; the done-signal
  applies to both sources, but no new parsing.
- Reusing the merge-train (AutoMergeService) as the child-merge *driver* — we
  reuse its *mechanics* (rebase/behindBase/squash) inside the epic child path,
  not its queue.
