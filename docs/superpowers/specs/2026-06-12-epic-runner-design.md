# Epic Runner — design

**Date:** 2026-06-12
**Status:** Design approved; pending implementation plan.

## Problem

SHEPHERD has no way to take an **ordered, dependency-aware list of GitHub issues** and
work through it. A product owner can express an implementation order today only as a
hand-written "tracking" issue (e.g. flowagent `#327`) whose markdown body holds a DAG,
a linear order, and a checklist of child issues — but nothing in SHEPHERD reads that
structure or enforces it. The three adjacent features each fall short:

- **Build queue** (PR #376) orders *steps within a single session/agent* — not issue-backed,
  not cross-PR. A 6-feature cluster cannot be a single session and stay reviewable.
- **Auto-drain** auto-spawns tasks from labeled issues but orders them crudely (priority
  label, then issue number ascending), spawns *in parallel* up to `maxAuto`, and has **zero**
  awareness of parent issues, sub-issues, or dependencies. It cannot enforce "issue B can't
  start until issue A merges" — which is exactly what the tracking issue's "cross-ticket
  seams" require (e.g. the shared σ helper: `#322`/`#323` must follow `#320` or the helper
  gets duplicated).
- **Backlog/Issues UI** lists issues and spawns a task from one, with no ordering, no
  sequence visualization, and no blocked/ready state.

**Goal:** point SHEPHERD at a parent issue and have it work the children **one task/PR per
issue**, **DAG-aware** (parallel roots, gated children), advancing as blocking issues close.

## Concept

An **Epic** is anchored on a parent ("tracking") issue. SHEPHERD reads its child issues +
their dependency edges, then drives each child as a normal SHEPHERD task → branch → critic
→ PR → merge. A child becomes eligible only when every issue it is blocked by has closed.

Granularity is **one task/PR per child issue** (decided): each feature is independently
reviewable, the critic/merge model is preserved, and the "sequence, don't parallelize" seams
are enforced by ordering separate PRs rather than by serializing steps inside one session.

## Source of truth (producer-agnostic: native-primary, markdown-fallback)

The Epic Runner reads whatever structure a parent issue carries, **regardless of who
authored it** (a skill, the importer below, GitHub's UI, or hand-linking). There is no
coupling to any specific issue-generation tool.

- **Native (primary).** GitHub's GA APIs, read via `gh api` (portable; not the brand-new
  `gh` native flags):
  - **Sub-issues** → child set + order **+ per-child state**: `GET repos/{o}/{r}/issues/{parent}/sub_issues`
    (returns children in stored order). The payload is a full issue object per child, so it also
    carries each child's `state` (open/closed), `labels`, and `body`. Gating derives
    `issueClosed`/`claimed`/`body` from this **per-child native signal**, which **escapes the
    200-open-issue cap** of `listIssues()` (`src/forge/github.ts:111-115`) — critical so a child
    beyond the cap is never misread as merged. Sub-issues are a strict *tree* (one parent each) —
    they give *membership, order, and per-child state*, not cross-edges.
  - **Issue dependencies** → DAG edges: `GET repos/{o}/{r}/issues/{n}/dependencies/blocked_by`
    (many-to-many). These edges *are* the cross-dependencies and subsume the markdown
    "seams" (e.g. `#323 blocked_by #320,#321,#322`). Header `X-GitHub-Api-Version: 2026-03-10`.
- **Markdown (fallback).** If a parent carries no native sub-issue links, parse its body:
  - membership from a `- [ ] #N` checklist,
  - edges from `needs #X` annotations / the DAG fence,
  - linear order from an `## Order` section.
  - **Gating caveat:** with no per-child native state, closed/claimed state must come from the
    200-capped `listIssues()`, so in a repo with >200 open issues a child beyond the cap can be
    misclassified (premature spawn). Surfaced via `openIssuesTruncated` → `Epic.warnings`, never
    silent; native links (importer) are the safe path. See Risks/Limitations.
- **Edge hygiene.** Edges are clamped to issues *within the epic*. External or cyclic edges
  are flagged and surfaced, never allowed to deadlock the runner. Only **hard** blockers gate;
  advisory "loosely needs / can start early" hints (markdown) do not.

GitHub-only: Gitea has no native sub-issue/dependency APIs, so on Gitea the runner uses the
markdown path only (documented limitation).

## Importer (SHEPHERD-native bridge)

An action on a markdown-only tracking issue: parse its structure, then create the **real
sub-issue + `blocked_by` links** on GitHub via `gh api`, idempotently (list existing first,
add only what's missing). This migrates legacy epics like `#327` and is reusable on any
hand-written tracking issue. Gotchas the implementation must honor:

- `sub_issue_id` / `issue_id` are the issue's **REST database id**, not its `#number`
  (`gh api repos/{o}/{r}/issues/{n} --jq .id`).
- `blocked_by` is added to the **dependent** issue, naming the blocker.
- Limits: ≤100 sub-issues/parent, ≤50 deps/relationship side.

(Teaching an external issue-generation skill to emit native links is out of scope for this
repo — the runner does not depend on it.)

## Execution — epic as a drain candidate-source mode (rev 2)

> **Rev 2 (post-review):** the original sibling-`EpicRunner` design co-managed drain's
> `s.auto` session pool, causing pool/cap/retire collisions. Per the plan reviewer, the epic
> is now a **mode of the existing `DrainService`**, not a parallel harness. Epic child sessions
> *are* drain's auto sessions — one pump, one pool, one `maxAuto` cap, one owner per repo.

Drain already owns per-repo session management (claim/spawn/retire/cap/trouble-pause/full-auto
merge), builds `autoSessions` from `s.status !== "archived" && s.auto` (`drain.ts:105-106`), and
builds candidates from `selectCandidates(issues, autoLabel)` only when `autoDrainEnabled`
(`drain.ts:130-131`). The epic plugs into exactly two seams:

- **Candidate source.** When a repo has a **running epic**, `buildState` sources candidates from
  the epic's dependency-gated children (`selectEpicCandidates` — open, unclaimed, every
  `blocked_by` closed, in epic order) instead of the label, and sets `enabled = true`. One drain
  source per repo at a time; a running epic takes precedence over label-drain (documented
  constraint). Parallel roots fall out for free — drain's pump loops `computeNext`→apply until a
  hold, so multiple ready roots spawn up to `maxAuto` in one pump.
- **Attended gate.** Two new `DrainRepoState` fields (`epicAttended`, `epicApprovedNext`) add one
  `HoldReason` code (`awaiting_approval`) to `computeNext`, immediately before its spawn branch:
  in attended mode the next spawn is held until the operator approves it.

Everything else is reused unchanged: retire (`drain-core.ts:173`, already `!s.fullAuto &&
readyToRetire(...)`), the `maxAuto` cap, trouble-pause, full-auto-merge advance, and the
`shepherd:active` claim label. **Advance for full-auto children rides the merge → `onGit`/
`onArchived` recompute path, never a retire** (the gate skips full-auto by design — the merge
train lands them; `readyToRetire` is a no-op for them). Non-full-auto children retire normally
and advance on human merge. Either way, when a blocking issue closes, the next pump's
`selectEpicCandidates` unblocks its dependents.

Spawned children inherit the repo's `autopilotEnabled`; hands-off advance also needs repo
`autoMergeEnabled`, else the epic parks at "in review" (a valid gate, surfaced as in-flight).

## Autonomy (per-epic, configurable)

- **`auto`** — the next dependency-ready child spawns automatically.
- **`attended`** — drain holds at `awaiting_approval` until **approve-next**.
- **`pause`** — `selectEpicCandidates` returns `[]` (no new spawns); in-flight children keep running.

## UI (embedded in Backlog)

A parent issue in the existing Backlog shows an `EPIC n/total` badge + progress. Expanding it
reveals the ordered child list with per-child state and run controls:

```
▾ #327 tracking: EFI / Value-Map   [EPIC 2/6 ⏵auto]
   ├ #320 EFI Fibonacci+σ        ✅ merged
   ├ #326 Ontology+validator     🔵 in review · PR#41
   ├ #321 strategy weight        🟢 ready
   ├ #322 effort estimator       🟢 ready (#320✓)
   ├ #325 capacity/cut-off       ⛔ blocked · #322
   └ #323 retrospective          ⛔ #321,#322
   [▶ Start epic] [auto ▾]  [Import structure]
```

Per-child state chips: `✅ merged`, `🔵 in-review +PR#`, `running`, `🟢 ready`,
`⛔ blocked · #deps`. Controls: Start/Pause, mode toggle (auto/attended), approve-next (attended
only), and **Import structure** (shown only when the parent is markdown-only). Concurrency is the
repo's existing `maxAuto` — there is no separate epic concurrency control. Uses design-system
tokens, EN+DE message keys, and one feature-catalog entry.

## Data model (sketch)

Live state derived from GitHub + sessions; SHEPHERD persists only the per-repo epic run record
(child→session mapping already exists via `session.issueNumber`).

- `EpicRun` (persisted, one per repo) = `{ repoPath, parentIssueNumber, mode: "auto"|"attended",
  status: "idle"|"running"|"paused" }`
- `Epic` (assembled, for UI/gating) = `{ repoPath, parentIssueNumber, parentTitle,
  source: "native"|"markdown", children: EpicChild[], warnings: string[], run: EpicRun }`
- `EpicChild` = `{ number, title, url, order, body (real issue body → issueRef.body on spawn),
  blockedBy: number[], state: merged|in-review|running|ready|blocked, sessionId, prNumber,
  issueClosed, claimed }`

## Components & boundaries

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `forge` sub-issue/dependency reads/writes | enumerate + create sub-issues + `blocked_by` via `gh api` | `gh`, GitHub |
| `epic-parse.ts` | parse tracking-issue body → membership/edges/order | — |
| `epic-core.ts` | pure types + `deriveChildState` + `selectEpicCandidates` (gating → `Issue[]`) | forge types |
| `epic-model.ts` (assembler) | native+markdown → `Epic` (UI) + gated candidates (drain); clamp/flag edges | forge, parser, core |
| `drain-core.ts` (mod) | `epicAttended`/`epicApprovedNext` fields + `awaiting_approval` hold | — |
| `drain.ts` (mod) | `buildState` epic branch (candidate source + `enabled`); `approveEpicNext`; emit `epic:update` | assembler, store |
| `epic-import.ts` | markdown → native sub-issue + `blocked_by` links (idempotent) | forge writes |
| server endpoints + `epic:update` | expose/control epics; broadcast changes | assembler, drain |
| Backlog epic UI | badge, child list, controls | store, api, i18n, design-system |

## Phasing (one feature, several tasks)

- **P1** Forge native reads/writes + markdown parser + `epic-core` (gating) + assembler. Pure + tested.
- **P2** `epic_run` store + drain-core attended gate + drain `buildState` epic branch + `approveEpicNext`. Tested.
- **P3** Importer (markdown → native links) + endpoint.
- **P4** Server endpoints + `epic:update` events.
- **P5** Backlog UI + i18n parity + feature-catalog entry + design-system tokens.

## Risks

- **GitHub-only** native path; Gitea falls back to markdown-only.
- Advance depends on `Closes #N` close-on-merge + repo autopilot/automerge; otherwise epics park
  at "in review" (acceptable, surfaced as in-flight).
- Cross-instance double-spawn prevented by the existing `shepherd:active` claim label.
- DAG cycles / external-to-epic deps are flagged (`Epic.warnings`) and never become candidates.
- **Precedence:** enabling an epic overrides an active label-drain on that repo (one source per
  repo); surfaced via `DrainStatus.epicParent` + a mandatory UI indicator (criterion 6), never silent.
- **`gh` rate/latency:** the pump loops up to 100×/pump, so the epic branch's O(children) `gh api`
  reads are served from a per-repo short-TTL `epicStructureCache` (same TTL as the label path's
  `issuesCache`), bounding gh calls to once per TTL.
- Spawned children carry the real issue `body` (via `EpicChild.body` → `issueRef.body`, sourced
  from the native sub-issue payload) so Notion-derived context isn't lost on spawn.
- **Markdown fallback gating-unsafe >200 open issues:** without per-child native state, closed/
  claimed derive from the 200-capped `listIssues()` → premature-spawn risk, surfaced via
  `openIssuesTruncated` → `Epic.warnings`. Native links are the safe path.
- **`epic:update` is emit-on-change** (per-repo signature of status/mode/per-child state), not
  per-pump-iteration, to avoid a UI event storm from the 100×/pump loop.

## Success criteria

1. On a **fixture repo whose parent carries native sub-issue + `blocked_by` links**, the Backlog
   shows the parent as `EPIC merged/total` and expands to children with correct
   ready/blocked/merged chips. *(For `#327`: requires a one-time backfill — add a fenced
   `epic-dag` block + run the importer, or create native links via skill/manual; its current
   free-form body is not parsed.)*
2. With epic `running`+`auto`, drain spawns the dependency-free roots (`#320`,`#326`) up to
   `maxAuto`; **no child spawns while any of its `blocked_by` issues is still open** — concretely
   `#322`/`#323` do not start until `#320`'s PR merges and issue `#320` closes.
3. `attended` mode holds at `awaiting_approval` and spawns only after `approve-next`.
4. `importEpicLinks` turns a fenced `epic-dag` body into native sub-issue + `blocked_by` links,
   idempotently (fixture-verified).
5. i18n parity passes, one feature-catalog entry added, off-token colors avoided, all tests green.
6. **Precedence is visually unmistakable (hard gate):** while an epic is `running`, the repo's
   automation/drain surface shows an "Epic mode · #N — label-drain suspended" indicator (driven by
   `DrainStatus.epicParent`) and the label-drain toggle reads overridden — verified by a component
   test (present when `epicParent` set, absent when null).

## Assumptions (recorded)

- Readiness = blocking issue *closed*.
- Concurrency = the repo's existing `maxAuto` (no separate epic budget).
- Pause makes `selectEpicCandidates` return `[]`; in-flight children keep running.
- Reads via `gh api` (REST), not the new `gh` native sub-issue/dependency flags, for portability.
