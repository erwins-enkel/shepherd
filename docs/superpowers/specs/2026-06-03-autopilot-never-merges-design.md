# Autopilot never performs merges

**Date:** 2026-06-03
**Status:** Design — pending implementation plan

## Problem

The self-draining work queue ("autopilot" / backlog drain, PR #300) currently
**performs merges**. When an auto-spawned session's PR is open + CI-green +
critic-approved, the decision core (`drain-core.ts` `computeNext`) returns a
`merge` decision and `DrainService.doMerge` (`drain.ts`) calls `forge.merge(...)`.
That is the only autopilot merge path — `autopilot.ts` (pre-PR steering) never
merges, and the `/api/sessions/:id/git/merge` + `/api/prs/merge` endpoints are
human-triggered.

The merge decision must be **human-owned**. Autopilot should drive work all the
way to a green, critic-approved PR and then **stop** — retire the agent, free the
slot, and leave the merge to a human.

## Goal

Autopilot drives an auto-session to a green + critic-approved PR, then:

1. **Never merges** — `forge.merge` is never invoked by the drain.
2. **Retires the agent** — stops the herdr pane, removes the worktree, archives
   the session (no idle-pane pile-up).
3. **Frees the slot and keeps draining** — the archived session no longer counts
   toward `maxAuto`, so the drain spawns the next backlog item. The whole backlog
   drains into a pile of ready-to-merge PRs awaiting human merge.
4. **Leaves a clean, mergeable PR** — discoverable in the backlog **PRs tab**;
   merging it (in shepherd or on the forge directly) **auto-closes the linked
   issue**, and a closed issue can never re-spawn.

### Non-goals

- Reviving a retired agent if CI later breaks or changes are requested after
  handoff — the human re-engages manually.
- Changing the manual merge endpoints or `autopilot.ts`.

## Approach

Replace the drain's `merge` action with a `retire` action: instead of merging a
ready PR, **archive the session** (the existing post-merge teardown, minus the
merge) and **guarantee the PR links its issue** so the eventual human merge
auto-closes it.

This is deliberately close to today's merge flow — it swaps `forge.merge` for
`archive` and adds an issue-link guarantee. Archiving already removes the session
from `autoSessions` (the cap basis), so the slot frees with no new flag, no new
session status, and no kept-alive rows.

### Why issue auto-close (not shepherd-observed close)

Today the issue is closed by `drain.onGit`'s merged branch (`closeIssue`), which
requires the pr-poller to still be watching the PR. Archiving drops the session
from the poller, so an archived-then-merged PR would never be observed → issue
leak + re-spawn after the 30-day session prune.

Instead, we make the **PR body carry `Closes #N`**. The forge auto-closes the
issue on merge with zero shepherd involvement, and a closed issue drops out of
`listIssues` so it is never re-selected as a drain candidate — killing both the
leak and the dedup problem at the source.

Shepherd currently only appends the issue to the agent's *prompt* (`service.ts`),
so whether the PR says `Closes #N` is up to the agent. We make it **guaranteed**:
at retire time, shepherd ensures the PR body contains the closing keyword before
archiving.

## Components

### 1. `src/drain-core.ts` — decision core

- Remove the `{ kind: "merge"; sessionId; prNumber }` variant from
  `DrainDecision`; add `{ kind: "retire"; sessionId; prNumber }`.
- `computeNext`: step 1 ("merge gate") becomes the **retire gate** — the first
  `mergeable()` session returns `{ kind: "retire", ... }` instead of
  `{ kind: "merge", ... }`. Priority is unchanged (completing in-flight work beats
  starting new work). All other steps (trouble → cap → usage → spawn) unchanged.
- `mergeable()` predicate is **unchanged**: open + CI green + host-mergeable +
  critic not blocking, and (critic on) a clean verdict for the current head. So
  retire still happens only on a green, *approved* PR.
- No cap/flag changes needed: archived sessions are already excluded from
  `autoSessions` in `buildState`, so retiring frees the slot automatically.

### 2. `src/drain.ts` — side-effect harness

- Replace `doMerge` → `doRetire(repoPath, decision)`:
  1. Look up the session; if it has an `issueNumber`, **best-effort** call
     `forge.ensureIssueLink(prNumber, issueNumber)` (append `Closes #N` if
     absent). On failure: `console.warn` and continue (don't block teardown).
  2. `service.archive(sessionId)` — stops the pane (`herdr.stop`), removes the
     worktree, archives the row.
  3. `dropPrCache(sessionId)` + `emitArchived(sessionId)`.
  - Do **not** call `closeIssue` here (the PR isn't merged yet; the link handles
    closing on the human merge).
- Remove the `merging` set and the per-pump `attemptedMerge` guard's merge
  semantics. Archive is synchronous, so the retired session drops out of
  `autoSessions` on the next `buildState` and can't be re-selected. Keep a small
  per-pump `attemptedRetire` set as a backstop (mirrors the old guard).
- `onGit` merged branch: **kept as-is** (still `closeIssue` + `archive` +
  `dropPrCache` + `emitArchived`). It now only fires for the race where a human
  merges a green auto-PR *before* the drain retires it (or a critic-off instant
  path). Idempotent and harmless.
- `onGit` open branch, `onArchived`, `onStatus`, `onReview`, `tick`: unchanged
  except for dropping the removed `merging.delete(...)` / `merging.has(...)`
  references.

### 3. Forge — `src/forge/types.ts`, `github.ts`, `gitea.ts`

New optional method on `GitForge`:

```ts
ensureIssueLink?(prNumber: number, issueNumber: number): Promise<void>;
```

Idempotent — appends a `Closes #N` line to the PR body only if no closing keyword
for `#issueNumber` is already present.

- **GitHub** (`github.ts`): read body via `gh pr view <n> --json body`; if it
  lacks `Closes #N` (case-insensitive, allow `Close/Closes/Closed/Fix/Fixes/
  Fixed/Resolve/Resolves/Resolved`), `gh pr edit <n> --repo <slug>
  --body "<body>\n\nCloses #<n>"`.
- **Gitea** (`gitea.ts`): `GET /repos/{slug}/pulls/{n}` for the body; if absent,
  `PATCH` with the appended body.

### 4. Persistence / status

**None.** No new column, no new `SessionStatus`. Archiving handles slot-freeing
and lifecycle exactly as the merge path did.

### 5. UI

- **No new UI.** Ready PRs surface in the existing backlog **PRs tab**
  (`PrsPanel.svelte` / `PrRow.svelte`, backed by `forge.listPullRequests()` and
  the `/api/prs/merge` action). The human merges from there or on the forge.
- Auto-sessions archive on ready, so they leave the Herd session list — matching
  today's behavior where merged auto-sessions archived out.
- **No new i18n strings.** (`ensureIssueLink` writes the literal forge keyword
  `Closes #N`, which is forge syntax, not app chrome — not translated.)

### 6. Untouched

- Manual merge endpoints `/api/sessions/:id/git/merge` and `/api/prs/merge` — the
  human's merge paths.
- `src/autopilot.ts` — pre-PR steering, never merged.
- Per-repo config (`autoDrainEnabled`, `criticEnabled`, `maxAuto`, …) — unchanged;
  `mergeMethod` still used by the manual merge endpoints.

## Data flow (happy path)

```
backlog issue (autoLabel)
  → drain spawns auto-session (issueRef in prompt)
  → agent works, opens PR
  → CI green + critic approves  ⇒  mergeable()
  → computeNext → { kind: "retire" }
  → doRetire:
       ensureIssueLink(pr, issue)   // PR body now says "Closes #N"
       service.archive(session)     // pane stopped, worktree removed, row archived
       dropPrCache + emitArchived   // slot freed
  → drain spawns next candidate (loop continues until cap/empty)
  ...
  → human merges the PR (PRs tab / shepherd UI / forge)
  → forge auto-closes the linked issue
  → closed issue drops from listIssues → never re-spawned
```

## Error handling & accepted edges

- **`ensureIssueLink` fails** (forge error): logged, retire proceeds. The issue
  won't auto-close → manual cleanup; rare.
- **Ready PR left unmerged past the session prune** (30 days / 250 newest,
  `SESSION_RETENTION_*`): the archived session is deleted, its issue mapping
  vanishes, and the still-open labeled issue can re-spawn a duplicate. Accepted as
  rare (operator is expected to clear ready PRs well within the window).
- **Human merges before retire** (race): handled by the kept `onGit` merged branch
  (closeIssue + archive). Idempotent.

## Testing

- `test/drain-core` (or equivalent): mergeable session yields `retire` (not
  `merge`); after a retired (archived) session, the slot frees and the next
  candidate spawns; trouble/cap/usage/spawn ordering preserved.
- `test/drain`: `doRetire` calls `ensureIssueLink` + `service.archive` +
  `dropPrCache` + `emitArchived`, and **never** calls `forge.merge` or
  `closeIssue`; `onGit` merged still closes the issue (pre-retire race). Remove
  all auto-merge assertions.
- Forge: `ensureIssueLink` idempotency (no double-append; appends when missing).

## Open questions

- ensureIssueLink: append `Closes #N` even if the agent already wrote a *different*
  closing ref? (Plan: only skip when a closing keyword for *this* issue is present;
  otherwise append.) OK?
- 30-day-unmerged re-spawn edge: leave as accepted, or add a cheap guard later
  (e.g. skip candidates that already have an open PR linking them)? Default: leave.
